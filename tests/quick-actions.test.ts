import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { GameSession } from '../src/main/core/gameSession';
import { buildCommandWorldData } from '../src/main/core/commandWorld';
import { parseNbt } from '../src/main/core/nbt';

test('command world uses actual data version, creative and commands, both storage generations', () => {
  for (const [id, dv, modern] of [
    ['1.20.1', 3465, false],
    ['26.2', 4903, true],
  ] as const) {
    const data = parseNbt(buildCommandWorldData({ id, world_version: dv, stable: true }, 'Test', 9223372036854775807n, modern)).Data as any;
    assert.equal(data.DataVersion, dv);
    assert.equal(data.Version.Name, id);
    assert.equal(data.allowCommands, 1);
    assert.equal(data.GameType, 1);
    assert.deepEqual(data.DataPacks.Enabled, ['vanilla']);
    if (!modern) assert.equal(data.WorldGenSettings.seed, '9223372036854775807');
    else {
      assert.equal(data.WorldGenSettings, undefined);
      assert.equal(data.difficulty_settings.difficulty, 'easy');
    }
  }
});

test('graceful close never kills on failure/timeout; only actual close resolves and releases ownership', async () => {
  const session = new GameSession(),
    child = new EventEmitter() as ChildProcess;
  let kills = 0,
    requests = 0;
  child.kill = () => {
    kills++;
    return true;
  };
  const token = session.reserve('same instance');
  session.attach(token, child);
  await assert.rejects(
    session.stopGracefully(async () => {
      requests++;
      throw new Error('not responsive');
    }, 15),
    /超时/
  );
  assert.equal(kills, 0);
  assert.equal(requests, 1);
  assert(session.busy);
  assert.equal(child.listenerCount('close'), 0);
  const pending = session.stopGracefully(async () => {
    requests++;
  }, 100);
  assert(session.busy);
  session.release(token);
  child.emit('close', 0);
  await pending;
  assert.equal(kills, 0);
  assert.equal(requests, 2);
  assert(!session.busy);
  assert.equal(child.listenerCount('close'), 0);
});
