import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { YggdrasilProvider, YggdrasilProviderInput } from '../../shared/types'

export interface ParsedProviderDescriptor {
  sourceLabel: string
  name?: string
  apiRoot: string
  authServer?: string
  accountServer?: string
  sessionServer?: string
  servicesUrl?: string
  skinDomains: string[]
}

const MAX_PROVIDER_FILE = 1024 * 1024

function keyForm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function findString(record: Record<string, unknown>, aliases: string[]): string | undefined {
  const wanted = new Set(aliases.map(keyForm))
  for (const [key, value] of Object.entries(record)) {
    if (wanted.has(keyForm(key)) && typeof value === 'string' && value.trim()) return value.trim()
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = findString(value as Record<string, unknown>, aliases)
      if (nested) return nested
    }
  }
  return undefined
}

function findStrings(record: Record<string, unknown>, aliases: string[]): string[] {
  const wanted = new Set(aliases.map(keyForm))
  for (const [key, value] of Object.entries(record)) {
    if (!wanted.has(keyForm(key))) continue
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
    if (typeof value === 'string') return value.split(/[,\s]+/).filter(Boolean)
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = findStrings(value as Record<string, unknown>, aliases)
      if (nested.length) return nested
    }
  }
  return []
}

export function normalizeYggdrasilUrl(input: string): string {
  let value = input.trim()
  if (!value) throw new Error('API Root 不能为空')
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = `https://${value}`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('API Root 不是有效 URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('认证服务仅支持 HTTPS 或 HTTP URL')
  }
  if (url.username || url.password) throw new Error('认证服务 URL 不得包含用户名或密码')
  if (url.search || url.hash) throw new Error('认证服务 URL 不得包含查询参数或片段')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url.toString()
}

export function providerId(apiRoot: string): string {
  return `ygg-${crypto.createHash('sha256').update(normalizeYggdrasilUrl(apiRoot)).digest('hex').slice(0, 24)}`
}

