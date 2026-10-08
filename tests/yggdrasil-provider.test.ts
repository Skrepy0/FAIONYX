import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAuthlibInjectorArguments,
  endpointUrl,
  isAllowedTextureUrl,
  normalizeYggdrasilUrl,
  parseProviderInput,
  resolveProviderEndpoints,
  serializeYggdrasilUserProperties,
} from '../src/main/core/yggdrasilProvider';
import type { YggdrasilProvider } from '../src/shared/types';

test('Yggdrasil URL defaults to HTTPS and rejects credentials or non-HTTP schemes', () => {
  assert.equal(normalizeYggdrasilUrl('littleskin.cn/api/yggdrasil'), 'https://littleskin.cn/api/yggdrasil/');
  assert.throws(() => normalizeYggdrasilUrl('https://user:pass@example.com/api'));
  assert.throws(() => normalizeYggdrasilUrl('file:///tmp/auth'));
});

test('authlib-injector drag URI and provider JSON resolve API fields', () => {
  const uri = parseProviderInput({
    kind: 'text',
    value: `authlib-injector:yggdrasil-server:${encodeURIComponent('https://skin.example/api/yggdrasil')}`,
  });
  assert.equal(uri.apiRoot, 'https://skin.example/api/yggdrasil/');

  const json = parseProviderInput({
    kind: 'text',
    value: JSON.stringify({
      schemaVersion: 1,
      providerName: 'Example Skin',
      apiRoot: 'https://skin.example/api/yggdrasil',
      authServer: 'https://auth.example/',
      accountServer: 'https://account.example/',
      sessionServer: 'https://session.example/',
      services: 'https://services.example/',
      skinDomains: ['textures.example', '*.cdn.example'],
    }),
  });
  assert.equal(json.name, 'Example Skin');
  assert.deepEqual(json.skinDomains, ['textures.example', '.cdn.example']);
  assert.equal(resolveProviderEndpoints(json).authServer, 'https://auth.example/');
  assert.equal(
    parseProviderInput({ kind: 'text', value: '[InternetShortcut]\nURL=https://skin.example/api' }).apiRoot,
    'https://skin.example/api/'
  );
  assert.equal(
    parseProviderInput({ kind: 'text', value: 'API Root: https://skin.example/yggdrasil' }).apiRoot,
    'https://skin.example/yggdrasil/'
  );
});

test('default Yggdrasil service endpoints are derived from API Root', () => {
  const parsed = parseProviderInput({ kind: 'text', value: 'https://example.com/api/yggdrasil' });
  const endpoints = resolveProviderEndpoints(parsed);
  assert.equal(endpoints.authServer, 'https://example.com/api/yggdrasil/authserver/');
  assert.equal(endpoints.accountServer, 'https://example.com/api/yggdrasil/api/');
  assert.equal(endpoints.sessionServer, 'https://example.com/api/yggdrasil/sessionserver/');
  assert.equal(endpointUrl(endpoints.authServer, 'authenticate'), 'https://example.com/api/yggdrasil/authserver/authenticate');
});

test('texture URLs are constrained by provider metadata skin domains', () => {
  const provider: YggdrasilProvider = {
    id: 'p',
    name: 'P',
    apiRoot: 'https://auth.example/',
    authServer: 'https://auth.example/authserver/',
    accountServer: 'https://auth.example/api/',
    sessionServer: 'https://auth.example/sessionserver/',
    skinDomains: ['.textures.example'],
    insecure: false,
    metadataFetchedAt: new Date(0).toISOString(),
  };
  assert.equal(isAllowedTextureUrl('https://cdn.textures.example/skin.png', provider), true);
  assert.equal(isAllowedTextureUrl('https://evil.example/skin.png', provider), false);
  assert.equal(isAllowedTextureUrl('http://cdn.textures.example/skin.png', provider), false);
});

test('Yggdrasil user properties serialize to Minecraft argument map', () => {
  assert.equal(
    serializeYggdrasilUserProperties([
      { name: 'language', value: 'zh_CN' },
      { name: 'language', value: 'en_US' },
    ]),
    '{"language":["zh_CN","en_US"]}'
  );
});

test('authlib-injector launch arguments include canonical root and exact prefetched metadata', () => {
  const metadata = '{"skinDomains":["textures.example"]}';
  const args = buildAuthlibInjectorArguments('C:\\KAMU CL\\authlib-injector.jar', 'https://auth.example/api', metadata);
  assert.equal(args[0], '-javaagent:C:\\KAMU CL\\authlib-injector.jar=https://auth.example/api/');
  assert.equal(args[1].slice(args[1].indexOf('=') + 1), Buffer.from(metadata).toString('base64'));
  assert.throws(() => buildAuthlibInjectorArguments('agent.jar', 'https://auth.example', '[]'));
});
