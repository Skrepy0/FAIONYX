// Contract tests for refusing foreign/stale game diagnostics and preserving
// failure bytes. These are not Mac execution or favorite/world acceptance.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  vm = require('node:vm'),
  { EventEmitter } = require('node:events');
const diagnostic = require('./mac-owned-game-diagnostic113.cjs');
function fixture() {
  const context = {
    instanceId: 'favorite-test',
    games: '/qa/games §',
    effectiveGameDir: '/qa/games §/versions/favorite-test',
    launchStartedAt: 1000,
    launcherPID: 20,
  };
  const spawn = {
    kind: 'original-owned-java-spawn',
    pid: 25,
    javaPath: '/qa/java/bin/java',
    effectiveGameDir: context.effectiveGameDir,
    startedAt: 1010,
    returnedAt: 1013,
    spawnedAt: 1015,
    startOnFirstThread: true,
    nativeProperties: { 'java.library.path': ['/qa/games §/versions/favorite-test/natives'] },
  };
  const states = [
    { status: 'launching', versionId: context.instanceId, folder: context.games, launchId: 'launch-1' },
    { status: 'running', versionId: context.instanceId, folder: context.games, launchId: 'launch-1' },
  ];
  return {
    context,
    record: { pid: 25, versionId: context.instanceId, effectiveGameDir: context.effectiveGameDir, startedAt: new Date(1016).toISOString() },
    spawns: [spawn],
    states,
    timeline: states.map((value, i) => ({ channel: 'event:launchState', receivedAt: i ? 1018 : 1004, value })),
    launchTrace: [
      { index: 3, channel: 'game:launch', startedAt: 1002, completedAt: 1005, arguments: [context.instanceId, null, context.games, true] },
    ],
    native: { pid: 25, ppid: 20, executable: spawn.javaPath, creationUnixUS: '1012000' },
  };
}
test('bind only actual generated instance call, original state/spawn/record and precise native creation', () => {
  const bound = diagnostic.ownedGameBinding(fixture());
  assert.equal(bound.pid, 25);
  assert.equal(bound.launchId, 'launch-1');
  assert.equal(bound.creationUnixUS, '1012000');
});
for (const [name, change] of [
  [
    'foreign raw record PID',
    (f) => {
      f.record.pid = 99;
    },
  ],
  [
    'foreign parent process',
    (f) => {
      f.native.ppid = 21;
    },
  ],
  [
    'stale PID creation',
    (f) => {
      f.native.creationUnixUS = '900000';
    },
  ],
  [
    'other executable',
    (f) => {
      f.native.executable = '/usr/bin/java';
    },
  ],
  [
    'missing original spawn',
    (f) => {
      f.spawns = [];
    },
  ],
  [
    'multiple accepted original launch calls',
    (f) => {
      f.launchTrace.push({ ...f.launchTrace[0] });
    },
  ],
  [
    'other instance cwd',
    (f) => {
      f.spawns[0].effectiveGameDir = '/someone/game';
    },
  ],
  [
    'other folder call',
    (f) => {
      f.launchTrace[0].arguments[2] = '/someone/game';
    },
  ],
  [
    'mismatched launch ID',
    (f) => {
      f.states[1].launchId = 'launch-2';
    },
  ],
  [
    'exited game',
    (f) => {
      f.states.push({ ...f.states[1], status: 'exited' });
    },
  ],
  [
    'record before process creation',
    (f) => {
      f.record.startedAt = new Date(1008).toISOString();
    },
  ],
  [
    'running event before spawn',
    (f) => {
      f.timeline[1].receivedAt = 1014;
    },
  ],
  [
    'native unavailable creation',
    (f) => {
      f.native.creationUnixUS = '';
    },
  ],
  [
    'failed accepted call',
    (f) => {
      f.launchTrace[0].error = { name: 'Error' };
    },
  ],
])
  test('refuse ' + name, () => {
    const f = fixture();
    change(f);
    assert.throws(() => diagnostic.ownedGameBinding(f));
  });
