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
  assert.match(r.stopReason, /^captcha da EA \(código 458 no lance\)$/);
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

test('lances em massa: mostra o código e para após muitos lances recusados seguidos', async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8].map(card);
  const ad = fakeAdapter([{ success: true, status: 200, items }], () => ({ success: false, status: 461 }));
  const traces = [];
  const r = await ab.runBulkBids({ adapter: ad, plan: { target, maxBid: 1000, maxBids: 20 }, settings: S, log: () => {}, trace: (m) => traces.push(m), wait: noWait });
  assert.equal(ad.calls.bids.length, 6);
  assert.equal(r.missed, 6);
  assert.match(r.stopReason, /^6 lances recusados seguidos \(6× 461\)$/);
  assert.ok(traces.some((m) => /código 461/.test(m)));
});

test('lances em massa: um lance aceito zera a contagem de recusados', async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8].map(card);
  const ad = fakeAdapter([{ success: true, status: 200, items }, { success: true, status: 200, items: [] }],
    (raw) => (raw.tradeId === 4 ? { success: true, status: 200 } : { success: false, status: 478 }));
  const r = await ab.runBulkBids({ adapter: ad, plan: { target, maxBid: 1000, maxBids: 20, maxSearches: 2 }, settings: S, log: () => {}, wait: noWait });
  assert.equal(r.bids, 1);
  assert.equal(r.missed, 7);
  assert.equal(r.stopReason, 'limite de buscas atingido');
});

test('lances em massa: código 403 para na hora', async () => {
  const ad = fakeAdapter([{ success: true, status: 200, items: [card(1), card(2)] }], () => ({ success: false, status: 403 }));
  const r = await ab.runBulkBids({ adapter: ad, plan: { target, maxBid: 1000, maxBids: 5 }, settings: S, log: () => {}, wait: noWait });
  assert.equal(ad.calls.bids.length, 1);
  assert.match(r.stopReason, /^a EA bloqueou a ação \(código 403 no lance\)$/);
});

test('lances em massa: lista de observação cheia libera vagas ou para', async () => {
  const items = [1, 2, 3].map(card);
  const ad = fakeAdapter([{ success: true, status: 200, items }]);
  const asks = [];
  let freeNow = 1;
  const watchFree = async (clean) => { asks.push(clean); return clean ? 0 : freeNow; };
  const r = await ab.runBulkBids({ adapter: ad, plan: { target, maxBid: 1000, maxBids: 5 }, settings: S, log: () => {}, wait: noWait, watchFree });
  assert.equal(ad.calls.bids.length, 1);
  assert.deepEqual(asks, [false, true]);
  assert.match(r.stopReason, /lista de observação cheia/);
});

test('lances em massa: 403 confere a lista e continua se liberou vaga', async () => {
  let n = 0;
  const ad = fakeAdapter([{ success: true, status: 200, items: [card(1), card(2)] }], () => (n++ === 0 ? { success: false, status: 403 } : { success: true, status: 200 }));
  const asks = [];
  const watchFree = async (clean) => { asks.push(clean); return clean ? 10 : 0 + 5; };
  const r = await ab.runBulkBids({ adapter: ad, plan: { target, maxBid: 1000, maxBids: 1 }, settings: S, log: () => {}, wait: noWait, watchFree });
  assert.deepEqual(asks, [false, true]);
  assert.equal(r.bids, 1);
  assert.equal(r.stopReason, 'número de lances atingido');
});

test('confere lances: remove da lista de observação os leilões perdidos', async () => {
  const removed = [];
  const ad = {
    async pile() {
      return { success: true, items: [
        { id: 7, name: 'Ganha', tradeState: 'closed', bidState: 'highest', currentBid: 1500, raw: { id: 7 } },
        { id: 8, name: 'Perdida', tradeState: 'closed', bidState: 'outbid', currentBid: 3000, raw: { id: 8 } },
        { id: 9, name: 'Superada', tradeState: 'active', bidState: 'outbid', currentBid: 900, raw: { id: 9 } },
      ] };
    },
    async moveToTransferList() { return { success: true }; },
    async untarget(raws) { removed.push(...raws.map((x) => x.id)); return { success: true }; },
  };
  const r = await ab.collectWonBids({ adapter: ad, ledger: {}, log: () => {}, settings: {}, wait: noWait });
  assert.deepEqual(removed, [8]);
  assert.equal(r.cleared, 1);
  assert.equal(r.remaining, 1);
  removed.length = 0;
  const r2 = await ab.collectWonBids({ adapter: ad, ledger: {}, log: () => {}, settings: {}, wait: noWait, clearOutbid: true });
  assert.deepEqual(removed, [8, 9]);
  assert.equal(r2.remaining, 0);
});

test('confere lances: remove superados só dos lances do bot', async () => {
  const removed = [];
  const ad = {
    async pile() {
      return { success: true, items: [
        { id: 9, name: 'Superada bot', tradeState: 'active', bidState: 'outbid', currentBid: 900, raw: { id: 9 } },
        { id: 10, name: 'Superada manual', tradeState: 'active', bidState: 'outbid', currentBid: 900, raw: { id: 10 } },
      ] };
    },
    async untarget(raws) { removed.push(...raws.map((x) => x.id)); return { success: true }; },
  };
  const r = await ab.collectWonBids({ adapter: ad, ledger: {}, log: () => {}, settings: {}, wait: noWait, botIds: new Set(['i9']) });
  assert.deepEqual(removed, [9]);
  assert.equal(r.remaining, 1);
});