export function normalizeSkinDomains(values: string[]): string[] {
  const result = new Set<string>()
  for (const value of values) {
    let item = value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '')
    if (item.startsWith('*.')) item = `.${item.slice(2)}`
    if (!item || /[\s/?#@]/.test(item)) continue
    result.add(item)
  }
  return [...result]
}

function descriptorFromText(text: string, sourceLabel: string): ParsedProviderDescriptor {
  const trimmed = text.trim().replace(/^\uFEFF/, '')
  if (!trimmed) throw new Error('拖入内容为空')
  if (trimmed.length > MAX_PROVIDER_FILE) throw new Error('提供商配置超过 1 MB 限制')

  const dndPrefix = 'authlib-injector:yggdrasil-server:'
  if (trimmed.toLowerCase().startsWith(dndPrefix)) {
    const encoded = trimmed.slice(dndPrefix.length)
    let decoded: string
    try {
      decoded = decodeURIComponent(encoded)
    } catch {
      throw new Error('authlib-injector 拖拽 URI 编码无效')
    }
    return { sourceLabel, apiRoot: normalizeYggdrasilUrl(decoded), skinDomains: [] }
  }

  if (trimmed.startsWith('{')) {
    let data: Record<string, unknown>
    try {
      data = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      throw new Error('提供商 JSON 格式无效')
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('提供商 JSON 顶层必须是对象')
    }
    const apiRoot =
      findString(data, ['apiRoot', 'yggdrasilApiRoot', 'yggdrasilServer', 'apiUrl', 'serverUrl']) ??
      (typeof data.url === 'string' ? data.url : undefined)
    if (!apiRoot) throw new Error('提供商 JSON 中缺少 API Root')
    return {
      sourceLabel,
      name: findString(data, ['providerName', 'serverName', 'name']),
      apiRoot: normalizeYggdrasilUrl(apiRoot),
      authServer: findString(data, ['authServer', 'authenticationServer']),
      accountServer: findString(data, ['accountServer']),
      sessionServer: findString(data, ['sessionServer']),
      servicesUrl: findString(data, ['services', 'servicesUrl', 'metadataUrl']),
      skinDomains: normalizeSkinDomains(findStrings(data, ['skinDomains', 'textureDomains'])),
    }
  }

  const shortcut = /^URL\s*=\s*(.+)$/im.exec(trimmed)?.[1]?.trim()
  const embeddedUrl = /https?:\/\/[^\s"'<>]+/i.exec(trimmed)?.[0]
  const labeledRoot = /(?:api\s*root|yggdrasil(?:\s*server)?)\s*[:=]\s*([^\s]+)/i.exec(trimmed)?.[1]
  const value = shortcut ?? embeddedUrl ?? labeledRoot ?? trimmed.split(/\s+/)[0]
  return { sourceLabel, apiRoot: normalizeYggdrasilUrl(value), skinDomains: [] }
}

export function parseProviderInput(input: YggdrasilProviderInput): ParsedProviderDescriptor {
  if (input.kind === 'text') return descriptorFromText(String(input.value ?? ''), '拖入或粘贴的文本')
  const filePath = path.resolve(String(input.value ?? ''))
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    throw new Error('提供商配置文件不存在')
  }
  if (!stat.isFile()) throw new Error('提供商配置必须是文件')
  if (stat.size > MAX_PROVIDER_FILE) throw new Error('提供商配置超过 1 MB 限制')
  const ext = path.extname(filePath).toLowerCase()
  if (!['.json', '.txt', '.url', '.yggdrasil'].includes(ext)) {
    throw new Error('仅支持 JSON、TXT、URL 或 .yggdrasil 提供商配置')
  }
  return descriptorFromText(fs.readFileSync(filePath, 'utf-8'), path.basename(filePath))
}

export function resolveProviderEndpoints(
  descriptor: ParsedProviderDescriptor,
  resolvedApiRoot = descriptor.apiRoot
): Pick<YggdrasilProvider, 'apiRoot' | 'authServer' | 'accountServer' | 'sessionServer' | 'servicesUrl' | 'insecure'> {
  const apiRoot = normalizeYggdrasilUrl(resolvedApiRoot)
  const resolve = (value: string | undefined, fallback: string): string =>
    normalizeYggdrasilUrl(value ? new URL(value, apiRoot).toString() : new URL(fallback, apiRoot).toString())
  const result: Pick<YggdrasilProvider, 'apiRoot' | 'authServer' | 'accountServer' | 'sessionServer' | 'servicesUrl' | 'insecure'> = {
    apiRoot,
    authServer: resolve(descriptor.authServer, 'authserver/'),
    accountServer: resolve(descriptor.accountServer, 'api/'),
    sessionServer: resolve(descriptor.sessionServer, 'sessionserver/'),
    insecure: [apiRoot, descriptor.authServer, descriptor.accountServer, descriptor.sessionServer]
      .filter(Boolean)
      .some((url) => normalizeYggdrasilUrl(String(url)).startsWith('http:')),
  }
  if (descriptor.servicesUrl) result.servicesUrl = resolve(descriptor.servicesUrl, '')
  return result
}

export function endpointUrl(base: string, operation: string): string {
  return new URL(operation.replace(/^\/+/, ''), normalizeYggdrasilUrl(base)).toString()
}

export function isAllowedTextureUrl(urlValue: string, provider: YggdrasilProvider): boolean {
  let url: URL
  try {
    url = new URL(urlValue)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && !(provider.insecure && url.protocol === 'http:')) return false
  const host = url.hostname.toLowerCase()
  const allowed = provider.skinDomains.length ? provider.skinDomains : [new URL(provider.apiRoot).hostname.toLowerCase()]
  return allowed.some((rule) => {
    const normalized = rule.toLowerCase()
    return normalized.startsWith('.') ? host === normalized.slice(1) || host.endsWith(normalized) : host === normalized
  })
}

/** Minecraft 参数模板要求 Map<string, string[]>，而 Yggdrasil 响应是 name/value 列表。 */
export function serializeYggdrasilUserProperties(properties: Array<{ name: string; value: string }> | undefined): string {
  const result: Record<string, string[]> = {}
  for (const property of properties ?? []) {
    if (!property.name || typeof property.value !== 'string') continue
    ;(result[property.name] ??= []).push(property.value)
  }
  return JSON.stringify(result)
}

export function buildAuthlibInjectorArguments(jarPath: string, apiRoot: string, metadata: string): string[] {
  if (!jarPath.trim()) throw new Error('authlib-injector 路径为空')
  const root = normalizeYggdrasilUrl(apiRoot)
  parseMetadataShape(metadata)
  return [`-javaagent:${jarPath}=${root}`, `-Dauthlibinjector.yggdrasil.prefetched=${Buffer.from(metadata, 'utf-8').toString('base64')}`]
}

function parseMetadataShape(metadata: string): void {
  try {
    const value = JSON.parse(metadata) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
  } catch {
    throw new Error('authlib-injector 预取元数据无效')
  }
}
