import test from 'node:test'
import assert from 'node:assert/strict'
import { certificateError, microsoftEndpoint } from '../src/main/core/microsoftTls'

test('正版认证拒绝 HTTP、凭据 URL、非官方域名与伪造子域', () => {
  for (const value of [
    'http://login.microsoftonline.com/consumers',
    'https://login.microsoftonline.com.evil.test/token',
    'https://xsts.auth.xboxlive.com:8443/x',
    'https://user:pass@api.minecraftservices.com/x',
  ])
    assert.throws(() => microsoftEndpoint(value))
  assert.equal(microsoftEndpoint('https://api.minecraftservices.com/minecraft/profile').hostname, 'api.minecraftservices.com')
})
test('证书错误显示真实错误码而不回显认证请求内容', () => {
  const error = Object.assign(new Error('secret response'), { code: 'CERT_HAS_EXPIRED' })
  assert.match(certificateError(error).message, /SSL.*CERT_HAS_EXPIRED/)
  assert.doesNotMatch(certificateError(error).message, /secret/)
})
