import net from 'node:net'
import type { DirectEndpoint, DirectInvitation } from '../../shared/directConnect'

export function ipv4Scope(ip: string): 'public' | 'private' | 'cgnat' | 'reserved' {
  if (net.isIP(ip) !== 4) return 'reserved'
  const [a,b,c] = ip.split('.').map(Number)
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat'
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private'
  if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)) return 'reserved'
  return 'public'
}
export function isGlobalIPv6(ip: string): boolean {
  if (net.isIP(ip) !== 6) return false
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1,-1)
  const second = parseInt(normalized.split(':')[1] || '0',16)
  return /^[23]/i.test(normalized) && !/^2001:db8:/i.test(normalized) &&
    !(normalized.startsWith('2001:') && second < 0x200) && !/^2002:|^3fff:/i.test(normalized)
}
export function endpointAddress(endpoint: DirectEndpoint): string {
  return `${net.isIP(endpoint.host) === 6 ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`
}
export function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 的整数')
  return port
}
export function detectLanPort(log: string): number | undefined {
  const matches = [...log.matchAll(/(?:Started serving on|Local game hosted on port|本地游戏已在端口)\s*:?\s*(\d{1,5})/gi)]
  const port = Number(matches.at(-1)?.[1])
  return port > 0 && port <= 65535 ? port : undefined
}
export function encodeInvitation(invitation: DirectInvitation): string {
  return 'FAIONYX-DIRECT-1:' + Buffer.from(JSON.stringify(invitation)).toString('base64url')
}
export function parseInvitation(input: string, now = Date.now()): DirectInvitation {
  if (typeof input !== 'string' || input.length > 16384) throw new Error('邀请内容过大或格式无效')
  let value: DirectInvitation
  try {
    const raw = input.trim()
    value = JSON.parse(raw.startsWith('FAIONYX-DIRECT-1:') ? Buffer.from(raw.slice(16), 'base64url').toString('utf8') : raw)
  } catch { throw new Error('无法识别邀请，请粘贴完整的 FAIONYX-DIRECT-1 邀请信息') }
  if (!value || value.format !== 'FAIONYX-DIRECT' || value.version !== 1 ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 128 ||
      typeof value.minecraftVersion !== 'string' || value.minecraftVersion.length > 128 ||
      !Array.isArray(value.endpoints) || !value.endpoints.length || value.endpoints.length > 12)
    throw new Error('邀请格式或版本无效')
  const expires = Date.parse(value.expiresAt)
  if (!Number.isFinite(expires) || expires < now || expires > now + 25 * 3600000) throw new Error('邀请已过期或有效期无效，请让房主重新生成')
  if ((value.loader != null && !['forge','fabric','quilt','neoforge'].includes(value.loader)) ||
      (value.loaderVersion != null && (typeof value.loaderVersion !== 'string' || value.loaderVersion.length > 128))) throw new Error('邀请的加载器信息无效')
  const endpoints: DirectEndpoint[] = []
  for (const endpoint of value.endpoints) {
    if (!endpoint || typeof endpoint.host !== 'string') throw new Error('邀请地址无效')
    const scope = ipv4Scope(endpoint.host)
    const kind = isGlobalIPv6(endpoint.host) ? 'ipv6' : scope === 'public' ? 'ipv4' : scope === 'private' ? 'lan' : null
    if (!kind) throw new Error('邀请含有非公网或局域网单播 IP 地址')
    const host = net.isIP(endpoint.host) === 6 ? new URL(`http://[${endpoint.host}]`).hostname.slice(1,-1) : endpoint.host
    const clean = { host, port: validatePort(endpoint.port), kind } as DirectEndpoint
    if (!endpoints.some(item => endpointAddress(item) === endpointAddress(clean))) endpoints.push(clean)
  }
  return { format: 'FAIONYX-DIRECT', version: 1, name: value.name, minecraftVersion: value.minecraftVersion,
    loader: value.loader, loaderVersion: value.loaderVersion, endpoints, expiresAt: value.expiresAt }
}

export async function probeTcp(host: string, port: number, signal?: AbortSignal, timeout = 2500): Promise<boolean> {
  if (signal?.aborted) return false
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port })
    const done = (ok: boolean) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy(); resolve(ok) }
    const abort = () => done(false)
    const timer = setTimeout(abort, timeout)
    signal?.addEventListener('abort', abort, { once: true })
    socket.once('connect', () => done(true)); socket.once('error', abort)
  })
}

/** 仅在房主本机把双栈入站连接接到 Minecraft 的局域网监听端口。
 * 不改写游戏协议、认证或流量，不经过任何外部中继；pipe 提供背压。
 */
export async function createLocalForwarder(targetPort: number, listenHost = '::') {
  validatePort(targetPort)
  const sockets = new Set<net.Socket>()
  let connections = 0
  const server = net.createServer(client => {
    if (connections >= 32) { client.destroy(); return }
    connections++
    const upstream = net.createConnection({ host: '127.0.0.1', port: targetPort })
    sockets.add(client); sockets.add(upstream)
    let closed = false
    const close = () => {
      if (closed) return
      closed = true; connections--; client.destroy(); upstream.destroy()
      sockets.delete(client); sockets.delete(upstream)
    }
    client.on('error', close); upstream.on('error', close)
    client.on('close', close); upstream.on('close', close)
    client.setTimeout(120000, close); upstream.setTimeout(8000, close)
    upstream.once('connect', () => { upstream.setTimeout(120000); client.pipe(upstream); upstream.pipe(client) })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: listenHost, port: 0, ipv6Only: false }, () => { server.removeListener('error', reject); resolve() })
  })
  server.on('error', () => { for (const socket of sockets) socket.destroy() })
  return {
    port: (server.address() as net.AddressInfo).port,
    get connections() { return connections },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}
