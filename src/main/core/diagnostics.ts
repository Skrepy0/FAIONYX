import os from 'node:os'
import path from 'node:path'

const TOKEN_KEYS = '(?:access[_-]?token|refresh[_-]?token|client[_-]?token|session[_-]?(?:id|key)|password|authorization)'

/**
 * 脱敏待导出的日志与启动参数。调用方还可传入本次会话中已知的真实密钥；
 * 任何账号 token、认证头以及用户主目录都不会原样进入诊断包。
 */
export function redactDiagnosticText(input: string, knownSecrets: string[] = []): string {
  let out = String(input ?? '')
  for (const secret of knownSecrets) {
    if (!secret || secret.length < 4) continue
    out = out.split(secret).join('<redacted>')
  }
  out = out
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, '$1<redacted>')
    .replace(new RegExp(`("?${TOKEN_KEYS}"?\\s*[:=]\\s*")([^"\\r\\n]+)(")`, 'gi'), '$1<redacted>$3')
    .replace(new RegExp(`(${TOKEN_KEYS}\\s*[:=]\\s*)([^\\s,;]+)`, 'gi'), '$1<redacted>')
    .replace(/(--accessToken|--clientId|--xuid|--userProperties)\s+("[^"]*"|\S+)/gi, '$1 <redacted>')
    .replace(/(--username|--uuid)\s+("[^"]*"|\S+)/gi, '$1 <redacted-user>')
    .replace(/([?&](?:access_token|refresh_token|token|key)=)[^&#\s]+/gi, '$1<redacted>')

  const home = os.homedir()
  if (home) out = replacePathInsensitive(out, home, '%USERPROFILE%')
  // 也覆盖从其他机器收集的 Windows 日志；仅保留相对到用户目录后的部分。
  out = out.replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gi, '%USERPROFILE%')
  out = out.replace(/\/(?:Users|home)\/[^/\s"']+/g, '$HOME')
  return out
}

function replacePathInsensitive(input: string, from: string, to: string): string {
  if (!from) return input
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return input.replace(new RegExp(escaped, process.platform === 'win32' ? 'gi' : 'g'), to)
}

/** 仅用于 ZIP 文件名；实例显示名仍在 manifest 中保留。 */
export function safeDiagnosticFilePart(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return (cleaned || 'unknown').slice(0, 80)
}

export function redactDiagnosticPath(value: string): string {
  if (!value) return '（未知）'
  return redactDiagnosticText(path.normalize(value))
}
