import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  DirectEndpoint,
  DirectHostRequest,
  DirectHostState,
  DirectInvitation,
  DirectJoinResult,
  DirectNetworkInfo,
  DirectOverview,
} from '../../shared/directConnect';
import { listAllInstalled } from './versions';
import { getLastLaunch } from './launch';
import { pathIdentity } from './folderPaths';
import { setActiveGameFolder } from './gameFolders';
import { supportsQuickPlayMultiplayer } from './serverUtils';
import {
  createLocalForwarder,
  detectLanPort,
  encodeInvitation,
  endpointAddress,
  ipv4Scope,
  isGlobalIPv6,
  parseInvitation,
  probeTcp,
  validatePort,
} from './directProtocol';
import { createMapping, discoverGateways, type Gateway } from './directUpnp';

let gateways: Gateway[] = [];
let scan: Promise<DirectNetworkInfo> | null = null;
let network: DirectNetworkInfo = { addresses: [], gateways: [], messages: [] };
let session: { state: DirectHostState; close: () => Promise<void>; forwarder: Awaited<ReturnType<typeof createLocalForwarder>> } | null =
  null;
let operation: Promise<DirectHostState> | null = null;
let controller: AbortController | null = null;
let lastMessages: string[] = [];

export function directState(): DirectHostState {
  return session
    ? { ...session.state, connections: session.forwarder.connections }
    : { active: false, endpoints: [], connections: 0, messages: lastMessages };
}
export async function inspectDirectNetwork(): Promise<DirectNetworkInfo> {
  if (scan) return scan;
  scan = (async () => {
    const addresses: DirectNetworkInfo['addresses'] = [];
    for (const [name, items] of Object.entries(os.networkInterfaces())) {
      for (const item of items ?? []) {
        if (item.internal) continue;
        const kind = isGlobalIPv6(item.address)
          ? 'ipv6'
          : ipv4Scope(item.address) === 'public'
            ? 'ipv4'
            : ipv4Scope(item.address) === 'private'
              ? 'lan'
              : null;
        if (kind && !addresses.some((existing) => existing.address === item.address)) addresses.push({ name, address: item.address, kind });
      }
    }
    gateways = await discoverGateways();
    const messages = ['公网可达性需要好友从另一网络验证；本机检测无法确认运营商及防火墙是否放行。'];
    if (!addresses.some((item) => item.kind === 'ipv6')) messages.push('未发现公网 IPv6 地址。');
    if (!gateways.length)
      messages.push('未发现可用 UPnP 网关：路由器可能未开启 UPnP，或当前网络不支持。可使用公网 IPv6 / 手动 IPv4 端口映射。');
    network = {
      addresses,
      messages,
      gateways: gateways.map((gateway) => {
        const scope = ipv4Scope(gateway.externalAddress);
        return {
          address: new URL(gateway.controlUrl).hostname,
          externalAddress: gateway.externalAddress,
          diagnosis:
            scope === 'cgnat'
              ? '网关 WAN 地址属于 CGNAT（100.64.0.0/10），UPnP 无法穿过运营商 NAT。'
              : scope === 'private'
                ? '网关 WAN 仍是私网地址，存在上级 NAT；仅映射本层路由器不能保证公网可达。'
                : scope === 'public'
                  ? '发现公网 IPv4；开启房间时可尝试 UPnP 映射。'
                  : '网关未提供可用的公网 IPv4。',
        };
      }),
    };
    return network;
  })().finally(() => {
    scan = null;
  });
  return scan;
}

