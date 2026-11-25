import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreSerial, canStartStream } from '../shared/device-ui.mjs';

const dev = (serial, selectable = true) => ({ serial, selectable });

test('restore waits until the remembered phone is present', () => {
  assert.equal(restoreSerial({
    remembered: 'B', devices: [], selected: 'A', attempted: null,
  }), null);
  assert.equal(restoreSerial({
    remembered: 'B', devices: [dev('A'), dev('B', false)], selected: 'A', attempted: null,
  }), null);
  assert.equal(restoreSerial({
    remembered: 'B', devices: [dev('A'), dev('B')], selected: 'A', attempted: null,
  }), 'B');
});

test('restore is attempted once per serial and skipped when already selected', () => {
  assert.equal(restoreSerial({
    remembered: 'B', devices: [dev('A'), dev('B')], selected: 'A', attempted: 'B',
  }), null);
  assert.equal(restoreSerial({
    remembered: 'B', devices: [dev('A'), dev('B')], selected: 'B', attempted: null,
  }), null);
  assert.equal(restoreSerial({ remembered: null, devices: [dev('B')], selected: null, attempted: null }), null);
});

test('a scheduled stream start is ignored after a switch or an unselection', () => {
  assert.equal(canStartStream({ serial: 'B', gen: 2, currentSerial: 'B', currentGen: 2 }), true);
  assert.equal(canStartStream({ serial: 'A', gen: 1, currentSerial: 'B', currentGen: 2 }), false);
  assert.equal(canStartStream({ serial: 'B', gen: 1, currentSerial: 'B', currentGen: 2 }), false);
  assert.equal(canStartStream({ serial: null, gen: 2, currentSerial: null, currentGen: 2 }), false);
});
