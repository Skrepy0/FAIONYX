/**
 * 账号模块：离线账号 + 微软 device code 登录（XBL → XSTS → MC）
 * 存储：userData/accounts.json
 */
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Account, MsDeviceCodeInfo } from '../../shared/types';
import { getSettings } from './settings';
import * as yggdrasil from './yggdrasil';
import { microsoftFetch } from './microsoftTls';
import { logScope } from './launcherLog';
import { protectedCredentialStorage, credentialStorageStatus } from './credentialProtection';

const authLog = logScope('ms-auth');

/** 登录链路某一步失败时抛出带步骤标签的错误，并写启动器日志（供错误报告诊断）。 */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    authLog.error(`微软登录步骤失败：${name}`, error);
    throw new Error(`${name}：${message}`);
  }
}

/** 微软 OAuth 端点（consumers 租户：支持个人 MSA 账号的 device code 流程） */
const MS_SCOPE = 'XboxLive.signin offline_access';

/** client_id 统一走 consumers 租户（默认 Prism 公开应用 / 用户自注册应用均为该租户） */
function msAuthBase(_clientId: string): string {
  return 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
}

interface AccountsFile {
  accounts: Account[];
  selectedId: string | null;
}

type SecretKey = 'accessToken' | 'refreshToken' | 'clientToken' | 'loginIdentifier' | 'userProperties';

interface StoredAccount extends Omit<Account, SecretKey> {
  secure?: Partial<Record<SecretKey, string>>;
  /** 仅用于从 0.6.5 及更早版本迁移；新写入文件绝不会保留这些明文字段。 */
  accessToken?: string;
  refreshToken?: string;
  clientToken?: string;
  loginIdentifier?: string;
  userProperties?: Array<{ name: string; value: string }>;
}

interface StoredAccountsFile {
  accounts?: StoredAccount[];
  selectedId?: string | null;
}

const SECRET_KEYS: SecretKey[] = ['accessToken', 'refreshToken', 'clientToken', 'loginIdentifier', 'userProperties'];

let cached: AccountsFile | null = null;
// Preserve already encrypted credentials while a keyring is temporarily locked.
// Session-only logins never overwrite these with a basic_text ciphertext.
const storedSecrets = new Map<string, StoredAccount['secure']>();
export function accountStorageStatus() {
  return credentialStorageStatus(safeStorage);
}

function storeFile(): string {
  return path.join(app.getPath('userData'), 'accounts.json');
}

function encryptSecret(value: unknown): string {
  if (!protectedCredentialStorage(safeStorage)) {
    throw new Error('系统安全存储当前不可用，无法安全保存登录令牌');
  }
  const plain = typeof value === 'string' ? value : JSON.stringify(value);
  return safeStorage.encryptString(plain).toString('base64');
}

function decryptSecret(value: string): string | undefined {
  try {
    if (!protectedCredentialStorage(safeStorage)) return undefined;
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    return undefined;
  }
}

function deserializeAccount(stored: StoredAccount): { account: Account; legacySecrets: boolean } {
  const account = { ...stored } as Account & { secure?: StoredAccount['secure'] };
  delete account.secure;
  let legacySecrets = false;
  for (const key of SECRET_KEYS) {
    const encrypted = stored.secure?.[key];
    if (encrypted) {
      const plain = decryptSecret(encrypted);
      if (plain !== undefined) {
        if (key === 'userProperties') {
          try {
            account.userProperties = JSON.parse(plain) as Account['userProperties'];
          } catch {
            account.userProperties = [];
          }
        } else {
          (account as unknown as Record<string, unknown>)[key] = plain;
        }
      }
    } else if (stored[key] !== undefined) {
      legacySecrets = true;
    }
  }
  return { account, legacySecrets };
}

function serializeAccount(account: Account): StoredAccount {
  const stored = { ...account } as StoredAccount;
  const secure: StoredAccount['secure'] = {};
  for (const key of SECRET_KEYS) {
    const value = account[key];
    delete (stored as unknown as Record<string, unknown>)[key];
    if (value !== undefined && value !== '' && !(process.platform === 'linux' && !protectedCredentialStorage(safeStorage)))
      secure[key] = encryptSecret(value);
  }
  if (process.platform === 'linux' && !protectedCredentialStorage(safeStorage)) Object.assign(secure, storedSecrets.get(account.id));
  if (Object.keys(secure).length) stored.secure = secure;
  return stored;
}

