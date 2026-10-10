import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Account,
  ProfileSkins,
  YggdrasilLoginResult,
  YggdrasilProfileChoice,
  YggdrasilProvider,
  YggdrasilProviderCandidate,
  YggdrasilProviderInput,
  YggdrasilRuntimeInfo,
} from '../../shared/types';
import { translate as t } from '../../shared/i18n';
import { getSettings } from './settings';
import {
  endpointUrl,
  buildAuthlibInjectorArguments,
  isAllowedTextureUrl,
  normalizeSkinDomains,
  normalizeYggdrasilUrl,
  parseProviderInput,
  providerId,
  resolveProviderEndpoints,
} from './yggdrasilProvider';

const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 4096;
const MAX_AGENT_BYTES = 32 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 30_000;

interface YggProfile {
  id?: unknown;
  name?: unknown;
}

interface YggUser {
  id?: unknown;
  properties?: unknown;
}

interface YggResponse {
  accessToken?: unknown;
  clientToken?: unknown;
  selectedProfile?: YggProfile;
  availableProfiles?: YggProfile[];
  user?: YggUser;
}

interface PendingProfileSelection {
  provider: YggdrasilProvider;
  identifier: string;
  accessToken: string;
  clientToken: string;
  profiles: YggdrasilProfileChoice[];
  user?: YggUser;
  expiresAt: number;
}

interface ProviderMetadataResult {
  apiRoot: string;
  raw: string;
  data: Record<string, unknown>;
  aliRedirected: boolean;
}

interface InjectorArtifact {
  build_number: number;
  version: string;
  download_url: string;
  checksums: { sha256: string };
}

const pendingProfiles = new Map<string, PendingProfileSelection>();
const probedMetadata = new Map<string, string>();
let providersCache: YggdrasilProvider[] | null = null;
let injectorPromise: Promise<string> | null = null;

function providersFile(): string {
  return path.join(app.getPath('userData'), 'yggdrasil-providers.json');
}

function metadataDirectory(): string {
  return path.join(app.getPath('userData'), 'yggdrasil-metadata');
}

function injectorDirectory(): string {
  return path.join(app.getPath('userData'), 'authlib-injector');
}

