const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

test('botões arrastados não saem da tela', () => {
  const size = { w: 48, h: 102 };
  const view = { w: 390, h: 844 };
  assert.deepEqual(ab.clampDock({ x: 100, y: 200 }, size, view), { x: 100, y: 200 });
  assert.deepEqual(ab.clampDock({ x: -50, y: -10 }, size, view), { x: 4, y: 4 });
  assert.deepEqual(ab.clampDock({ x: 500, y: 900 }, size, view), { x: 338, y: 738 });
});