function load(): AccountsFile {
  if (cached) return cached;
  let migrate = false;
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf-8')) as StoredAccountsFile;
    const accounts = Array.isArray(raw.accounts)
      ? raw.accounts.map((stored) => {
          if (stored.secure) storedSecrets.set(stored.id, { ...stored.secure });
          const parsed = deserializeAccount(stored);
          migrate ||= parsed.legacySecrets;
          return parsed.account;
        })
      : [];
    cached = {
      accounts,
      selectedId: raw.selectedId ?? null,
    };
  } catch {
    cached = { accounts: [], selectedId: null };
  }
  if (migrate && protectedCredentialStorage(safeStorage)) {
    try {
      persist();
    } catch (error) {
      console.error('[FAIONYX] 账号凭据安全迁移失败，原文件保持不变:', error);
    }
  }
  return cached;
}

function persist(): void {
  const data = load();
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  const stored: StoredAccountsFile = {
    accounts: data.accounts.map(serializeAccount),
    selectedId: data.selectedId,
  };
  fs.writeFileSync(storeFile(), JSON.stringify(stored, null, 2), { encoding: 'utf-8', mode: 0o600 });
  if (process.platform === 'linux') fs.chmodSync(storeFile(), 0o600);
  storedSecrets.clear();
  for (const row of stored.accounts ?? []) if (row.secure) storedSecrets.set(row.id, { ...row.secure });
}

/** 渲染进程只拿展示字段，token、登录标识和用户属性始终留在主进程。 */
export function publicAccount(account: Account): Account {
  const result = { ...account };
  delete result.accessToken;
  delete result.refreshToken;
  delete result.clientToken;
  delete result.loginIdentifier;
  delete result.userProperties;
  return result;
}

/** 插入或更新账号（按 uuid 去重），并设为当前选中 */
function upsert(account: Account, select = true): Account {
  const data = load();
  const previousAccounts = data.accounts;
  const previousSelectedId = data.selectedId;
  const nextAccounts = [...data.accounts];
  const idx = data.accounts.findIndex(
    (existing) =>
      existing.id === account.id || (account.type !== 'yggdrasil' && existing.type !== 'yggdrasil' && existing.uuid === account.uuid)
  );
  if (idx >= 0) nextAccounts[idx] = { ...nextAccounts[idx], ...account };
  else nextAccounts.push(account);
  data.accounts = nextAccounts;
  if (select) data.selectedId = account.id;
  try {
    persist();
  } catch (error) {
    data.accounts = previousAccounts;
    data.selectedId = previousSelectedId;
    throw error;
  }
  return account;
}

// ---------------- 基础操作 ----------------

export function listAccounts(): Account[] {
  return load().accounts.map(publicAccount);
}

/** 仅供主进程按账号读取凭据，不改变当前选择。 */
export function accountById(id: string): Account | null {
  return load().accounts.find((account) => account.id === id) ?? null;
}

export function selectedAccount(): Account | null {
  const data = load();
  return data.accounts.find((a) => a.id === data.selectedId) ?? null;
}

export function selectedAccountPublic(): Account | null {
  const account = selectedAccount();
  return account ? publicAccount(account) : null;
}

export function selectAccount(id: string): Account | null {
  const data = load();
  const acc = data.accounts.find((a) => a.id === id) ?? null;
  if (acc) {
    const previousSelectedId = data.selectedId;
    data.selectedId = acc.id;
    try {
      persist();
    } catch (error) {
      data.selectedId = previousSelectedId;
      throw error;
    }
  }
  return acc ? publicAccount(acc) : null;
}

export async function removeAccount(id: string): Promise<Account[]> {
  const data = load();
  const account = data.accounts.find((item) => item.id === id);
  if (account?.type === 'yggdrasil') await yggdrasil.invalidateAccount(account);
  const previousAccounts = data.accounts;
  const previousSelectedId = data.selectedId;
  data.accounts = data.accounts.filter((a) => a.id !== id);
  if (data.selectedId === id) data.selectedId = data.accounts[0]?.id ?? null;
  try {
    persist();
  } catch (error) {
    data.accounts = previousAccounts;
    data.selectedId = previousSelectedId;
    throw error;
  }
  return data.accounts.map(publicAccount);
}

export function hasProviderAccounts(providerId: string): boolean {
  return load().accounts.some((account) => account.type === 'yggdrasil' && account.providerId === providerId);
}

export function saveYggdrasilAccount(account: Account): Account {
  if (account.type !== 'yggdrasil') throw new Error('无效的外置登录账号');
  return publicAccount(upsert(account));
}

// ---------------- 离线账号 ----------------

