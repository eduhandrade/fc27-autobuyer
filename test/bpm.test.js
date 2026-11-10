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

const packJson = {
  itemList: [
    { id: 956796031755, rating: 64, itemType: 'player', assetId: 79169, resourceId: 79169, discardValue: 48, marketAverage: 198, untradeable: false },
    { id: 956796031756, rating: 60, itemType: 'manager', assetId: 1082482, resourceId: 1082482, discardValue: 30, marketAverage: 0, untradeable: false },
    { id: 956796031757, rating: 0, itemType: 'training', resourceId: 5002004, discardValue: 20, untradeable: false },
  ],
  purchasedPackId: 101,
};
const cap = (at) => ({ at, method: 'POST', path: '/ut/game/fc27/purchased/items', status: 200, request: '{"currency":"COINS","packId":101}' });

test('BPM: lê a loja e a compra do pacote de 750', () => {
  const store = ab.learnStorePacks({ purchase: [{ id: 101, coins: 750, displayGroup: { value: 'bronze' } }, { id: 5, currencies: [{ name: 'COINS', finalFunds: 25000 }] }] });
  assert.deepEqual(store[101], { coins: 750, group: 'bronze' });
  assert.equal(store[5].coins, 25000);
  const pack = ab.parsePackPurchase(cap(1000), packJson, store);
  assert.equal(pack.cost, 750);
  assert.equal(pack.items.length, 3);
  assert.ok(ab.isBpmPack(pack));
  assert.equal(ab.parsePackPurchase(Object.assign(cap(1), { method: 'GET' }), packJson, store), null);
  assert.equal(ab.isBpmPack(ab.parsePackPurchase(Object.assign(cap(1), { request: '{"currency":"COINS","packId":5}' }), packJson, store)), false);
});

test('BPM: caixa e resultado por pacote nas janelas de horas', () => {
  const H = 3600000;
  const now = 100 * H;
  const state = { ledger: { i9: { itemId: 9, source: 'bot', cost: 1000, status: 'vendida', soldFor: 2000, soldAt: now - H } }, bpm: { packs: [], store: {} } };
  const p1 = ab.parsePackPurchase(cap(now - 3 * H), packJson, { 101: { coins: 750 } });
  ab.recordBpmPack(state, p1, (id) => (id === 79169 ? 'Fulano' : ''));
  assert.equal(state.ledger.i956796031755.name, 'Fulano');
  assert.equal(state.ledger.i956796031755.ignored, true, 'fora do lucro principal');
  assert.equal(state.ledger.i956796031756.name, 'Técnico 60');
  // Vendeu o jogador por 400 há 30 min; consumível em venda rápida há 2 h; técnico à venda por 300.
  Object.assign(state.ledger.i956796031755, { status: 'vendida', soldFor: 400, soldAt: now - 0.5 * H });
  ab.markBpmQuickSell(state.ledger, '/ut/game/fc27/item?itemIds=956796031757', '', now - 2 * H);
  Object.assign(state.ledger.i956796031756, { status: 'à venda', listedFor: 300 });
  const s1 = ab.bpmSummary(state, 1, now);
  assert.equal(s1.cash.packs, 0);
  assert.equal(s1.cash.sales, 380);
  assert.equal(s1.cash.result, 380);
  assert.equal(s1.cohort.packs, 0);
  const s4 = ab.bpmSummary(state, 4, now);
  assert.equal(s4.cash.cost, 750);
  assert.equal(s4.cash.quick, 20);
  assert.equal(s4.cash.result, 380 + 20 - 750);
  assert.equal(s4.cohort.realized, 400);
  assert.equal(s4.cohort.result, -350);
  assert.equal(s4.cohort.openEstimate, 285);
  assert.equal(s4.cohort.open, 1);
  assert.equal(s4.top[0].name, 'Fulano');
  const rows = ab.bpmPackRows(state);
  assert.equal(rows[0].sold, 2);
  assert.equal(rows[0].listed, 1);
  assert.equal(rows[0].result, -350);
  // Lucro principal não muda com o BPM.
  assert.equal(ab.ledgerSummary(state.ledger).profit, 900);
  // Mesmo pacote não entra duas vezes.
  assert.equal(ab.recordBpmPack(state, p1), null);
});
