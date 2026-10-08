import dgram from 'node:dgram';
import http from 'node:http';
import os from 'node:os';
import { ipv4Scope } from './directProtocol';

const MAX_XML = 512 * 1024;
const servicePattern = /^urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:[12]$/;
export interface Gateway {
  controlUrl: string;
  serviceType: string;
  localAddress: string;
  externalAddress: string;
}
export interface LocalReply {
  body: string;
  localAddress: string;
  status: number;
}
type Transport = (url: string, options?: { body?: string; action?: string; signal?: AbortSignal }) => Promise<LocalReply>;
class UpnpError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function localRouterUrl(input: string, expectedHost?: string): URL {
  const url = new URL(input);
  if (
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    url.hash ||
    ipv4Scope(url.hostname) !== 'private' ||
    (expectedHost && url.hostname !== expectedHost)
  )
    throw new Error('路由器地址必须来自同一本地网络设备');
  return url;
}
const escapeXml = (value: unknown) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const decodeXml = (value: string) =>
  value.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, name: string) => (({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }) as Record<string, string>)[name]
  );
export function xmlValue(xml: string, tag: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('不支持含外部实体的路由器响应');
  return decodeXml(
    new RegExp(`<(?:(?:[\\w-]+):)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:[\\w-]+):)?${tag}>`, 'i').exec(xml)?.[1]?.trim() ?? ''
  );
}
export function parseGatewayServices(xml: string, location: string): Array<Pick<Gateway, 'controlUrl' | 'serviceType'>> {
  const base = localRouterUrl(location);
  if (xml.length > MAX_XML || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('路由器描述无效');
  const urlBase = xmlValue(xml, 'URLBase');
  const root = urlBase ? localRouterUrl(urlBase, base.hostname) : base;
  return [...xml.matchAll(/<(?:[\w-]+:)?service\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?service>/gi)].flatMap((match) => {
    const serviceType = xmlValue(match[1], 'serviceType');
    if (!servicePattern.test(serviceType)) return [];
    const controlUrl = localRouterUrl(new URL(xmlValue(match[1], 'controlURL'), root).toString(), base.hostname).toString();
    return [{ serviceType, controlUrl }];
  });
}

/** HTTP 仅允许 SSDP 回报的私网 IP；无代理、无 DNS、无外部重定向。 */
export const localRequest: Transport = (input, options = {}) => {
  const url = localRouterUrl(input);
  return new Promise((resolve, reject) => {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
    const req = http.request(
      url,
      {
        method: options.body ? 'POST' : 'GET',
        signal,
        headers: options.body
          ? {
              'Content-Type': 'text/xml; charset="utf-8"',
              SOAPAction: `"${options.action}"`,
              'Content-Length': Buffer.byteLength(options.body),
            }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const localAddress = req.socket?.localAddress ?? '';
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_XML) res.destroy(new Error('路由器响应过大'));
          else chunks.push(chunk);
        });
        res.once('error', reject);
        res.once('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), status: res.statusCode ?? 500, localAddress }));
      }
    );
    req.once('error', reject);
    req.end(options.body);
  });
};

export function soapEnvelope(serviceType: string, action: string, values: Record<string, unknown>): string {
  if (!servicePattern.test(serviceType) || !/^[A-Za-z]+$/.test(action)) throw new Error('无效 UPnP 请求');
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${serviceType}">${Object.entries(
    values
  )
    .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
    .join('')}</u:${action}></s:Body></s:Envelope>`;
}
export async function gatewayAction(
  gateway: Gateway,
  action: string,
  values: Record<string, unknown>,
  signal?: AbortSignal,
  transport: Transport = localRequest
): Promise<string> {
  const reply = await transport(gateway.controlUrl, {
    body: soapEnvelope(gateway.serviceType, action, values),
    action: `${gateway.serviceType}#${action}`,
    signal,
  });
  const error = xmlValue(reply.body, 'errorCode');
  if (error || reply.status !== 200)
    throw new UpnpError(
      error || String(reply.status),
      `UPnP ${action} 失败（${error || reply.status}）：${xmlValue(reply.body, 'errorDescription') || '路由器未接受请求'}`
    );
  return reply.body;
}