/** 32 位 hex 格式化为 8-4-4-4-12，并设置 version 3 / variant 位（与 MC 离线模式一致） */
function offlineUuid(username: string): string {
  const hex = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf-8').digest('hex');
  const fixed = hex.slice(0, 12) + '3' + hex.slice(13, 16) + '8' + hex.slice(17);
  return `${fixed.slice(0, 8)}-${fixed.slice(8, 12)}-${fixed.slice(12, 16)}-${fixed.slice(16, 20)}-${fixed.slice(20)}`;
}

export function addOffline(username: string): Account {
  const name = username.trim();
  if (!name) throw new Error('用户名不能为空');
  const uuid = offlineUuid(name);
  const account: Account = {
    id: uuid,
    type: 'offline',
    username: name,
    uuid,
    accessToken: crypto.randomBytes(16).toString('hex'),
  };
  return upsert(account);
}

// ---------------- 微软登录 ----------------

/** 轮询取消标记 */
let pollAbort: AbortController | null = null;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('已取消'));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new Error('已取消'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 正版登录代理开关：默认直连（安全优先）；用户网络直连失败时可开启走系统代理（端到端 TLS 校验保持） */
function useProxy(): boolean {
  try {
    return getSettings().msUseProxy === true;
  } catch {
    return false;
  }
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await microsoftFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(30000),
    useProxy: useProxy(),
  });
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await microsoftFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
    useProxy: useProxy(),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const xerr = data.XErr ? ` (XErr ${String(data.XErr)})` : '';
    throw new Error(`请求失败 HTTP ${res.status}${xerr}: ${url}`);
  }
  return data;
}