function cleanProvider(value: unknown): YggdrasilProvider | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<YggdrasilProvider>;
  try {
    const apiRoot = normalizeYggdrasilUrl(String(item.apiRoot ?? ''));
    const descriptor = {
      sourceLabel: t('yggdrasil.label.saved_config'),
      apiRoot,
      authServer: item.authServer,
      accountServer: item.accountServer,
      sessionServer: item.sessionServer,
      servicesUrl: item.servicesUrl,
      skinDomains: normalizeSkinDomains(item.skinDomains ?? []),
    };
    const endpoints = resolveProviderEndpoints(descriptor);
    return {
      id: providerId(apiRoot),
      name: String(item.name ?? '').trim() || new URL(apiRoot).hostname,
      ...endpoints,
      skinDomains: descriptor.skinDomains,
      insecure: endpoints.insecure,
      metadataFetchedAt: typeof item.metadataFetchedAt === 'string' ? item.metadataFetchedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function listProviders(): YggdrasilProvider[] {
  if (providersCache) return providersCache.map((provider) => ({ ...provider }));
  try {
    const raw = JSON.parse(fs.readFileSync(providersFile(), 'utf-8')) as unknown;
    providersCache = Array.isArray(raw) ? raw.map(cleanProvider).filter((provider): provider is YggdrasilProvider => !!provider) : [];
  } catch {
    providersCache = [];
  }
  return providersCache.map((provider) => ({ ...provider }));
}

function persistProviders(providers: YggdrasilProvider[]): void {
  fs.mkdirSync(path.dirname(providersFile()), { recursive: true });
  fs.writeFileSync(providersFile(), JSON.stringify(providers, null, 2), 'utf-8');
  providersCache = providers.map((provider) => ({ ...provider }));
}

export function findProvider(id: string): YggdrasilProvider {
  const provider = listProviders().find((item) => item.id === id);
  if (!provider) throw new Error(t('yggdrasil.error.provider_deleted'));
  return provider;
}

function assertSecure(urls: string[], allowInsecure: boolean): void {
  const insecure = urls.some((value) => normalizeYggdrasilUrl(value).startsWith('http:'));
  if (insecure && !allowInsecure) {
    throw new Error(`INSECURE_YGGDRASIL:${t('yggdrasil.error.insecure_http')}`);
  }
}

async function responseTextLimited(response: Response, maxBytes: number): Promise<string> {
  return (await responseBufferLimited(response, maxBytes)).toString('utf-8').replace(/^\uFEFF/, '');
}

async function responseBufferLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(t('yggdrasil.error.response_too_large', { kb: Math.round(maxBytes / 1024) }));
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(t('yggdrasil.error.response_too_large', { kb: Math.round(maxBytes / 1024) }));
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function parseMetadata(raw: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(t('yggdrasil.error.metadata_invalid_json'));
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(t('yggdrasil.error.metadata_not_object'));
  }
  return data as Record<string, unknown>;
}

async function fetchMetadataAt(inputUrl: string, allowInsecure: boolean): Promise<ProviderMetadataResult> {
  const initial = normalizeYggdrasilUrl(inputUrl);
  assertSecure([initial], allowInsecure);
  const first = await fetch(initial, {
    headers: { Accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!first.ok) throw new Error(t('yggdrasil.error.metadata_http', { status: first.status }));
  const firstUrl = normalizeYggdrasilUrl(first.url || initial);
  assertSecure([firstUrl], allowInsecure);
  const ali = first.headers.get('x-authlib-injector-api-location');
  const resolved = ali ? normalizeYggdrasilUrl(new URL(ali, firstUrl).toString()) : firstUrl;
  assertSecure([resolved], allowInsecure);
  const aliRedirected = resolved !== firstUrl;
  if (aliRedirected) await first.body?.cancel().catch(() => undefined);
  const response = aliRedirected
    ? await fetch(resolved, {
        headers: { Accept: 'application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      })
    : first;
  if (!response.ok) throw new Error(t('yggdrasil.error.api_root_http', { status: response.status }));
  const finalRoot = normalizeYggdrasilUrl(response.url || resolved);
  assertSecure([finalRoot], allowInsecure);
  const raw = await responseTextLimited(response, MAX_METADATA_BYTES);
  return { apiRoot: finalRoot, raw, data: parseMetadata(raw), aliRedirected };
}

function metadataName(data: Record<string, unknown>): string | undefined {
  const meta = data.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const name = (meta as Record<string, unknown>).serverName;
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

function metadataSkinDomains(data: Record<string, unknown>): string[] {
  return normalizeSkinDomains(
    Array.isArray(data.skinDomains) ? data.skinDomains.filter((value): value is string => typeof value === 'string') : []
  );
}

function cacheMetadata(id: string, raw: string): void {
  fs.mkdirSync(metadataDirectory(), { recursive: true });
  fs.writeFileSync(path.join(metadataDirectory(), `${id}.json`), raw, 'utf-8');
}

export async function probeProvider(input: YggdrasilProviderInput, allowInsecure = false): Promise<YggdrasilProviderCandidate> {
  const descriptor = parseProviderInput(input);
  assertSecure(
    [descriptor.apiRoot, descriptor.authServer, descriptor.accountServer, descriptor.sessionServer, descriptor.servicesUrl].filter(
      (value): value is string => !!value
    ),
    allowInsecure
  );
  const metadata = await fetchMetadataAt(descriptor.apiRoot, allowInsecure);
  const endpoints = resolveProviderEndpoints(descriptor, metadata.apiRoot);
  assertSecure([endpoints.apiRoot, endpoints.authServer, endpoints.accountServer, endpoints.sessionServer], allowInsecure);
  const id = providerId(endpoints.apiRoot);
  probedMetadata.set(id, metadata.raw);
  return {
    id,
    name: descriptor.name || metadataName(metadata.data) || new URL(endpoints.apiRoot).hostname,
    ...endpoints,
    skinDomains: normalizeSkinDomains([...descriptor.skinDomains, ...metadataSkinDomains(metadata.data)]),
    insecure: endpoints.insecure,
    metadataFetchedAt: new Date().toISOString(),
    sourceLabel: descriptor.sourceLabel,
    aliRedirected: metadata.aliRedirected,
  };
}

export function saveProvider(candidate: YggdrasilProviderCandidate, allowInsecure = false): YggdrasilProvider[] {
  const cleaned = cleanProvider(candidate);
  if (!cleaned) throw new Error(t('yggdrasil.error.provider_config_invalid'));
  if (cleaned.id !== candidate.id) throw new Error(t('yggdrasil.error.provider_api_root_mismatch'));
  assertSecure([cleaned.apiRoot, cleaned.authServer, cleaned.accountServer, cleaned.sessionServer], allowInsecure);
  const list = listProviders();
  const index = list.findIndex((provider) => provider.id === cleaned.id);
  if (index >= 0) list[index] = cleaned;
  else list.push(cleaned);
  persistProviders(list);
  const metadata = probedMetadata.get(cleaned.id);
  if (metadata) cacheMetadata(cleaned.id, metadata);
  return listProviders();
}

export function removeProvider(id: string, hasAccounts: boolean): YggdrasilProvider[] {
  if (hasAccounts) throw new Error(t('yggdrasil.error.provider_has_accounts'));
  const list = listProviders();
  if (!list.some((provider) => provider.id === id)) throw new Error(t('yggdrasil.error.provider_not_found'));
  persistProviders(list.filter((provider) => provider.id !== id));
  try {
    fs.rmSync(path.join(metadataDirectory(), `${id}.json`), { force: true });
  } catch {
    // 缓存清理失败不影响配置删除。
  }
  return listProviders();
}

async function readYggError(response: Response, fallback: string): Promise<Error> {
  const raw = await responseTextLimited(response, MAX_ERROR_BYTES).catch(() => '');
  let detail = '';
  try {
    const data = JSON.parse(raw) as { errorMessage?: unknown; error?: unknown; cause?: unknown };
    detail = String(data.errorMessage ?? data.cause ?? data.error ?? '');
  } catch {
    detail = raw
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (response.status === 403) return new Error(detail || t('yggdrasil.error.credentials_invalid'));
  if (response.status === 429) return new Error(t('yggdrasil.error.rate_limited'));
  return new Error(detail || t('yggdrasil.error.http_fallback', { fallback, status: response.status }));
}

async function postYgg(url: string, body: unknown): Promise<YggResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) throw await readYggError(response, t('yggdrasil.error.auth_request_failed'));
  if (response.status === 204) return {};
  const raw = await responseTextLimited(response, MAX_METADATA_BYTES);
  try {
    return JSON.parse(raw) as YggResponse;
  } catch {
    throw new Error(t('yggdrasil.error.invalid_json'));
  }
}

function cleanProfile(value: YggProfile): YggdrasilProfileChoice | null {
  const id = String(value?.id ?? '')
    .replace(/-/g, '')
    .toLowerCase();
  const name = String(value?.name ?? '').trim();
  if (!/^[0-9a-f]{32}$/.test(id) || !name) return null;
  return { id, name };
}

function uuidWithHyphens(value: string): string {
  const id = value.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(t('yggdrasil.error.invalid_profile_uuid'));
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function cleanProperties(value: unknown): Array<{ name: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is { name: string; value: string } =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as { name?: unknown }).name === 'string' &&
        typeof (item as { value?: unknown }).value === 'string'
    )
    .map((item) => ({ name: item.name, value: item.value }));
}

function accountFromResponse(
  provider: YggdrasilProvider,
  identifier: string,
  response: YggResponse,
  fallbackClientToken?: string
): Account {
  const profile = response.selectedProfile ? cleanProfile(response.selectedProfile) : null;
  if (!profile) throw new Error(t('yggdrasil.error.no_selected_profile'));
  const accessToken = String(response.accessToken ?? '');
  const clientToken = String(response.clientToken ?? fallbackClientToken ?? '');
  if (!accessToken || !clientToken) throw new Error(t('yggdrasil.error.incomplete_token'));
  const uuid = uuidWithHyphens(profile.id);
  const id = `ygg-${crypto.createHash('sha256').update(`${provider.id}\u0000${identifier}\u0000${profile.id}`).digest('hex').slice(0, 32)}`;
  return {
    id,
    type: 'yggdrasil',
    username: profile.name,
    uuid,
    accessToken,
    clientToken,
    providerId: provider.id,
    providerName: provider.name,
    apiRoot: provider.apiRoot,
    loginIdentifier: identifier,
    userId: typeof response.user?.id === 'string' ? response.user.id : undefined,
    userProperties: cleanProperties(response.user?.properties),
  };
}

async function selectSingleProfile(
  provider: YggdrasilProvider,
  identifier: string,
  accessToken: string,
  clientToken: string,
  profile: YggdrasilProfileChoice,
  user?: YggUser
): Promise<Account> {
  const response = await postYgg(endpointUrl(provider.authServer, 'refresh'), {
    accessToken,
    clientToken,
    selectedProfile: profile,
    requestUser: true,
  });
  if (!response.user && user) response.user = user;
  return accountFromResponse(provider, identifier, response, clientToken);
}

export async function authenticate(providerIdValue: string, identifierValue: string, passwordValue: string): Promise<YggdrasilLoginResult> {
  const provider = findProvider(providerIdValue);
  const identifier = identifierValue.trim();
  const password = passwordValue;
  if (!identifier) throw new Error(t('yggdrasil.error.identifier_empty'));
  if (!password) throw new Error(t('yggdrasil.error.password_empty'));
  const clientToken = crypto.randomUUID().replace(/-/g, '');
  const response = await postYgg(endpointUrl(provider.authServer, 'authenticate'), {
    agent: { name: 'Minecraft', version: 1 },
    username: identifier,
    password,
    clientToken,
    requestUser: true,
  });
  const accessToken = String(response.accessToken ?? '');
  const returnedClientToken = String(response.clientToken ?? clientToken);
  if (!accessToken) throw new Error(t('yggdrasil.error.no_access_token'));
  if (response.selectedProfile) {
    return {
      status: 'complete',
      account: accountFromResponse(provider, identifier, response, returnedClientToken),
    };
  }
  const profiles = (response.availableProfiles ?? []).map(cleanProfile).filter((profile): profile is YggdrasilProfileChoice => !!profile);
  if (!profiles.length) throw new Error(t('yggdrasil.error.no_profiles'));
  if (profiles.length === 1) {
    return {
      status: 'complete',
      account: await selectSingleProfile(provider, identifier, accessToken, returnedClientToken, profiles[0], response.user),
    };
  }
  const challengeId = crypto.randomUUID();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  pendingProfiles.set(challengeId, {
    provider,
    identifier,
    accessToken,
    clientToken: returnedClientToken,
    profiles,
    user: response.user,
    expiresAt,
  });
  return { status: 'select-profile', challengeId, providerName: provider.name, profiles, expiresAt };
}

export async function completeProfileSelection(challengeId: string, profileIdValue: string): Promise<Account> {
  const pending = pendingProfiles.get(challengeId);
  pendingProfiles.delete(challengeId);
  if (!pending || pending.expiresAt < Date.now()) throw new Error(t('yggdrasil.error.selection_expired'));
  const profileId = profileIdValue.replace(/-/g, '').toLowerCase();
  const profile = pending.profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(t('yggdrasil.error.profile_not_in_response'));
  return await selectSingleProfile(pending.provider, pending.identifier, pending.accessToken, pending.clientToken, profile, pending.user);
}

async function validateCredentials(account: Account, provider: YggdrasilProvider): Promise<boolean> {
  if (!account.accessToken || !account.clientToken) return false;
  const response = await fetch(endpointUrl(provider.authServer, 'validate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ accessToken: account.accessToken, clientToken: account.clientToken }),
    redirect: 'error',
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  return response.status === 204;
}

export async function refreshAccount(account: Account): Promise<Account> {
  if (account.type !== 'yggdrasil' || !account.providerId) throw new Error(t('yggdrasil.error.not_external_account'));
  const provider = findProvider(account.providerId);
  if (await validateCredentials(account, provider)) return account;
  if (!account.accessToken || !account.clientToken) throw new Error(t('yggdrasil.error.missing_credentials'));
  let response: YggResponse;
  try {
    response = await postYgg(endpointUrl(provider.authServer, 'refresh'), {
      accessToken: account.accessToken,
      clientToken: account.clientToken,
      requestUser: true,
    });
  } catch (error) {
    throw new Error(t('yggdrasil.error.refresh_failed', { error: error instanceof Error ? error.message : String(error) }));
  }
  const refreshed = accountFromResponse(provider, account.loginIdentifier ?? account.username, response, account.clientToken);
  if (refreshed.uuid !== account.uuid) throw new Error(t('yggdrasil.error.refresh_profile_mismatch'));
  return { ...account, ...refreshed, id: account.id };
}

export async function invalidateAccount(account: Account): Promise<void> {
  if (account.type !== 'yggdrasil' || !account.providerId || !account.accessToken || !account.clientToken) {
    return;
  }
  try {
    const provider = findProvider(account.providerId);
    await postYgg(endpointUrl(provider.authServer, 'invalidate'), {
      accessToken: account.accessToken,
      clientToken: account.clientToken,
    });
  } catch {
    // 本地退出必须始终可用；远端令牌会自然失效或由用户在皮肤站撤销。
  }
}

function metadataCacheFile(provider: YggdrasilProvider): string {
  return path.join(metadataDirectory(), `${provider.id}.json`);
}

export async function providerMetadata(provider: YggdrasilProvider): Promise<string> {
  try {
    const fetched = await fetchMetadataAt(provider.apiRoot, provider.insecure);
    cacheMetadata(provider.id, fetched.raw);
    return fetched.raw;
  } catch (error) {
    try {
      const cached = fs.readFileSync(metadataCacheFile(provider), 'utf-8');
      parseMetadata(cached);
      return cached;
    } catch {
      throw new Error(
        t('yggdrasil.error.metadata_unavailable', {
          provider: provider.name,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function cleanArtifact(value: unknown): InjectorArtifact | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<InjectorArtifact>;
  const sha256 = String(item.checksums?.sha256 ?? '').toLowerCase();
  const downloadUrl = String(item.download_url ?? '');
  let url: URL;
  try {
    url = new URL(downloadUrl);
  } catch {
    return null;
  }
  if (
    !Number.isInteger(item.build_number) ||
    !String(item.version ?? '').trim() ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    url.protocol !== 'https:' ||
    !['authlib-injector.yushi.moe', 'bmclapi2.bangbang93.com'].includes(url.hostname)
  ) {
    return null;
  }
  return {
    build_number: Number(item.build_number),
    version: String(item.version),
    download_url: url.toString(),
    checksums: { sha256 },
  };
}

function artifactManifestFile(): string {
  return path.join(injectorDirectory(), 'current.json');
}

function artifactJarPath(artifact: InjectorArtifact): string {
  const version = artifact.version.replace(/[^0-9A-Za-z._-]/g, '_');
  return path.join(injectorDirectory(), `authlib-injector-${version}-${artifact.build_number}.jar`);
}

function validCachedArtifact(): string | null {
  try {
    const artifact = cleanArtifact(JSON.parse(fs.readFileSync(artifactManifestFile(), 'utf-8')));
    if (!artifact) return null;
    const jar = artifactJarPath(artifact);
    if (!fs.existsSync(jar) || sha256File(jar) !== artifact.checksums.sha256) return null;
    return jar;
  } catch {
    return null;
  }
}

async function fetchInjectorArtifact(): Promise<InjectorArtifact> {
  const official = 'https://authlib-injector.yushi.moe/artifact/latest.json';
  const bmcl = 'https://bmclapi2.bangbang93.com/mirrors/authlib-injector/artifact/latest.json';
  const sources = getSettings().mirror === 'bmclapi' ? [bmcl, official] : [official, bmcl];
  const errors: string[] = [];
  for (const source of sources) {
    try {
      const response = await fetch(source, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const artifact = cleanArtifact(JSON.parse(await responseTextLimited(response, 128 * 1024)));
      if (!artifact) throw new Error(t('yggdrasil.error.artifact_untrusted'));
      return artifact;
    } catch (error) {
      errors.push(`${new URL(source).hostname}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(t('yggdrasil.error.injector_fetch_failed', { errors: errors.join(t('common.list_separator')) }));
}

async function downloadInjector(): Promise<string> {
  const cached = validCachedArtifact();
  if (cached) return cached;
  const artifact = await fetchInjectorArtifact();
  fs.mkdirSync(injectorDirectory(), { recursive: true });
  const jar = artifactJarPath(artifact);
  if (fs.existsSync(jar) && sha256File(jar) === artifact.checksums.sha256) {
    fs.writeFileSync(artifactManifestFile(), JSON.stringify(artifact, null, 2), 'utf-8');
    return jar;
  }
  const response = await fetch(artifact.download_url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(t('yggdrasil.error.injector_download_http', { status: response.status }));
  const finalDownloadUrl = new URL(response.url || artifact.download_url);
  if (
    finalDownloadUrl.protocol !== 'https:' ||
    !['authlib-injector.yushi.moe', 'bmclapi2.bangbang93.com'].includes(finalDownloadUrl.hostname)
  ) {
    throw new Error(t('yggdrasil.error.injector_redirect'));
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_AGENT_BYTES) throw new Error(t('yggdrasil.error.injector_size'));
  const bytes = await responseBufferLimited(response, MAX_AGENT_BYTES);
  if (!bytes.length || bytes.length > MAX_AGENT_BYTES) throw new Error(t('yggdrasil.error.injector_size'));
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== artifact.checksums.sha256) throw new Error(t('yggdrasil.error.injector_checksum'));
  const temp = `${jar}.${process.pid}.part`;
  try {
    fs.writeFileSync(temp, bytes);
    fs.copyFileSync(temp, jar);
    fs.writeFileSync(artifactManifestFile(), JSON.stringify(artifact, null, 2), 'utf-8');
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return jar;
}

export async function ensureAuthlibInjector(): Promise<string> {
  if (!injectorPromise) injectorPromise = downloadInjector().finally(() => (injectorPromise = null));
  return await injectorPromise;
}

export async function runtimeInfo(): Promise<YggdrasilRuntimeInfo> {
  const jar = await ensureAuthlibInjector();
  const artifact = cleanArtifact(JSON.parse(fs.readFileSync(artifactManifestFile(), 'utf-8')));
  if (!artifact) throw new Error(t('yggdrasil.error.injector_manifest_corrupt'));
  const actual = sha256File(jar);
  if (actual !== artifact.checksums.sha256) throw new Error(t('yggdrasil.error.injector_local_checksum'));
  return {
    path: jar,
    version: artifact.version,
    buildNumber: artifact.build_number,
    sha256: actual,
  };
}

export async function launchArguments(account: Account): Promise<string[]> {
  if (account.type !== 'yggdrasil' || !account.providerId) return [];
  const provider = findProvider(account.providerId);
  const [jar, metadata] = await Promise.all([ensureAuthlibInjector(), providerMetadata(provider)]);
  return buildAuthlibInjectorArguments(jar, provider.apiRoot, metadata);
}

export async function externalProfile(account: Account): Promise<ProfileSkins> {
  if (account.type !== 'yggdrasil' || !account.providerId) throw new Error(t('yggdrasil.error.not_external_account'));
  const provider = findProvider(account.providerId);
  const profileId = account.uuid.replace(/-/g, '');
  const response = await fetch(`${endpointUrl(provider.sessionServer, `session/minecraft/profile/${profileId}`)}?unsigned=false`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) throw await readYggError(response, t('yggdrasil.error.profile_texture_failed'));
  const data = (await response.json()) as {
    name?: unknown;
    properties?: Array<{ name?: unknown; value?: unknown }>;
  };
  const textureProperty = data.properties?.find((property) => property.name === 'textures' && typeof property.value === 'string');
  let payload: {
    textures?: {
      SKIN?: { url?: unknown; metadata?: { model?: unknown } };
      CAPE?: { url?: unknown };
    };
  } = {};
  if (typeof textureProperty?.value === 'string') {
    try {
      payload = JSON.parse(Buffer.from(textureProperty.value, 'base64').toString('utf-8')) as typeof payload;
    } catch {
      throw new Error(t('yggdrasil.error.texture_invalid'));
    }
  }
  const skinUrl = typeof payload.textures?.SKIN?.url === 'string' ? payload.textures.SKIN.url : undefined;
  const capeUrl = typeof payload.textures?.CAPE?.url === 'string' ? payload.textures.CAPE.url : undefined;
  return {
    username: typeof data.name === 'string' ? data.name : account.username,
    skins:
      skinUrl && isAllowedTextureUrl(skinUrl, provider)
        ? [
            {
              url: skinUrl,
              variant: payload.textures?.SKIN?.metadata?.model === 'slim' ? 'slim' : 'classic',
              state: 'ACTIVE',
            },
          ]
        : [],
    capes: capeUrl && isAllowedTextureUrl(capeUrl, provider) ? [{ id: 'external', alias: provider.name, active: true, url: capeUrl }] : [],
  };
}
