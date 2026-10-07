const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

test('registro: compra do bot e venda pela lista de transferências', () => {
  const ledger = {};
  ab.recordBuy(ledger, { itemId: 10, name: 'Van Dijk', rating: 90, price: 20000, at: 1 });
  let ch = ab.syncLedger(ledger, [{ id: 10, name: 'Van Dijk', tradeState: 'active', buyNow: 25000 }], 2);
  assert.equal(ledger.i10.status, 'à venda');
  assert.equal(ledger.i10.listedFor, 25000);
  assert.equal(ch.sold.length, 0);
  ch = ab.syncLedger(ledger, [{ id: 10, name: 'Van Dijk', tradeState: 'closed', buyNow: 25000, currentBid: 25000 }], 3);
  assert.equal(ledger.i10.status, 'vendida');
  assert.equal(ledger.i10.soldFor, 25000);
  assert.equal(ch.sold.length, 1);
  // 25.000 - 5% da EA = 23.750; lucro 3.750
  assert.equal(ab.entryProfit(ledger.i10), 3750);
  // Venda registrada não muda se o item aparecer de novo.
  ab.syncLedger(ledger, [{ id: 10, tradeState: 'active', buyNow: 1 }], 4);
  assert.equal(ledger.i10.status, 'vendida');
});

test('registro: compras antigas entram pelo "Item bought for"', () => {
  const ledger = {};
  const ch = ab.syncLedger(ledger, [
    { id: 1, name: 'Wirtz', rating: 86, lastSalePrice: 12750, tradeState: null },
    { id: 2, name: 'Cucurella', rating: 86, lastSalePrice: 0, tradeState: 'expired', buyNow: 9000 },
    { id: 3, name: 'Leilão', lastSalePrice: 3000, tradeState: 'closed', currentBid: 4000, buyNow: 6000 },
  ], 5, 'unassigned');
  assert.equal(ch.added, 3);
  assert.equal(ledger.i1.cost, 12750);
  assert.equal(ledger.i1.status, 'na lista');
  assert.equal(ledger.i2.status, 'expirada');
  assert.equal(ledger.i2.cost, 0);
  // Vendido em leilão: vale o lance final, não o "compre já".
  assert.equal(ledger.i3.soldFor, 4000);
  assert.equal(ab.entryProfit(ledger.i3), 800);
  const sum = ab.ledgerSummary(ledger);
  assert.deepEqual(sum, { soldCount: 1, revenue: 3800, soldCost: 3000, profit: 800, openCount: 2, openCost: 12750, unknownCost: 1, boughtCount: 0, boughtCost: 0 });
});

test('registro: carta do clube mandada para a lista não conta no lucro', () => {
  const ledger = {};
  ab.syncLedger(ledger, [{ id: 7, name: 'Wirtz', rating: 89, lastSalePrice: 60000, tradeState: 'closed', buyNow: 40000 }], 5, 'transfer');
  assert.equal(ledger.i7.ignored, true);
  assert.equal(ab.ledgerSummary(ledger).profit, 0);
  assert.equal(ab.ledgerSummary(ledger).soldCount, 0);
  assert.deepEqual(ab.dailyProfit(ledger), []);
  // Compra do bot sempre conta, mesmo aparecendo depois na lista.
  ab.recordBuy(ledger, { itemId: 8, name: 'Kane', price: 25000, source: 'bot', at: 1 });
  ab.syncLedger(ledger, [{ id: 8, name: 'Kane', tradeState: 'closed', buyNow: 27250 }], 6, 'transfer');
  assert.equal(ab.ledgerSummary(ledger).soldCount, 1);
  // Comprada à mão: aparece em Não atribuídos e passa a contar.
  ab.syncLedger(ledger, [{ id: 9, name: 'X', lastSalePrice: 1000 }], 7, 'transfer');
  assert.equal(ledger.i9.ignored, true);
  ab.syncLedger(ledger, [{ id: 9, name: 'X', lastSalePrice: 1000 }], 8, 'unassigned');
  assert.equal(ledger.i9.ignored, false);
});

test('registro antigo: só as compras do bot continuam contando', () => {
  const ledger = ab.migrateLedger({
    i1: { itemId: 1, source: 'web app', cost: 60000, status: 'vendida', soldFor: 40000 },
    i2: { itemId: 2, source: 'bot', cost: 1000, status: 'vendida', soldFor: 2000 },
  });
  assert.equal(ledger.i1.ignored, true);
  assert.ok(!ledger.i2.ignored);
  assert.equal(ab.ledgerSummary(ledger).profit, 900);
});

test('configurações antigas: sem limite de compras e 600 buscas', () => {
  const mem = { 'fc27-autobuyer:v1': JSON.stringify({ settings: { maxSearches: 300, maxBuys: 10 } }) };
  const store = ab.createStore({ getItem: (k) => mem[k] || null, setItem: (k, v) => { mem[k] = v; } });
  const st = store.load();
  assert.equal(st.settings.maxSearches, 600);
  assert.equal(st.settings.maxBuys, 0);
  const mem2 = { 'fc27-autobuyer:v1': JSON.stringify({ settings: { maxSearches: 1000, v: 2 } }) };
  assert.equal(ab.createStore({ getItem: (k) => mem2[k] || null }).load().settings.maxSearches, 1000);
});

