import assert from 'node:assert/strict'
import test from 'node:test'
import { parseServerAddress, serverAssociationKey, supportsQuickPlayMultiplayer } from '../src/main/core/serverUtils'

test('server addresses normalize default ports, case and browser protocol', () => {
  assert.deepEqual(parseServerAddress(' Minecraft://Play.Example.COM.:25565 '), {
    host: 'play.example.com',
    port: 25565,
    explicitPort: true,
    address: 'play.example.com',
    normalizedAddress: 'play.example.com:25565',
  })
  assert.equal(parseServerAddress('play.example.com').normalizedAddress, parseServerAddress('PLAY.EXAMPLE.COM:25565').normalizedAddress)
})

test('server addresses support IPv4 and bracketed or bare IPv6', () => {
  assert.equal(parseServerAddress('127.0.0.1:25566').address, '127.0.0.1:25566')
  assert.equal(parseServerAddress('[2001:db8::1]:25566').normalizedAddress, '[2001:db8::1]:25566')
  assert.equal(parseServerAddress('2001:db8::1').address, '[2001:db8::1]')
})

test('server addresses reject paths, credentials and invalid ports', () => {
  for (const address of ['example.com/path', 'user@example.com', 'example.com:0', 'example.com:65536', '[2001:db8::1]extra']) {
    assert.throws(() => parseServerAddress(address))
  }
})

test('server association keys allow one endpoint to belong to multiple instances', () => {
  const endpoint = 'example.com:25565'
  assert.notEqual(serverAssociationKey(endpoint, '1.20.1', 'c:/one'), serverAssociationKey(endpoint, '1.20.1', 'd:/two'))
  assert.notEqual(serverAssociationKey(endpoint, '1.20.1', 'c:/one'), serverAssociationKey(endpoint, '1.21', 'c:/one'))
})

test('Quick Play multiplayer is limited to officially supported versions', () => {
  assert.equal(supportsQuickPlayMultiplayer('1.19.4'), false)
  assert.equal(supportsQuickPlayMultiplayer('1.20'), true)
  assert.equal(supportsQuickPlayMultiplayer('1.20.1'), true)
  assert.equal(supportsQuickPlayMultiplayer('1.21.11'), true)
  assert.equal(supportsQuickPlayMultiplayer('23w13a'), false)
  assert.equal(supportsQuickPlayMultiplayer('23w14a'), true)
  assert.equal(supportsQuickPlayMultiplayer('unknown'), false)
})
