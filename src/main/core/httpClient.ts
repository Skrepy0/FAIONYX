/**
 * 共享 HTTP/2 客户端：undici Agent（allowH2 自动协商，服务端不支持则回退 HTTP/1.1），
 * keepAlive 连接复用。多文件并行下载时 h2 多路复用明显更稳。
 * 用法与全局 fetch 一致（httpFetch 内部带共享 dispatcher）。
 *
 * bodyTimeoutMs（可选增量参数，仅下载路径使用）：undici 的 bodyTimeout 监测「socket 层
 * 相邻两次收到响应数据的间隔」。共享 Agent 默认 30s；下载在读循环里做限速/暂停时，
 * TCP 背压会让服务端合法停发数据，低档限速（如 1KiB/s 放行一个 64KB 读块需 ~64s）
 * 会被 30s 默认值误判为死链而反复中止（表现为「下载总是被取消」），因此下载路径显式
 * 传更长的 bodyTimeoutMs，其余调用方（frp 等）行为不变。
 */
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';

/** 共享 Agent 与按 bodyTimeout 派生 Agent 的公共参数；调整时两者保持一致。 */
const AGENT_BASE_OPTIONS = {
  allowH2: true,
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 60_000,
  connections: 32,
  headersTimeout: 30_000,
};

const sharedAgent = new Agent({ ...AGENT_BASE_OPTIONS, bodyTimeout: 30_000 });

/** bodyTimeoutMs → 派生 Agent 缓存。键空间恒定（下载路径只用一个常量值），不会无限增长。 */
const bodyTimeoutAgents = new Map<number, Agent>();

// Range workers need separate TCP connections, rather than streams on one throttled H2 connection.
const rangeAgent = new Agent({ ...AGENT_BASE_OPTIONS, allowH2: false, bodyTimeout: 120_000 });

/** proxyUrl(+bodyTimeoutMs) → 派生 ProxyAgent 缓存。 */
const proxyAgents = new Map<string, ProxyAgent>();

function agentWithBodyTimeout(bodyTimeoutMs: number): Agent {
  let agent = bodyTimeoutAgents.get(bodyTimeoutMs);
  if (!agent) {
    agent = new Agent({ ...AGENT_BASE_OPTIONS, bodyTimeout: bodyTimeoutMs });
    bodyTimeoutAgents.set(bodyTimeoutMs, agent);
  }
  return agent;
}

/** 仅接受 http/https scheme；非法或空串返回 undefined，表示忽略 proxyUrl。 */
function normalizeProxyUrl(proxyUrl: string | undefined): string | undefined {
  if (!proxyUrl) return undefined;
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return proxyUrl;
  } catch {
    // ignore invalid URL
  }
  return undefined;
}

function proxyAgentFor(proxyUrl: string, bodyTimeoutMs?: number): ProxyAgent {
  const key = `${proxyUrl}|${bodyTimeoutMs ?? 'default'}`;
  let agent = proxyAgents.get(key);
  if (!agent) {
    agent = new ProxyAgent({
      uri: proxyUrl,
      ...AGENT_BASE_OPTIONS,
      bodyTimeout: bodyTimeoutMs ?? 30_000,
    });
    proxyAgents.set(key, agent);
  }
  return agent;
}

/** 与全局 fetch 同签名；signal/headers/redirect 等透传，dispatcher 固定共享 h2 Agent。
 *  bodyTimeoutMs 为可选增量参数：不传时行为与旧版完全一致。
 *  proxyUrl 为可选增量参数：合法 http/https 代理时优先走 ProxyAgent。
 */
export function httpFetch(
  url: string,
  init: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    redirect?: 'follow' | 'manual' | 'error';
    method?: string;
    body?: string;
    bodyTimeoutMs?: number;
    separateConnection?: boolean;
    systemProxy?: boolean;
    proxyUrl?: string;
  } = {}
): Promise<Response> {
  const proxyUrl = normalizeProxyUrl(init.proxyUrl);
  const { proxyUrl: _proxyUrl, ...restInit } = init;

  // Runtime downloads must use the same OS proxy/PAC and certificate store as
  // the desktop app. Node fetch/undici do not inherit macOS system proxy settings.
  // proxyUrl 存在时跳过 systemProxy，改走下面的 ProxyAgent 分支。
  if (!proxyUrl && restInit.systemProxy && process.versions.electron) {
    const { systemProxy, bodyTimeoutMs, separateConnection, ...request } = restInit;
    if (request.redirect === 'manual') {
      return import('./systemDownload').then(({ systemDownload }) => systemDownload(url, request));
    }
    return import('electron').then(({ net }) => net.fetch(url, request)) as Promise<Response>;
  }

  if (proxyUrl) {
    const { bodyTimeoutMs, systemProxy, separateConnection, ...request } = restInit;
    return undiciFetch(url, {
      ...request,
      dispatcher: proxyAgentFor(proxyUrl, bodyTimeoutMs),
    }) as unknown as Promise<Response>;
  }

  if (restInit.separateConnection) {
    const { separateConnection, bodyTimeoutMs, systemProxy, ...rest } = restInit;
    return undiciFetch(url, { ...rest, dispatcher: rangeAgent }) as unknown as Promise<Response>;
  }

  if (restInit.bodyTimeoutMs != null) {
    const { bodyTimeoutMs, separateConnection, systemProxy, ...rest } = restInit;
    return undiciFetch(url, {
      ...rest,
      dispatcher: agentWithBodyTimeout(bodyTimeoutMs),
    }) as unknown as Promise<Response>;
  }

  const { systemProxy, separateConnection, bodyTimeoutMs, ...request } = restInit;
  return undiciFetch(url, { ...request, dispatcher: sharedAgent }) as unknown as Promise<Response>;
}

/** 进程退出时关闭连接池（Electron 退出由主进程生命周期管理，这里仅防御性提供）。 */
export async function closeHttpClient(): Promise<void> {
  await Promise.all([
    sharedAgent.close(),
    rangeAgent.close(),
    ...[...bodyTimeoutAgents.values()].map((agent) => agent.close()),
    ...[...proxyAgents.values()].map((agent) => agent.close()),
  ]);
}