test('lances em massa: limpa a lista de observação a cada 3 buscas', async () => {
  const ad = fakeAdapter([{ success: true, status: 200, items: [] }]);
  let cleans = 0;
  const r = await ab.runBulkBids({ adapter: ad, plan: { target, maxBid: 1000, maxBids: 5, maxSearches: 7 }, settings: S, log: () => {}, wait: noWait,
    cleanWatch: async () => { cleans++; return 40; } });
  assert.equal(r.searches, 7);
  assert.equal(cleans, 2);
});

test('limpeza leve: remove perdidos e superados do bot, sem mover nada', async () => {
  const removed = [];
  const ad = {
    async pile() {
      return { success: true, items: [
        { id: 7, tradeState: 'closed', bidState: 'highest', raw: { id: 7 } },
        { id: 8, tradeState: 'closed', bidState: 'outbid', raw: { id: 8 } },
        { id: 9, tradeState: 'active', bidState: 'outbid', raw: { id: 9 } },
        { id: 10, tradeState: 'active', bidState: 'outbid', raw: { id: 10 } },
      ] };
    },
    async moveToTransferList() { throw new Error('não deveria mover'); },
    async untarget(raws) { removed.push(...raws.map((x) => x.id)); return { success: true }; },
  };
  const r = await ab.cleanWatchList({ adapter: ad, botIds: new Set(['i9']) });
  assert.deepEqual(removed, [8, 9]);
  assert.equal(r.remaining, 2);
  assert.equal(r.lost, 1);
  assert.equal(r.outbid, 1);
});

test('contagem regressiva das esperas', async () => {
  assert.equal(ab.countdownText(10500, 1000), '10 s');
  assert.equal(ab.countdownText(126000, 1000), '2:05');
  assert.equal(ab.countdownText(0, 1000), '0 s');
  assert.equal(ab.engineWaitText({ running: true, status: 'rodando', waitUntil: 9000 }, 1000), 'próxima busca em 8 s');
  assert.equal(ab.engineWaitText({ running: true, status: 'pausado', waitUntil: 61000 }, 1000), 'volta em 1:00');
  assert.equal(ab.engineWaitText({ running: false, waitUntil: 9000 }, 1000), '');
  const waits = [];
  const ad = fakeAdapter([{ success: true, status: 200, items: [] }]);
  await ab.runBulkBids({ adapter: ad, plan: { target, maxBid: 1000, maxBids: 5, maxSearches: 2 }, settings: S, log: () => {}, wait: noWait,
    onWait: (until) => waits.push(until > 0) });
  assert.deepEqual(waits, [true, false, true, false]);
});

test('confere lances: anuncia a ganha da sessão pelo ID do leilão e tenta anunciar mesmo sem conseguir mover', async () => {
  const listed = [];
  const ad = {
    async pile() {
      return { success: true, items: [
        { id: 70, tradeId: 555, name: 'Ganha', rating: 80, tradeState: 'closed', bidState: 'highest', currentBid: 1500, raw: { id: 70 } },
      ] };
    },
    async moveToTransferList() { return { success: false, status: 473 }; },
    async list(raw, start, bin) { listed.push([raw.id, start, bin]); return { success: true }; },
  };
  const traces = [];
  const r = await ab.collectWonBids({ adapter: ad, ledger: {}, log: () => {}, trace: (m) => traces.push(m), settings: {}, wait: noWait,
    sell: { bin: 2000, duration: 3600, onlyIds: new Set(['t555']) } });
  assert.deepEqual(listed, [[70, 1900, 2000]]);
  assert.equal(r.listed, 1);
  assert.ok(traces.some((m) => /anunciar direto/.test(m)));
});

test('verificação do Web App lista o que falta', () => {
  const ad = ab.createEaAdapter({ document: {}, services: { Item: { searchTransferMarket() {}, bid() {}, list() {} } } });
  const rows = ad.healthCheck();
  assert.ok(rows.length > 10);
  const missing = rows.filter((r) => !r[1] && r[2]).map((r) => r[0]);
  assert.ok(missing.some((n) => /Item.move/.test(n)));
  assert.ok(!missing.some((n) => /searchTransferMarket/.test(n)));
});

test('lances: parâmetros salvos por carta escolhida', () => {
  assert.equal(ab.bidParamKey({ id: 'abc', target: {} }), 't:abc');
  const k1 = ab.bidParamKey({ id: '__captured', target: { criteria: { type: 'player', maskedDefId: 123, level: 'any', club: -1, maxBuy: 5000 } } });
  const k2 = ab.bidParamKey({ id: '__captured', target: { criteria: { type: 'player', maskedDefId: 123, maxBid: 900 } } });
  assert.equal(k1, k2, 'mesma carta, mesma chave (preços da busca não contam)');
  assert.notEqual(k1, ab.bidParamKey({ id: '__captured', target: { criteria: { type: 'player', maskedDefId: 999 } } }));
  const store = {};
  for (let i = 0; i < 65; i++) ab.saveBidParams(store, 'k' + i, { bidMax: String(i) }, 1000 + i);
  assert.equal(Object.keys(store).length, 60);
  assert.equal(store.k64.bidMax, '64');
  assert.equal(store.k0, undefined);
});