test('lances: próximo lance e cartas escolhidas', () => {
  assert.equal(ab.nextBidAmount({ currentBid: 0, startingBid: 150 }), 150);
  assert.equal(ab.nextBidAmount({ currentBid: 950, startingBid: 150 }), 1000);
  assert.equal(ab.nextBidAmount({ currentBid: 10000 }), 10250);
  const target = { kind: 'player', criteria: { type: 'player', club: 9 }, maxBuy: 99999 };
  const mk = (tradeId, extra) => Object.assign({ tradeId, kind: 'player', teamId: 9, expires: 120, currentBid: 0, startingBid: 900, buyNow: 5000 }, extra);
  const items = [
    mk(1, { expires: 300 }),
    mk(2, { expires: 30, currentBid: 2000 }),
    mk(3, { expires: 60, bidState: 'highest' }),
    mk(4, { expires: 90, teamId: 1 }),
    mk(5, { expires: 45, tradeOwner: true }),
    mk(6, { expires: 50, currentBid: 4900 }),
    mk(7, { expires: 20 }),
  ];
  const skipped = [];
  const plan = ab.planBids(items, { maxBid: 2500, maxBids: 5, maxExpires: 200, target }, { coins: 10000, onSkip: (it, why) => skipped.push([it.tradeId, why]) });
  assert.deepEqual(plan.map((p) => [p.item.tradeId, p.amount]), [[7, 900], [2, 2100]]);
  assert.deepEqual(skipped, [
    [5, 'anúncio seu'],
    [6, 'lance necessário 5.000 passa do máximo'],
    [3, 'você já é o maior lance'],
    [4, 'time diferente'],
    [1, 'termina tarde demais'],
  ]);
  // Limite de lances: para de olhar depois de atingir.
  assert.equal(ab.planBids(items, { maxBid: 2500, maxBids: 1, target }, { coins: 10000 }).length, 1);
  // Moedas acabam: para de planejar.
  const poor = ab.planBids(items, { maxBid: 2500, maxBids: 10, target }, { coins: 1000 });
  assert.deepEqual(poor.map((p) => p.item.tradeId), [7]);
  assert.equal(ab.bidProblem(mk(8, { teamId: 1 }), { maxBid: 5000, target }), 'time diferente');
});

test('situação dos lances na lista de observação', () => {
  assert.equal(ab.watchStatus({ tradeState: 'closed', bidState: 'highest' }), 'ganhou');
  assert.equal(ab.watchStatus({ tradeState: 'closed', bidState: 'outbid' }), 'perdeu');
  assert.equal(ab.watchStatus({ tradeState: 'active', bidState: 'highest' }), 'ganhando');
  assert.equal(ab.watchStatus({ tradeState: 'active', bidState: 'outbid' }), 'superado');
});

test('venda: agrupa cartas iguais e calcula preço e lucro', () => {
  const ledger = { i1: { cost: 500 }, i2: { cost: 700 } };
  const items = [
    { id: 1, name: 'Bronze A', rating: 85, definitionId: 50, tradeState: null, marketAverage: 1200, minPrice: 200, maxPrice: 10000 },
    { id: 2, name: 'Bronze A', rating: 85, definitionId: 50, tradeState: 'expired' },
    { id: 3, name: 'Bronze A', rating: 85, definitionId: 50, tradeState: 'active' },
    { id: 4, name: 'Outra', rating: 70, definitionId: 60, tradeState: null, lastSalePrice: 300 },
    { id: 5, name: 'Presa', rating: 70, definitionId: 70, tradeState: null, untradeable: true },
  ];
  const groups = ab.groupSellable(items, ledger);
  assert.deepEqual(groups.map((g) => [g.name, g.count, g.avgCost]), [['Bronze A', 2, 600], ['Outra', 1, 300]]);
  const g = groups[0];
  assert.equal(g.marketAverage, 1200);
  assert.deepEqual(ab.sellPrices(g, 1234, 0), { bin: 1200, start: 1100, notes: [], profitPerCard: 1140 - 600 });
  assert.equal(ab.sellPrices(g, 20000, 0).bin, 10000);
  assert.match(ab.sellPrices(g, 150, 0).error, /mínimo/);
  assert.equal(ab.sellPrices(g, 1200, 1200).start, 1100);
});

test('lances: mínimo escolhido e lance exato', () => {
  const it = (extra) => Object.assign({ tradeId: 1, kind: 'player', expires: 60, currentBid: 0, startingBid: 150, buyNow: 5000 }, extra);
  assert.equal(ab.bidAmountFor(it(), { maxBid: 2000 }), 150);
  assert.equal(ab.bidAmountFor(it(), { maxBid: 2000, minBid: 1500 }), 1500);
  assert.equal(ab.bidAmountFor(it({ currentBid: 1600 }), { maxBid: 2000, minBid: 1500 }), 1700);
  // Mínimo = máximo: sempre o valor exato; se já passou, não dá lance.
  assert.equal(ab.bidAmountFor(it(), { maxBid: 1800, minBid: 1800 }), 1800);
  assert.match(ab.bidProblem(it({ currentBid: 1800 }), { maxBid: 1800, minBid: 1800 }), /passa do máximo/);
  const picks = ab.planBids([it(), it({ tradeId: 2, currentBid: 1700 })], { maxBid: 1800, minBid: 1800, maxBids: 5 });
  assert.deepEqual(picks.map((p) => [p.item.tradeId, p.amount]), [[1, 1800], [2, 1800]]);
  // Mínimo que chega no compre já: pula.
  assert.match(ab.bidProblem(it({ buyNow: 1800 }), { maxBid: 2000, minBid: 1800 }), /compra imediata/);
});
