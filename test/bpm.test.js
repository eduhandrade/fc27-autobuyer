const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

test('backup: copia e restaura todos os dados', () => {
  const state = { settings: { dryRun: true }, ledger: { i1: { itemId: 1, name: 'Ção', cost: 900 } }, targets: [{ id: 't', kind: 'player', criteria: {} }] };
  const code = ab.encodeBackup(state);
  assert.ok(code.startsWith('FCAB-BKP1:'));
  const r = ab.decodeBackup('nota:\n' + code + '\n');
  assert.equal(r.data.ledger.i1.name, 'Ção');
  assert.ok(r.data.backupAt > 0);
  assert.match(ab.decodeBackup('xyz').error, /não achei/);
  assert.match(ab.decodeBackup('FCAB-BKP1:###').error, /corrompido|não parece/);
  const mem = {};
  const store = ab.createStore({ getItem: (k) => mem[k] || null, setItem: (k, v) => { mem[k] = v; } });
  const loaded = store.restore(r.data);
  assert.equal(loaded.ledger.i1.cost, 900);
  assert.equal(loaded.settings.dryRun, true);
  assert.equal(JSON.parse(Object.values(mem)[0]).backupAt, undefined);
});

test('BPM: reconhece pedidos de pacote e resume sem tokens', () => {
  assert.ok(ab.isPackUrl('https://utas.mob.v4.prd.futc-ext.gcp.ea.com/ut/game/fc27/store/purchaseGroup/all', 'GET'));
  assert.ok(ab.isPackUrl('/ut/game/fc27/purchased/items', 'POST'));
  assert.ok(!ab.isPackUrl('/ut/game/fc27/purchased/items', 'GET'));
  assert.ok(!ab.isPackUrl('/ut/game/fc27/tradepile', 'GET'));
  assert.ok(!ab.isPackUrl('/ut/game/fc27/transfermarket?type=player', 'GET'));
  const c = ab.summarizePackCapture('post', 'https://x.ea.com/ut/game/fc27/purchased/items?sid=SECRET&a=1', 200, '{"packId":100,"currency":"COINS"}',
    JSON.stringify({ itemData: [{ id: 1, resourceId: 5, rating: 64 }, { id: 2, resourceId: 6, rating: 60 }], credits: 1000 }));
  assert.equal(c.method, 'POST');
  assert.ok(!/SECRET/.test(c.path));
  assert.equal(c.items, 2);
  assert.deepEqual(c.keys, ['itemData', 'credits']);
  assert.match(c.request, /packId/);
});
