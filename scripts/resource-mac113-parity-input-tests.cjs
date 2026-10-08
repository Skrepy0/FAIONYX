// Pure QA guards; these are not native focus or native App evidence.
const test = require('node:test'),
  assert = require('node:assert/strict');
const { assertEditableNativeTextInput, nativeInputLayoutReady } = require('./verify-mac-parity-ui.cjs');
const observed = () => ({
  native: {
    pid: 1,
    windowId: 2,
    webContentsId: 3,
    visible: true,
    minimized: false,
    focused: true,
    bounds: { x: 0, y: 25, width: 1024, height: 684 },
    contentBounds: { x: 0, y: 25, width: 1024, height: 684 },
  },
  field: {
    exists: true,
    tag: 'INPUT',
    type: 'text',
    disabled: false,
    readOnly: false,
    inert: false,
    value: '26.3',
    hit: true,
    ancestorsVisible: true,
    runningAnimations: 0,
    bounds: { x: 300, y: 260, width: 336, height: 36 },
  },
});
test('Native parity rejects non-editable controls before attempting text replacement', () => {
  assertEditableNativeTextInput(observed().field);
  for (const [field, value] of [
    ['exists', false],
    ['tag', 'SELECT'],
    ['type', 'number'],
    ['disabled', true],
    ['readOnly', true],
    ['inert', true],
    ['value', undefined],
  ]) {
    const row = observed();
    row.field[field] = value;
    assert.throws(() => assertEditableNativeTextInput(row.field));
  }
});
test('Native parity requires actual window focus, visible hit target and settled finite animations', () => {
  const previous = observed();
  assert.equal(nativeInputLayoutReady(observed(), previous), true);
  assert.equal(nativeInputLayoutReady(observed()), false);
  for (const [area, field, value] of [
    ['native', 'visible', false],
    ['native', 'minimized', true],
    ['native', 'focused', false],
    ['field', 'hit', false],
    ['field', 'ancestorsVisible', false],
    ['field', 'runningAnimations', 1],
    ['field', 'readOnly', true],
  ]) {
    const row = observed();
    row[area][field] = value;
    assert.equal(nativeInputLayoutReady(row, previous), false);
  }
});
test('Native parity observes stable original input and owned native window geometry instead of forcing DOM positions', () => {
  const previous = observed();
  for (const field of ['x', 'y', 'width', 'height']) {
    const moving = observed();
    moving.field.bounds[field] += 1;
    assert.equal(nativeInputLayoutReady(moving, previous), false);
    moving.field.bounds[field] = NaN;
    assert.equal(nativeInputLayoutReady(moving, previous), false);
    for (const name of ['bounds', 'contentBounds']) {
      const movedWindow = observed();
      movedWindow.native[name][field] += 1;
      assert.equal(nativeInputLayoutReady(movedWindow, previous), false);
    }
  }
  for (const id of ['pid', 'windowId', 'webContentsId']) {
    const reused = observed();
    reused.native[id]++;
    assert.equal(nativeInputLayoutReady(reused, previous), false);
  }
  assert.equal(nativeInputLayoutReady(observed(), previous), true);
});
