import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseDevice } from '../shared/device-selection.mjs';

const dev = (serial, selectable = true) => ({
  serial,
  state: selectable ? 'device' : 'unauthorized',
  selectable,
});

test('keeps the current selection while it is selectable', () => {
  assert.equal(chooseDevice({
    devices: [dev('A'), dev('B')], selected: 'B', remembered: 'A', preferred: 'A',
  }), 'B');
});

test('falls back to the remembered device', () => {
  assert.equal(chooseDevice({
    devices: [dev('A'), dev('B')], selected: null, remembered: 'B', preferred: 'A',
  }), 'B');
});

test('falls back to the preferred device', () => {
  assert.equal(chooseDevice({
    devices: [dev('A'), dev('B')], selected: null, remembered: null, preferred: 'A',
  }), 'A');
});

test('auto-selects the only selectable device', () => {
  assert.equal(chooseDevice({
    devices: [dev('A'), dev('B', false)], selected: null, remembered: null, preferred: null,
  }), 'A');
});

test('returns null when several devices need a choice', () => {
  assert.equal(chooseDevice({
    devices: [dev('A'), dev('B')], selected: null, remembered: null, preferred: null,
  }), null);
});

test('ignores remembered and preferred devices that are not selectable', () => {
  assert.equal(chooseDevice({
    devices: [dev('A'), dev('B', false)], selected: null, remembered: 'B', preferred: 'B',
  }), 'A');
});

test('returns null with no devices', () => {
  assert.equal(chooseDevice({
    devices: [], selected: 'A', remembered: 'A', preferred: 'A',
  }), null);
});