async function discoverLocations(signal?: AbortSignal): Promise<string[]> {
  const interfaces = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && !item.internal && item.family === 'IPv4' && ipv4Scope(item.address) === 'private')
    .slice(0, 8);
  const locations = new Set<string>();
  await Promise.all(
    interfaces.map(
      (item) =>
        new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          const socket = dgram.createSocket('udp4');
          let finished = false;
          const done = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            try {
              socket.close();
            } catch {
              /* 尚未绑定 */
            }
            resolve();
          };
          const timer = setTimeout(done, 2200);
          signal?.addEventListener('abort', done, { once: true });
          socket.on('error', done);
          socket.on('message', (buffer, sender) => {
            if (buffer.length > 16384 || locations.size >= 12) return;
            const location = /^location:\s*(.+)$/im.exec(buffer.toString())?.[1]?.trim();
            try {
              if (location) locations.add(localRouterUrl(location, sender.address).toString());
            } catch {
              /* 忽略非本地广告 */
            }
          });
          socket.bind(0, item!.address, () => {
            if (finished) return;
            try {
              socket.setMulticastTTL(2);
              socket.setMulticastInterface(item!.address);
              for (const target of [
                'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
                'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
              ]) {
                const msg = Buffer.from(
                  `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${target}\r\n\r\n`
                );
                socket.send(msg, 1900, '239.255.255.250', (error) => {
                  if (error) done();
                });
              }
            } catch {
              done();
            }
          });
        })
    )
  );
  return [...locations];
}
export async function discoverGateways(signal?: AbortSignal): Promise<Gateway[]> {
  const locations = await discoverLocations(signal);
  const results = await Promise.allSettled(
    locations.map(async (location) => {
      const reply = await localRequest(location, { signal });
      if (reply.status !== 200) return [];
      const found: Gateway[] = [];
      for (const service of parseGatewayServices(reply.body, location)) {
        const gateway = { ...service, localAddress: reply.localAddress, externalAddress: '' };
        try {
          const result = await gatewayAction(gateway, 'GetExternalIPAddress', {}, signal);
          gateway.externalAddress = xmlValue(result, 'NewExternalIPAddress');
          found.push(gateway);
        } catch {
          /* 下一个 WAN 服务 */
        }
      }
      return found;
    })
  );
  const all = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  return all.filter((gateway, index) => all.findIndex((item) => item.controlUrl === gateway.controlUrl) === index);
}

/** 使用短租约，决不覆盖现存规则；删除前再次核对归属。 */
export async function createMapping(
  gateway: Gateway,
  port: number,
  description: string,
  signal?: AbortSignal,
  transport: Transport = localRequest
) {
  const key = { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP' };
  try {
    await gatewayAction(gateway, 'GetSpecificPortMappingEntry', key, signal, transport);
    throw new Error('该端口已存在路由器映射，请重新开启房间以使用其他端口');
  } catch (error) {
    if (!(error instanceof UpnpError) || error.code !== '714') throw error;
  }
  const values = {
    ...key,
    NewInternalPort: port,
    NewInternalClient: gateway.localAddress,
    NewEnabled: 1,
    NewPortMappingDescription: description,
    NewLeaseDuration: 300,
  };
  await gatewayAction(gateway, 'AddPortMapping', values, signal, transport);
  const owned = async () => {
    const data = await gatewayAction(gateway, 'GetSpecificPortMappingEntry', key, undefined, transport);
    return (
      xmlValue(data, 'NewInternalClient') === gateway.localAddress &&
      xmlValue(data, 'NewInternalPort') === String(port) &&
      xmlValue(data, 'NewPortMappingDescription') === description
    );
  };
  let active = true;
  let pending = Promise.resolve();
  return {
    renew: () => {
      const next = pending.then(async () => {
        if (!active) return;
        if (!(await owned())) throw new Error('UPnP 映射归属已改变');
        if (active) await gatewayAction(gateway, 'AddPortMapping', values, undefined, transport);
      });
      pending = next.catch(() => undefined);
      return next;
    },
    remove: () => {
      active = false;
      return pending.then(async () => {
        if (await owned()) await gatewayAction(gateway, 'DeletePortMapping', key, undefined, transport);
      });
    },
  };
}
