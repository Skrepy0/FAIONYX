import net from 'node:net';
import { domainToASCII } from 'node:url';
import { translate as t } from '../../shared/i18n';

export interface ParsedServerAddress {
  host: string;
  port: number;
  explicitPort: boolean;
  /** 交给 Minecraft 的地址；默认端口保持简洁，IPv6 始终加方括号。 */
  address: string;
  /** 去重键，始终显式包含端口。 */
  normalizedAddress: string;
}

function normalizedHost(value: string): string {
  const raw = value.trim().replace(/\.$/, '');
  if (!raw || /[\s/?#@]/.test(raw)) throw new Error(t('serverutils.error.address_format'));
  if (net.isIP(raw)) return raw.toLowerCase();
  const ascii = domainToASCII(raw).toLowerCase();
  if (!ascii || ascii.length > 253 || ascii.split('.').some((part) => !part || part.length > 63)) {
    throw new Error(t('serverutils.error.domain_format'));
  }
  return ascii;
}

function normalizedPort(value: string | undefined): { port: number; explicit: boolean } {
  if (value == null || value === '') return { port: 25565, explicit: false };
  if (!/^\d{1,5}$/.test(value)) throw new Error(t('serverutils.error.port_range'));
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error(t('serverutils.error.port_range'));
  return { port, explicit: true };
}

/**
 * 解析 Java 版服务器地址。支持域名、IPv4、[IPv6]:port 与裸 IPv6；
 * minecraft:// 仅作为用户从浏览器拖入/粘贴时的便利前缀，不保留路径与凭据。
 */
export function parseServerAddress(input: string): ParsedServerAddress {
  let raw = input.trim();
  if (/^minecraft:\/\//i.test(raw)) raw = raw.slice('minecraft://'.length);
  if (!raw) throw new Error(t('serverutils.error.empty'));

  let hostRaw = raw;
  let portRaw: string | undefined;
  if (raw.startsWith('[')) {
    const closing = raw.indexOf(']');
    if (closing < 0) throw new Error(t('serverutils.error.ipv6_bracket_missing'));
    hostRaw = raw.slice(1, closing);
    const rest = raw.slice(closing + 1);
    if (rest) {
      if (!rest.startsWith(':')) throw new Error(t('serverutils.error.address_format'));
      portRaw = rest.slice(1);
    }
  } else {
    const colonCount = (raw.match(/:/g) ?? []).length;
    if (colonCount === 1) {
      const at = raw.lastIndexOf(':');
      hostRaw = raw.slice(0, at);
      portRaw = raw.slice(at + 1);
    } else if (colonCount > 1 && net.isIP(raw) !== 6) {
      throw new Error(t('serverutils.error.ipv6_port_hint'));
    }
  }

  const host = normalizedHost(hostRaw);
  const { port, explicit } = normalizedPort(portRaw);
  const shownHost = net.isIP(host) === 6 ? `[${host}]` : host;
  return {
    host,
    port,
    explicitPort: explicit,
    address: explicit && port !== 25565 ? `${shownHost}:${port}` : shownHost,
    normalizedAddress: `${shownHost}:${port}`,
  };
}

export function serverAssociationKey(
  normalizedAddress: string,
  versionId?: string,
  folderIdentity?: string,
  sourceIdentity?: string
): string {
  if (versionId) return `${normalizedAddress}\u0000${folderIdentity ?? ''}\u0000${versionId}`;
  return `${normalizedAddress}\u0000shared\u0000${sourceIdentity ?? ''}`;
}

/** 官方 Quick Play 参数自 Java 1.20 / 快照 23w14a 起受支持。 */
export function supportsQuickPlayMultiplayer(version: string): boolean {
  const release = /^(\d+)\.(\d+)(?:\.(\d+))?(?:$|[-+])/.exec(version.trim());
  if (release) {
    const major = Number(release[1]);
    const minor = Number(release[2]);
    return major > 1 || (major === 1 && minor >= 20);
  }
  const snapshot = /^(\d{2})w(\d{2})([a-z])$/i.exec(version.trim());
  if (!snapshot) return false;
  const year = Number(snapshot[1]);
  const week = Number(snapshot[2]);
  const revision = snapshot[3].toLowerCase();
  return year > 23 || (year === 23 && (week > 14 || (week === 14 && revision >= 'a')));
}