test('refuse PID reuse even with same binary and parent', () => {
  const bound = diagnostic.ownedGameBinding(fixture());
  assert.throws(() => diagnostic.sameNativeIdentity({ ...fixture().native, creationUnixUS: '9999000' }, bound));
  assert(diagnostic.sameNativeIdentity(fixture().native, bound));
});
test('read actual thin/fat architecture and reject invalid Mach-O headers', () => {
  const thin = Buffer.alloc(8);
  thin.writeUInt32LE(0xfeedfacf, 0);
  thin.writeUInt32LE(0x0100000c, 4);
  assert.deepEqual(diagnostic.machoArchitectures(thin), ['arm64']);
  const fat = Buffer.alloc(48);
  fat.writeUInt32BE(0xcafebabe, 0);
  fat.writeUInt32BE(2, 4);
  fat.writeUInt32BE(0x01000007, 8);
  fat.writeUInt32BE(0x0100000c, 28);
  assert.deepEqual(diagnostic.machoArchitectures(fat), ['x86_64', 'arm64']);
  assert.throws(() => diagnostic.machoArchitectures(Buffer.from('invalid header')));
});
test('timeout/permission results preserve original stdout/stderr and expose failure without pretending success', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-game113-contract-'));
  try {
    let called;
    const runner = diagnostic.rawRunner({
        directory: dir,
        execute: (exe, args, options, callback) => {
          called = { exe, args, options };
          const error = Object.assign(new Error('Permission denied'), { code: 'EACCES', signal: null, killed: false });
          callback(error, Buffer.from('partial output\n'), Buffer.from('original permission failure\n'));
        },
      }),
      value = await runner('threads', path.resolve('jcmd'), ['25', 'Thread.print'], { timeoutMs: 8000 });
    assert.deepEqual(called.args, ['25', 'Thread.print']);
    assert.equal(called.options.timeout, 8000);
    assert.equal(value.receipt.complete, false);
    assert.equal(value.receipt.exit.code, 'EACCES');
    assert.equal(fs.readFileSync(path.join(dir, value.receipt.stdout.file), 'utf8'), 'partial output\n');
    assert.equal(fs.readFileSync(path.join(dir, value.receipt.stderr.file), 'utf8'), 'original permission failure\n');
    assert(value.receipt.stderr.sha256);
  } finally {
    const resolved = fs.realpathSync.native(dir);
    assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
    assert(path.basename(resolved).startsWith('owned-game113-contract-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
test('signal termination preserves a null exit code in the original receipt; only a successful callback becomes zero', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-game113-contract-'));
  try {
    const error = Object.assign(new Error('Tool terminated by signal'), { code: null, signal: 'SIGKILL', killed: true }),
      stdout = Buffer.from('original partial output\n'),
      stderr = Buffer.from('original symbol processing\n');
    const failed = diagnostic.rawRunner({
      directory: dir,
      execute: (exe, args, options, callback) => {
        callback(error, stdout, stderr);
        return { pid: 25 };
      },
    });
    const value = await failed('signal-exit', path.resolve('sample'), ['25', '3'], { timeoutMs: 5000 });
    assert.equal(value.receipt.complete, false);
    assert.deepEqual(value.receipt.exit, { code: null, signal: 'SIGKILL', killed: true });
    assert.equal(value.receipt.error.code, null);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '001-signal-exit.receipt.json'), 'utf8'));
    assert.deepEqual(saved.exit, value.receipt.exit);
    assert.deepEqual(fs.readFileSync(path.join(dir, saved.stdout.file)), stdout);
    assert.deepEqual(fs.readFileSync(path.join(dir, saved.stderr.file)), stderr);
    const successful = diagnostic.rawRunner({
      directory: dir,
      execute: (exe, args, options, callback) => {
        callback(null, Buffer.alloc(0), Buffer.alloc(0));
        return { pid: 26 };
      },
    });
    const normal = await successful('successful-exit', path.resolve('sample'), ['25', '3']);
    assert.equal(normal.receipt.complete, true);
    assert.deepEqual(normal.receipt.exit, { code: 0, signal: null, killed: false });
  } finally {
    const resolved = fs.realpathSync.native(dir);
    assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
    assert(path.basename(resolved).startsWith('owned-game113-contract-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('an actual timed-out owned tool closes and its asynchronous original output remains archived', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-game113-contract-'));
  try {
    const runner = diagnostic.rawRunner({ directory: dir }),
      started = Date.now(),
      value = await runner(
        'owned-timeout',
        process.execPath,
        [
          '-e',
          "process.stdout.write('original asynchronous stdout\\n');process.stderr.write('original asynchronous stderr\\n');setInterval(()=>{},1000)",
        ],
        { timeoutMs: 500 }
      );
    assert.equal(value.receipt.complete, false);
    assert.equal(value.receipt.exit.killed, true);
    assert(Date.now() - started < 5000);
    assert.equal(fs.readFileSync(path.join(dir, value.receipt.stdout.file), 'utf8'), 'original asynchronous stdout\n');
    assert.equal(fs.readFileSync(path.join(dir, value.receipt.stderr.file), 'utf8'), 'original asynchronous stderr\n');
  } finally {
    const resolved = fs.realpathSync.native(dir);
    assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
    assert(path.basename(resolved).startsWith('owned-game113-contract-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
test('native binary readback executes in its own tool child and reports exact fixture SHA256/architectures', async () => {
  const createdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-game113-contract-')),
    dir = fs.realpathSync.native(createdRoot);
  try {
    const binaries = path.join(dir, 'binaries'),
      natives = path.join(binaries, 'natives');
    fs.mkdirSync(natives, { recursive: true });
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x0100000c, 4);
    const java = path.join(binaries, 'java'),
      dylib = path.join(natives, 'libfixture.dylib');
    fs.writeFileSync(java, bytes);
    fs.writeFileSync(dylib, bytes);
    const input = path.join(dir, 'input.json');
    fs.writeFileSync(
      input,
      JSON.stringify({
        binding: { javaPath: java, spawn: { nativeProperties: { 'java.library.path': [natives] } } },
        context: { generatedRoot: dir },
      })
    );
    const run = diagnostic.rawRunner({ directory: dir }),
      result = await run(
        'native-files',
        process.execPath,
        [path.join(__dirname, 'mac-owned-game-diagnostic113.cjs'), '--native-readback', input],
        { timeoutMs: 3000 }
      ),
      readback = JSON.parse(result.stdout);
    assert(result.receipt.complete);
    assert(Number.isSafeInteger(result.receipt.toolPID) && result.receipt.toolPID > 0);
    assert.deepEqual(readback.java.architectures, ['arm64']);
    assert.equal(
      readback.files.length,
      1,
      JSON.stringify({ synthetic: true, createdRoot, canonicalRoot: dir, readbackErrors: readback.errors })
    );
    assert.equal(readback.java.sha256, readback.files[0].sha256);
    assert.equal(readback.errors.length, 0);
  } finally {
    const resolved = fs.realpathSync.native(dir);
    assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
    assert(path.basename(resolved).startsWith('owned-game113-contract-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
test('original spawn observation retains original args/this; safe properties only; ignores foreign cwd and restores ESM exports', () => {
  const cp = {
      spawn: function (...args) {
        this.calls.push(args);
        const child = new EventEmitter();
        child.pid = 25;
        return child;
      },
      calls: [],
    },
    original = cp.spawn,
    sync = [],
    mockFs = { realpathSync: { native: (value) => value } },
    sandbox = {
      process: {
        mainModule: {
          require: (name) =>
            ({
              'node:child_process': cp,
              'node:fs': mockFs,
              'node:path': path.posix,
              'node:module': { syncBuiltinESMExports: () => sync.push(true) },
            })[name],
        },
      },
      globalThis: null,
    };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext('(' + diagnostic.installOwnedGameSpawnObserver.toString() + ')(' + JSON.stringify('/qa/game') + ')', sandbox);
  const args = [
      '-XstartOnFirstThread',
      '-Djava.library.path=/qa/game/natives',
      '--accessToken',
      'PRIVATE_TEST_TOKEN',
      '-Dunapproved=PRIVATE_TEST_PROPERTY',
    ],
    options = { cwd: '/qa/game', env: { PRIVATE_TEST_ENV: 'sensitive' } },
    child = cp.spawn('/qa/java/bin/java', args, options);
  child.emit('spawn');
  cp.spawn('/qa/java/bin/java', args, { cwd: '/other/game' });
  assert.equal(cp.calls[0][1], args);
  assert.equal(cp.calls[0][2], options);
  assert.equal(sandbox.favorite113SpawnObserver.events.length, 1);
  const serialized = JSON.stringify(sandbox.favorite113SpawnObserver.events);
  assert(!/PRIVATE_TEST|sensitive|accessToken|unapproved/.test(serialized));
  assert(serialized.includes('java.library.path'));
  const restored = vm.runInContext('(' + diagnostic.restoreOwnedGameSpawnObserver.toString() + ')()', sandbox);
  assert(restored.exactOriginalRestored);
  assert.equal(cp.spawn, original);
  assert.equal(sync.length, 2);
});
test('restore never overwrites another observer', () => {
  const cp = {
      spawn() {
        return new EventEmitter();
      },
    },
    sandbox = {
      process: {
        mainModule: {
          require: (name) =>
            ({
              'node:child_process': cp,
              'node:fs': { realpathSync: { native: (v) => v } },
              'node:path': path.posix,
              'node:module': { syncBuiltinESMExports() {} },
            })[name],
        },
      },
      globalThis: null,
    };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext('(' + diagnostic.installOwnedGameSpawnObserver.toString() + ')("/qa/game")', sandbox);
  const foreign = () => {};
  cp.spawn = foreign;
  assert.throws(() => vm.runInContext('(' + diagnostic.restoreOwnedGameSpawnObserver.toString() + ')()', sandbox));
  assert.equal(cp.spawn, foreign);
});
