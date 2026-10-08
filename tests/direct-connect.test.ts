import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
import {
  createLocalForwarder,
  detectLanPort,
  encodeInvitation,
  ipv4Scope,
  isGlobalIPv6,
  parseInvitation,
  probeTcp,
} from '../src/main/core/directProtocol';
import { createMapping, localRouterUrl, parseGatewayServices, soapEnvelope } from '../src/main/core/directUpnp';
import type { DirectInvitation } from '../src/shared/directConnect';

const invite = (): DirectInvitation => ({
  format: 'FAIONYX-DIRECT',
  version: 1,
  name: '好友世界',
  minecraftVersion: '1.21.1',
  endpoints: [
    { host: '2001:4860::1', port: 25565, kind: 'ipv6' },
    { host: '192.168.1.2', port: 35000, kind: 'lan' },
  ],
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});
test('直连邀请可往返，拒绝过期、伪造格式、回环地址、域名和非法端口', () => {
  const value = invite();
  assert.deepEqual(parseInvitation(encodeInvitation(value)).endpoints, value.endpoints);
  assert.throws(() => parseInvitation(encodeInvitation({ ...value, expiresAt: '2000-01-01' })), /过期/);
  for (const host of ['127.0.0.1', '169.254.1.1', '::1', 'example.com', '100.64.1.1', '224.0.0.1'])
    assert.throws(() => parseInvitation(encodeInvitation({ ...value, endpoints: [{ host, port: 25565, kind: 'ipv4' }] })));
  assert.throws(() => parseInvitation(encodeInvitation({ ...value, endpoints: [{ host: '192.168.1.2', port: 70000, kind: 'lan' }] })));
});
test('准确区分私网、公网候选和 CGNAT，不把文档 IPv6 当作可用地址', () => {
  assert.equal(ipv4Scope('100.64.0.1'), 'cgnat');
  assert.equal(ipv4Scope('100.127.255.254'), 'cgnat');
  assert.equal(ipv4Scope('192.168.1.1'), 'private');
  assert.equal(ipv4Scope('172.32.1.1'), 'public');
  assert.equal(ipv4Scope('198.51.100.1'), 'reserved');
  assert.equal(isGlobalIPv6('2001:db8::1'), false);
  assert.equal(isGlobalIPv6('fe80::1'), false);
  assert.equal(isGlobalIPv6('240e::1234'), true);
  assert.equal(detectLanPort('Started serving on 12345\nStarted serving on 54321'), 54321);
});
test('本机端口适配保留双向字节流，停止后连接和监听器均退出', async () => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  const forward = await createLocalForwarder((echo.address() as net.AddressInfo).port, '127.0.0.1');
  const client = net.createConnection({ host: '127.0.0.1', port: forward.port });
  try {
    await once(client, 'connect');
    const payload = Buffer.alloc(512 * 1024, 79);
    const received = new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      client.on('data', (data) => {
        chunks.push(data);
        size += data.length;
        if (size === payload.length) resolve(Buffer.concat(chunks));
      });
    });
    client.write(payload);
    assert.deepEqual(await received, payload);
    assert.equal(forward.connections, 1);
    const closed = once(client, 'close');
    await forward.close();
    await closed;
    assert.equal(await probeTcp('127.0.0.1', forward.port), false);
  } finally {
    client.destroy();
    await forward.close();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  }
});
test('UPnP 只接受本地设备地址，解析标准服务并拒绝外部实体与控制地址逃逸', () => {
  const xml =
    '<root><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/control?x=1&amp;y=2</controlURL></service></serviceList></root>';
  assert.equal(parseGatewayServices(xml, 'http://192.168.1.1/root.xml')[0].controlUrl, 'http://192.168.1.1/control?x=1&y=2');
  assert.throws(() => localRouterUrl('http://example.com/router'));
  assert.throws(() => localRouterUrl('http://192.168.1.2/router', '192.168.1.1'));
  assert.throws(() => parseGatewayServices('<!DOCTYPE x>' + xml, 'http://192.168.1.1/root.xml'));
  assert.match(
    soapEnvelope('urn:schemas-upnp-org:service:WANIPConnection:1', 'AddPortMapping', { NewPortMappingDescription: 'a&b' }),
    /a&amp;b/
  );
});
test('IPv6 入站可接入仅监听 IPv4 的本机世界', async () => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  const forward = await createLocalForwarder((echo.address() as net.AddressInfo).port, '::1');
  const client = net.createConnection({ host: '::1', port: forward.port });
  try {
    await once(client, 'connect');
    const reply = once(client, 'data');
    client.write('minecraft-test');
    assert.equal((await reply)[0].toString(), 'minecraft-test');
  } finally {
    client.destroy();
    await forward.close();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  }
});
test('UPnP 映射使用 300 秒租约；只移除自己创建的规则并保留已有映射', async () => {
  const gateway = {
    controlUrl: 'http://192.168.1.1/control',
    serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
    localAddress: '192.168.1.2',
    externalAddress: '8.8.8.8',
  };
  const actions: string[] = [];
  let mapping = false,
    foreign = false;
  const transport = async (_url: string, options?: { body?: string; action?: string }) => {
    const action = options?.action?.split('#')[1] ?? '';
    actions.push(action);
    if (action === 'GetSpecificPortMappingEntry' && !mapping)
      return { status: 500, localAddress: gateway.localAddress, body: '<errorCode>714</errorCode>' };
    if (action === 'GetSpecificPortMappingEntry')
      return {
        status: 200,
        localAddress: gateway.localAddress,
        body: `<NewInternalClient>192.168.1.2</NewInternalClient><NewInternalPort>34567</NewInternalPort><NewPortMappingDescription>${foreign ? 'other-app' : 'FAIONYX-test'}</NewPortMappingDescription>`,
      };
    if (action === 'AddPortMapping') {
      mapping = true;
      assert.match(options!.body!, /<NewLeaseDuration>300<\/NewLeaseDuration>/);
    }
    if (action === 'DeletePortMapping') mapping = false;
    return { status: 200, localAddress: gateway.localAddress, body: '<ok />' };
  };
  const handle = await createMapping(gateway, 34567, 'FAIONYX-test', undefined, transport);
  await assert.rejects(createMapping(gateway, 34567, 'FAIONYX-test', undefined, transport), /已存在/);
  await handle.renew();
  await handle.remove();
  assert.equal(mapping, false);
  const second = await createMapping(gateway, 34567, 'FAIONYX-test', undefined, transport);
  foreign = true;
  await second.remove();
  assert.equal(mapping, true);
  const deletes = actions.filter((action) => action === 'DeletePortMapping').length;
  assert.equal(deletes, 1);
});
