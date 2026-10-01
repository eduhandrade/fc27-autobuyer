const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

const noWait = () => Promise.resolve();
const S = { delayMin: 0, delayMax: 0 };
const target = { kind: 'player', criteria: { type: 'player', zone: 'defense', maxBuy: 999 }, maxBuy: 1 };
const card = (tradeId, extra) => Object.assign({ tradeId, kind: 'player', position: 'CB', positions: ['CB'], expires: 100,
  currentBid: 0, startingBid: 500, buyNow: 9000, name: 'Zagueiro ' + tradeId, rating: 80, raw: { tradeId } }, extra);

function fakeAdapter(rounds, bidResult) {
  const calls = { search: [], bids: [] };
  let n = 0;
  return {
    calls,
    getCoins: () => 100000,
    async search(c) { calls.search.push(c); return rounds[Math.min(n++, rounds.length - 1)]; },
    async buy(raw, amount) { calls.bids.push([raw.tradeId, amount]); return bidResult ? bidResult(raw) : { success: true, status: 200 }; },
  };
}

test('lances em massa: dá lances até o número pedido, usando filtro de lance máximo', async () => {
  const ad = fakeAdapter([
    { success: true, status: 200, items: [card(1), card(2, { currentBid: 900 }), card(3, { position: 'ST', positions: ['ST'] })] },
    { success: true, status: 200, items: [card(1), card(4, { expires: 50 })] },
  ]);
  const logs = [];
  const r = await ab.runBulkBids({ adapter: ad, plan: { target, maxBid: 1000, maxBids: 3, maxExpires: 0 }, settings: S, log: (m) => logs.push(m), wait: noWait });
  assert.deepEqual(ad.calls.bids, [[1, 500], [2, 950], [4, 500]]);
  assert.equal(r.bids, 3);
  assert.equal(r.coinsCommitted, 1950);
  assert.equal(r.stopReason, 'número de lances atingido');
  assert.equal(ad.calls.search[0].maxBid, 1000);
  assert.equal(ad.calls.search[0].maxBuy, undefined);
  assert.equal(ad.calls.search[0].zone, 'defense');
});

test('lances em massa: simulação não dá lance', async () => {
  const ad = fakeAdapter([{ success: true, status: 200, items: [card(1), card(2)] }]);
  const logs = [];
  const r = await ab.runBulkBids({ adapter: ad, plan: { target, maxBid: 1000, maxBids: 2 }, settings: Object.assign({ dryRun: true }, S), log: (m) => logs.push(m), wait: noWait });
  assert.equal(ad.calls.bids.length, 0);
  assert.equal(r.simulated, 2);
  assert.ok(logs.some((m) => /SIMULAÇÃO: daria lance de 500/.test(m)));
});

test('lances em massa: para no captcha e conta lances perdidos', async () => {
  const ad = fakeAdapter([{ success: true, status: 200, items: [card(1), card(2), card(3)] }],
    (raw) => (raw.tradeId === 1 ? { success: false, status: 461 } : raw.tradeId === 2 ? { success: false, status: 458 } : { success: true, status: 200 }));
  const r = await ab.runBulkBids({ adapter: ad, plan: { target, maxBid: 1000, maxBids: 5 }, settings: S, log: () => {}, wait: noWait });
  assert.equal(r.missed, 1);
  assert.equal(r.bids, 0);
  assert.equal(r.stopReason, 'captcha da EA');
  assert.equal(ad.calls.bids.length, 2);
});

test('lances em massa: respeita o limite de buscas', async () => {
  const ad = fakeAdapter([{ success: true, status: 200, items: [] }]);
  const r = await ab.runBulkBids({ adapter: ad, plan: { target, maxBid: 1000, maxBids: 5, maxSearches: 3 }, settings: S, log: () => {}, wait: noWait });
  assert.equal(ad.calls.search.length, 3);
  assert.equal(r.stopReason, 'limite de buscas atingido');
});

test('confere lances: cartas ganhas vão para a lista e para o registro', async () => {
  const moved = [];
  const ledger = {};
  const ad = {
    async pile(which) {
      assert.equal(which, 'watch');
      return { success: true, items: [
        { id: 7, name: 'Ganha', rating: 80, tradeState: 'closed', bidState: 'highest', currentBid: 1500, raw: { id: 7 } },
        { id: 8, name: 'Perdida', tradeState: 'closed', bidState: 'outbid', currentBid: 3000, raw: { id: 8 } },
        { id: 9, name: 'Ganhando', tradeState: 'active', bidState: 'highest', currentBid: 900, raw: { id: 9 } },
      ] };
    },
    async moveToTransferList(raw) { moved.push(raw.id); return { success: true }; },
  };
  const r = await ab.collectWonBids({ adapter: ad, ledger, log: () => {}, settings: {} });
  assert.equal(r.ganhou, 1);
  assert.equal(r.perdeu, 1);
  assert.equal(r.ganhando, 1);
  assert.deepEqual(moved, [7]);
  assert.equal(ledger.i7.cost, 1500);
  assert.equal(ledger.i7.source, 'lance');
  assert.equal(ledger.i8, undefined);
});

test('venda em massa: anuncia só a quantidade escolhida e atualiza o registro', async () => {
  const listed = [];
  const ledger = { i1: { cost: 500, status: 'na lista' }, i2: { cost: 600, status: 'na lista' } };
  const group = { items: [{ id: 1, name: 'B', raw: { id: 1 } }, { id: 2, name: 'B', raw: { id: 2 } }, { id: 3, name: 'B', raw: { id: 3 } }] };
  const ad = { async list(raw, start, bin, dur) { listed.push([raw.id, start, bin, dur]); return { success: true }; } };
  const r = await ab.runBulkSell({ adapter: ad, orders: [{ group, qty: 2, bin: 1200, start: 1100, duration: 3600 }], ledger, settings: {}, log: () => {}, wait: noWait });
  assert.deepEqual(listed, [[1, 1100, 1200, 3600], [2, 1100, 1200, 3600]]);
  assert.equal(r.listed, 2);
  assert.equal(ledger.i1.status, 'à venda');
  assert.equal(ledger.i1.listedFor, 1200);
  const sim = await ab.runBulkSell({ adapter: ad, orders: [{ group, qty: 3, bin: 1200, start: 1100 }], ledger, settings: { dryRun: true }, log: () => {}, wait: noWait });
  assert.equal(sim.simulated, 3);
  assert.equal(listed.length, 2);
});
