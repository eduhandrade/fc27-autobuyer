const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

const FAST = { delayMin: 0, delayMax: 0, pauseEvery: 0, maxSearches: 20, maxBuys: 0, budget: 0 };

function setup({ targets, settings, buyResult }) {
  let trade = 0;
  const buys = [];
  const logs = [];
  let saved = 0;
  const e = new ab.Autobuyer({
    adapter: {
      getCoins: () => 1e6,
      async search(c) {
        return { success: true, status: 200, items: [{ tradeId: ++trade, buyNow: 1000, kind: 'player', name: 'J' + c.maskedDefId, raw: { c } }] };
      },
      async buy(raw) { buys.push(raw.c.maskedDefId); return buyResult ? buyResult(buys.length) : { success: true, status: 200 }; },
      async list() { return { success: true, status: 200 }; },
    },
    getState: () => ({ settings: Object.assign({}, FAST, settings), targets }),
    log: (m) => logs.push(m),
    onTargetsChanged: () => { saved++; },
  });
  return { e, buys, logs, saved: () => saved };
}

const t = (id, extra) => Object.assign({ id, name: 'Alvo ' + id, kind: 'player', enabled: true, maxBuy: 5000,
  criteria: { type: 'player', maskedDefId: id } }, extra);

test('para de comprar um alvo ao atingir a quantidade e desliga o alvo', async () => {
  const a = t(1, { maxCount: 3 });
  const { e, buys, logs, saved } = setup({ targets: [a] });
  await e.start();
  assert.deepEqual(buys, [1, 1, 1]);
  assert.equal(a.bought, 3);
  assert.equal(a.enabled, false);
  assert.equal(e.stopReason, 'quantidade de compras dos alvos atingida');
  assert.ok(logs.some((m) => /concluído: 3 de 3 comprado/.test(m)));
  assert.equal(saved(), 3);
});

test('outros alvos continuam depois que um conclui', async () => {
  const a = t(1, { maxCount: 1 });
  const b = t(2, { maxCount: 2 });
  const { e, buys } = setup({ targets: [a, b] });
  await e.start();
  assert.deepEqual(buys, [1, 2, 2]);
  assert.equal(a.bought, 1);
  assert.equal(b.bought, 2);
});

test('compra perdida não conta na quantidade', async () => {
  const a = t(1, { maxCount: 2 });
  const { e, buys } = setup({ targets: [a], buyResult: (n) => (n === 1 ? { success: false, status: 461 } : { success: true, status: 200 }) });
  await e.start();
  assert.equal(buys.length, 3);
  assert.equal(a.bought, 2);
});

test('contagem continua de onde parou e sem limite não para', async () => {
  const a = t(1, { maxCount: 5, bought: 4 });
  const { e, buys } = setup({ targets: [a] });
  await e.start();
  assert.equal(buys.length, 1);
  const free = t(2);
  const r = setup({ targets: [free], settings: { maxSearches: 4 } });
  await r.e.start();
  assert.equal(r.buys.length, 4);
  assert.equal(free.bought, 4);
  assert.equal(free.enabled, true);
});

test('simulação respeita a quantidade sem mexer na contagem real', async () => {
  const a = t(1, { maxCount: 2 });
  const { e, buys, logs } = setup({ targets: [a], settings: { dryRun: true } });
  await e.start();
  assert.equal(buys.length, 0);
  assert.equal(e.stats.simulated, 2);
  assert.equal(a.bought, undefined);
  assert.equal(a.enabled, true);
  assert.ok(logs.some((m) => /\[2 de 2\]/.test(m)));
  assert.equal(e.stopReason, 'quantidade de compras dos alvos atingida');
});

test('rótulos de progresso', () => {
  assert.equal(ab.countLabel({ maxCount: 5, bought: 2 }), '2 de 5 comprado(s)');
  assert.equal(ab.countLabel({}), '0 comprado(s) · sem limite');
  assert.equal(ab.targetDone({ maxCount: 2, bought: 2 }), true);
  assert.equal(ab.targetDone({ maxCount: 0, bought: 9 }), false);
  assert.equal(ab.targetRemaining({ maxCount: 5, bought: 2 }), 3);
});