async function getJson(url: string, bearer: string): Promise<Record<string, unknown>> {
  const res = await microsoftFetch(url, {
    headers: { Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(30000),
    useProxy: useProxy(),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`请求失败 HTTP ${res.status}: ${url}`);
  return data;
}

function uuidWithHyphens(id: string): string {
  const hex = id.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 拿到微软 oauth token 后的完整链路：
 * XBL → XSTS → MC 登录 → 拥有权检查 → 档案
 */
async function completeMsLogin(msAccessToken: string, refreshToken: string, expiresIn: number, select = true): Promise<Account> {
  // 1. XBL 认证
  const xbl = await step('Xbox Live 认证', () =>
    postJson('https://user.auth.xboxlive.com/user/authenticate', {
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${msAccessToken}`,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    })
  );
  const xblToken = xbl.Token as string;
  if (!xblToken) throw new Error('Xbox Live 认证失败：响应缺少 Token');

  // 2. XSTS 授权
  const xsts = await step('XSTS 授权', () =>
    postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    })
  );
  const xstsToken = xsts.Token as string;
  const xui = (xsts.DisplayClaims as { xui?: { uhs?: string }[] } | undefined)?.xui;
  const uhs = xui?.[0]?.uhs;
  if (!xstsToken || !uhs) {
    throw new Error('XSTS 授权失败（该账号可能尚未创建 Xbox 档案，请先在 xbox.com 登录一次）');
  }

  // 3. MC 登录
  const mc = await step('Minecraft 登录', () =>
    postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
      identityToken: `XBL3.0 x=${uhs};${xstsToken}`,
    })
  );
  const mcToken = mc.access_token as string;
  const mcExpires = (mc.expires_in as number | undefined) ?? expiresIn;
  if (!mcToken) throw new Error('Minecraft 登录失败：响应缺少 access_token');

  // 4. 拥有权检查
  const entitlements = await step('Minecraft 拥有权检查', () => getJson('https://api.minecraftservices.com/entitlements/mcstore', mcToken));
  const items = (entitlements.items as { name?: string }[] | undefined) ?? [];
  if (!items.some((i) => i.name === 'product_minecraft')) {
    throw new Error('Minecraft 拥有权检查：该账号未拥有 Minecraft');
  }

  // 5. 档案
  const profile = await step('获取 Minecraft 档案', () => getJson('https://api.minecraftservices.com/minecraft/profile', mcToken));
  const pid = profile.id as string;
  const pname = profile.name as string;
  if (!pid || !pname) throw new Error('获取 Minecraft 档案失败');

  const uuid = uuidWithHyphens(pid);
  const account: Account = {
    id: uuid,
    type: 'microsoft',
    username: pname,
    uuid,
    accessToken: mcToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + mcExpires,
  };
  return upsert(account, select);
}

/** 后台轮询 token 端点直到成功/过期/取消 */
async function pollDeviceCode(deviceCode: string, intervalSec: number, expiresInSec: number, signal: AbortSignal): Promise<Account> {
  const clientId = getSettings().msClientId;
  let interval = Math.max(1, intervalSec) * 1000;
  const deadline = Date.now() + expiresInSec * 1000;
  while (Date.now() < deadline) {
    await sleep(interval, signal);
    const t = await postForm(`${msAuthBase(clientId)}/token`, {
      client_id: clientId,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
    });
    if (typeof t.access_token === 'string') {
      return await completeMsLogin(
        t.access_token,
        (t.refresh_token as string | undefined) ?? '',
        (t.expires_in as number | undefined) ?? 86400
      );
    }
    const err = t.error as string | undefined;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') {
      interval += 5000;
      continue;
    }
    throw new Error((t.error_description as string | undefined) ?? err ?? '登录失败');
  }
  throw new Error('登录超时，设备码已过期');
}

/**
 * 开始 device code 登录：返回展示信息给前端，后台轮询，
 * 完成后调用 onDone(account)；失败时 onDone(null, 具体原因)；用户取消时 onDone(null)。
 */
export async function beginMsDeviceCode(onDone: (account: Account | null, error?: string) => void): Promise<MsDeviceCodeInfo> {
  cancelMsLogin(); // 取消上一次未完成的轮询
  const clientId = getSettings().msClientId;
  const dc = await postForm(`${msAuthBase(clientId)}/devicecode`, {
    client_id: clientId,
    scope: MS_SCOPE,
  });
  const deviceCode = dc.device_code as string | undefined;
  if (!deviceCode) {
    const message = (dc.error_description as string | undefined) ?? '获取设备码失败';
    authLog.error(`微软登录步骤失败：获取设备码（${message}）`);
    throw new Error(`获取设备码：${message}`);
  }

  pollAbort = new AbortController();
  const signal = pollAbort.signal;
  void pollDeviceCode(deviceCode, (dc.interval as number | undefined) ?? 5, (dc.expires_in as number | undefined) ?? 900, signal)
    .then((account) => onDone(account))
    .catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      // 用户主动取消不写错误日志；真实失败写日志供诊断
      if (!signal.aborted) authLog.error('微软登录失败', e);
      onDone(null, signal.aborted ? undefined : message);
    });

  return {
    userCode: (dc.user_code as string | undefined) ?? '',
    verificationUri: (dc.verification_uri as string | undefined) ?? '',
    message: (dc.message as string | undefined) ?? '',
  };
}

/** 取消进行中的微软登录轮询 */
export function cancelMsLogin(): void {
  pollAbort?.abort();
  pollAbort = null;
}

/** 用 refresh_token 重走整个 XBL→XSTS→MC 链，更新存储 */
export async function refreshMicrosoft(account: Account): Promise<Account> {
  if (!account.refreshToken) throw new Error('缺少 refresh_token，请重新登录');
  const t = await postForm(`${msAuthBase(getSettings().msClientId)}/token`, {
    client_id: getSettings().msClientId,
    grant_type: 'refresh_token',
    refresh_token: account.refreshToken,
    scope: MS_SCOPE,
  });
  if (typeof t.access_token !== 'string') {
    throw new Error((t.error_description as string | undefined) ?? '微软令牌刷新失败，请重新登录');
  }
  const refreshed = await completeMsLogin(
    t.access_token,
    (t.refresh_token as string | undefined) ?? account.refreshToken,
    (t.expires_in as number | undefined) ?? 86400,
    false
  );
  // 后台头像刷新不得改变用户当前选中的账号。
  return refreshed;
}

/** 返回可用账号：离线直接返回；微软临期（<5分钟）自动刷新 */
export async function getValidAccount(account: Account): Promise<Account> {
  if (account.type === 'offline') return account;
  if (account.type === 'yggdrasil') {
    const refreshed = await yggdrasil.refreshAccount(account);
    if (refreshed !== account) upsert(refreshed, false);
    return refreshed;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!account.accessToken || !account.expiresAt || account.expiresAt - now < 300) {
    return await refreshMicrosoft(account);
  }
  return account;
}

/** 账号页手动验证/刷新；只向前端返回展示字段。 */
export async function refreshAccountById(id: string): Promise<Account> {
  const account = load().accounts.find((item) => item.id === id);
  if (!account) throw new Error('账号不存在');
  const refreshed = await getValidAccount(account);
  if (refreshed !== account) upsert(refreshed, false);
  return publicAccount(refreshed);
}