async function latestLanPort(): Promise<number | undefined> {
  const launch = getLastLaunch();
  if (!launch?.effectiveGameDir || launch.endedAt) return undefined;
  const file = path.join(launch.effectiveGameDir, 'logs', 'latest.log');
  try {
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
      return detectLanPort(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
export async function directOverview(): Promise<DirectOverview> {
  const [netInfo, port] = await Promise.all([inspectDirectNetwork(), latestLanPort()]);
  return { network: netInfo, instances: listAllInstalled(), state: directState(), detectedPort: port };
}

export function startDirectHost(request: DirectHostRequest): Promise<DirectHostState> {
  if (session || operation) return Promise.reject(new Error('已有房间或正在创建房间，请先停止'));
  controller = new AbortController();
  const signal = controller.signal;
  operation = (async () => {
    const version = listAllInstalled().find(
      (item) => item.id === request.versionId && pathIdentity(item.folder) === pathIdentity(request.folder)
    );
    if (!version || version.incomplete) throw new Error('所选实例不存在或不完整');
    const detected = await latestLanPort();
    const port = validatePort(request.port ?? detected ?? 0);
    if (!(await probeTcp('127.0.0.1', port, signal)))
      throw new Error('本机世界端口未开放。请在游戏内选择“对局域网开放”，然后刷新端口或手动输入。');
    signal.throwIfAborted();
    await inspectDirectNetwork();
    signal.throwIfAborted();
    let forwarder: Awaited<ReturnType<typeof createLocalForwarder>>;
    let ipv6Available = true;
    try {
      forwarder = await createLocalForwarder(port);
    } catch (error) {
      if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      ipv6Available = false;
      forwarder = await createLocalForwarder(port, '0.0.0.0');
    }
    const mappings: Array<Awaited<ReturnType<typeof createMapping>>> = [];
    let timer: NodeJS.Timeout | undefined;
    let closing: Promise<void> | null = null;
    const close = (): Promise<void> => {
      if (closing) return closing;
      clearInterval(timer);
      closing = Promise.allSettled([forwarder.close(), ...mappings.map((mapping) => mapping.remove())]).then(() => undefined);
      return closing;
    };
    try {
      const endpoints: DirectEndpoint[] = network.addresses
        .filter((item) => item.kind !== 'ipv6' || ipv6Available)
        .slice(0, 10)
        .map((item) => ({ host: item.address, port: forwarder.port, kind: item.kind }));
      const messages = [
        ...network.messages,
        ...network.gateways.filter((item) => /CGNAT|上级 NAT/.test(item.diagnosis)).map((item) => item.diagnosis),
      ];
      const owner = `FAIONYX-${crypto.randomUUID().slice(0, 12)}`;
      if (request.useUpnp) {
        for (const gateway of gateways.filter((item) => ipv4Scope(item.externalAddress) === 'public').slice(0, 2)) {
          signal.throwIfAborted();
          try {
            const mapping = await createMapping(gateway, forwarder.port, owner, signal);
            mappings.push(mapping);
            endpoints.push({ host: gateway.externalAddress, port: forwarder.port, kind: 'ipv4' });
            messages.push('UPnP 临时映射已建立（5 分钟租约，房间开启期间自动续租）。');
          } catch (error) {
            messages.push(String((error as Error).message));
          }
        }
      }
      if (request.publicAddress?.trim()) {
        const address = request.publicAddress.trim();
        if (ipv4Scope(address) !== 'public') throw new Error('手动公网 IPv4 地址格式无效');
        endpoints.push({ host: address, port: forwarder.port, kind: 'ipv4' });
        messages.push(`手动 IPv4：请将路由器 TCP ${forwarder.port} 映射到本机同端口，未验证此规则是否存在。`);
      }
      signal.throwIfAborted();
      const unique = endpoints
        .filter((item, index) => endpoints.findIndex((other) => endpointAddress(other) === endpointAddress(item)) === index)
        .slice(0, 12);
      if (!unique.some((item) => item.kind !== 'lan'))
        messages.push('当前仅可供同一局域网加入，尚无公网房主路径。CGNAT、手机热点、校园网可能限制入站连接；你仍可以加入可达好友的世界。');
      messages.push('开启房间后需保持 FAIONYX 和游戏运行；退出或关闭局域网世界会断开直连。');
      const invitation: DirectInvitation = {
        format: 'FAIONYX-DIRECT',
        version: 1,
        name: version.id,
        minecraftVersion: version.mcVersion,
        loader: version.loader,
        loaderVersion: version.loaderVersion,
        endpoints: unique,
        expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
      };
      const state: DirectHostState = {
        active: true,
        connections: 0,
        endpoints: unique,
        invite: unique.length ? encodeInvitation(invitation) : undefined,
        localPort: port,
        exposedPort: forwarder.port,
        messages,
        startedAt: new Date().toISOString(),
      };
      session = { state, close, forwarder };
      let checking = false,
        renewedAt = Date.now();
      timer = setInterval(async () => {
        if (checking || closing) return;
        checking = true;
        try {
          if (!(await probeTcp('127.0.0.1', port))) {
            lastMessages = ['本机世界已关闭，房间和端口映射已停止。'];
            await stopDirectHost();
            return;
          }
          if (Date.now() - renewedAt >= 120000) {
            renewedAt = Date.now();
            for (const mapping of mappings) {
              try {
                await mapping.renew();
              } catch (error) {
                if (!state.messages.includes(String(error)))
                  state.messages.push(`UPnP 续租失败：${String(error)}，IPv4 邀请可能不可达，请重新开启房间。`);
              }
            }
          }
        } finally {
          checking = false;
        }
      }, 15000);
      timer.unref();
      return directState();
    } catch (error) {
      await close();
      throw error;
    }
  })().finally(() => {
    operation = null;
    controller = null;
  });
  return operation;
}

export async function stopDirectHost(): Promise<DirectHostState> {
  controller?.abort(new Error('房间创建已取消'));
  await operation?.catch(() => undefined);
  const previous = session;
  session = null;
  if (previous) await previous.close();
  return directState();
}

export async function resolveDirectInvitation(input: string): Promise<DirectJoinResult> {
  const invitation = parseInvitation(input);
  const ordered = [...invitation.endpoints].sort(
    (a, b) => ['ipv6', 'ipv4', 'lan'].indexOf(a.kind) - ['ipv6', 'ipv4', 'lan'].indexOf(b.kind)
  );
  const replies = await Promise.all(ordered.map(async (endpoint) => ({ endpoint, online: await probeTcp(endpoint.host, endpoint.port) })));
  return {
    invitation,
    endpoint: replies.find((reply) => reply.online)?.endpoint,
    failures: replies.filter((reply) => !reply.online).map((reply) => `${endpointAddress(reply.endpoint)}：连接超时或被拒绝`),
  };
}

export async function prepareDirectJoin(input: string, versionId: string, folder: string) {
  const result = await resolveDirectInvitation(input);
  if (!result.endpoint) throw new Error('没有可达的好友地址。请检查房主是否在线、双方 IPv6、路由器映射及入站防火墙。');
  const version = listAllInstalled().find((item) => item.id === versionId && pathIdentity(item.folder) === pathIdentity(folder));
  if (!version || version.incomplete) throw new Error('关联实例不存在或未完整安装，请先下载兼容版本');
  const invite = result.invitation;
  if (
    version.mcVersion !== invite.minecraftVersion ||
    (version.loader ?? '') !== (invite.loader ?? '') ||
    (invite.loaderVersion && version.loaderVersion !== invite.loaderVersion)
  )
    throw new Error('所选实例与房主的 Minecraft / Loader 版本不匹配，请选择兼容实例；MOD 列表还需双方自行确认一致。');
  setActiveGameFolder(folder);
  return { versionId, folder, address: endpointAddress(result.endpoint), directJoin: supportsQuickPlayMultiplayer(version.mcVersion) };
}
