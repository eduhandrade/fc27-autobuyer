const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

const FAST = { delayMin: 0, delayMax: 0, pauseEvery: 0, pauseMinutes: 0, maxSearches: 0, maxBuys: 0, budget: 0 };

function item(tradeId, buyNow) {
  return { tradeId, buyNow, name: 'Jogador ' + tradeId, raw: { tradeId } };
}

// Adaptador falso: cada busca devolve a próxima resposta da fila.
function fakeAdapter({ searches, buy, list, coins = 1e6 }) {
  const calls = { search: [], buy: [], list: [] };
  let i = 0;
  return {
    calls,
    getCoins: () => coins,
    async search(criteria) {
      calls.search.push(criteria);
      const r = searches[Math.min(i++, searches.length - 1)];
      return r;
    },
    async buy(raw, price) {
      calls.buy.push({ raw, price });
      return buy ? buy(raw, price) : { success: true, status: 200 };
    },
    async list(raw, start, bin) {
      calls.list.push({ raw, start, bin });
      return list ? list(raw) : { success: true, status: 200 };
    },
  };
}

function engine(adapter, settings, targets, purchases = []) {
  const logs = [];
  const e = new ab.Autobuyer({
    adapter,
    getState: () => ({ settings: Object.assign({}, FAST, settings), targets }),
    log: (m, l) => logs.push([l || 'info', m]),
    onPurchase: (p) => purchases.push(p),
    random: () => 0.5,
  });
  e.logs = logs;
  return e;
}

const target = (extra) => Object.assign({
  id: 't', name: 'Alvo', criteria: { type: 'player', maskedDefId: 99 }, maxBuy: 10000, sellPrice: 0, enabled: true,
}, extra);

test('compra a carta barata e revende pelo preço configurado', async () => {
  const adapter = fakeAdapter({
    searches: [{ success: true, status: 200, items: [item(1, 12000), item(2, 9500)] }, { success: true, status: 200, items: [] }],
  });
  const purchases = [];
  const e = engine(adapter, { maxBuys: 1 }, [target({ sellPrice: 12000 })], purchases);
  await e.start();
  assert.equal(adapter.calls.buy.length, 1);
  assert.equal(adapter.calls.buy[0].price, 9500);
  assert.deepEqual(adapter.calls.list[0], { raw: { tradeId: 2 }, start: 11750, bin: 12000 });
  assert.equal(e.stats.buys, 1);
  assert.equal(e.stats.spent, 9500);
  assert.equal(e.stats.profit, 11400 - 9500);
  assert.equal(purchases[0].listed, true);
  assert.equal(e.stopReason, 'limite de compras atingido');
  assert.equal(adapter.calls.search[0].maxBuy, 10000);
  assert.equal(adapter.calls.search[0].maskedDefId, 99);
});

test('para imediatamente quando a EA pede captcha', async () => {
  const adapter = fakeAdapter({ searches: [{ success: false, status: 458, items: [] }] });
  const e = engine(adapter, {}, [target()]);
  await e.start();
  assert.equal(adapter.calls.search.length, 1);
  assert.equal(e.running, false);
  assert.equal(e.stopReason, 'captcha da EA');
});

test('para quando a EA limita as buscas', async () => {
  const adapter = fakeAdapter({ searches: [{ success: false, status: 429, items: [] }] });
  const e = engine(adapter, {}, [target()]);
  await e.start();
  assert.equal(e.stopReason, 'limitado pela EA');
});

test('continua quando outro jogador compra antes e não tenta a mesma oferta de novo', async () => {
  const adapter = fakeAdapter({
    searches: [{ success: true, status: 200, items: [item(5, 5000)] }],
    buy: () => ({ success: false, status: 461 }),
  });
  const e = engine(adapter, { maxSearches: 3 }, [target()]);
  await e.start();
  assert.equal(adapter.calls.search.length, 3);
  assert.equal(adapter.calls.buy.length, 1);
  assert.equal(e.stats.missed, 1);
  assert.equal(e.stopReason, 'limite de buscas atingido');
});

test('para depois de 3 erros desconhecidos seguidos', async () => {
  const adapter = fakeAdapter({ searches: [{ success: false, status: 500, items: [] }] });
  const e = engine(adapter, {}, [target()]);
  await e.start();
  assert.equal(adapter.calls.search.length, 3);
  assert.equal(e.stopReason, '3 erros seguidos');
});

test('respeita o orçamento da sessão', async () => {
  const adapter = fakeAdapter({ searches: [{ success: true, status: 200, items: [item(1, 6000)] }, { success: true, status: 200, items: [item(2, 6000)] }] });
  const e = engine(adapter, { budget: 10000, maxSearches: 4 }, [target()]);
  await e.start();
  assert.equal(adapter.calls.buy.length, 1);
  assert.equal(e.stats.spent, 6000);
});

test('alterna entre os alvos ativos e ignora os desativados', async () => {
  const adapter = fakeAdapter({ searches: [{ success: true, status: 200, items: [] }] });
  const targets = [
    target({ id: 'a', criteria: { maskedDefId: 1 } }),
    target({ id: 'b', criteria: { maskedDefId: 2 }, enabled: false }),
    target({ id: 'c', criteria: { maskedDefId: 3 } }),
  ];
  const e = engine(adapter, { maxSearches: 4 }, targets);
  await e.start();
  assert.deepEqual(adapter.calls.search.map((c) => c.maskedDefId), [1, 3, 1, 3]);
});

test('botão parar interrompe a espera entre buscas', async () => {
  const adapter = fakeAdapter({ searches: [{ success: true, status: 200, items: [] }] });
  const e = engine(adapter, { delayMin: 60, delayMax: 60 }, [target()]);
  const done = e.start();
  await new Promise((r) => setTimeout(r, 20));
  e.stop();
  await done;
  assert.equal(adapter.calls.search.length, 1);
  assert.equal(e.stopReason, 'parado por você');
});

// Simula os objetos globais do Web App da EA.
function fakeWindow() {
  const observable = (response) => ({
    observe(scope, cb) { setTimeout(() => cb({ unobserve() {} }, response), 0); },
  });
  const calls = [];
  function UTSearchCriteriaDTO() { this.type = 'any'; }
  const win = {
    UTSearchCriteriaDTO,
    services: {
      User: { getUser: () => ({ coins: { amount: 54321 } }) },
      Item: {
        clearTransferMarketCache() { calls.push(['clear']); },
        searchTransferMarket(criteria, page) {
          calls.push(['search', criteria, page]);
          return observable({
            success: true, status: 200,
            data: { items: [{ definitionId: 10, rating: 88, _staticData: { name: 'Fulano' }, _auction: { tradeId: 77, buyNowPrice: 3000, expires: 3500 } }] },
          });
        },
        bid(raw, price) { calls.push(['bid', raw, price]); return observable({ success: false, status: 461 }); },
        list(raw, s, b, d) { calls.push(['list', s, b, d]); return observable({ success: true, status: 200 }); },
      },
    },
  };
  return { win, calls };
}

test('adaptador da EA converte chamadas e respostas', async () => {
  const { win, calls } = fakeWindow();
  const ad = ab.createEaAdapter(win);
  assert.equal(ad.ready(), true);
  assert.equal(ad.getCoins(), 54321);
  const res = await ad.search({ type: 'player', maskedDefId: 10, maxBuy: 5000 });
  assert.equal(res.success, true);
  assert.equal(res.items[0].name, 'Fulano');
  assert.equal(res.items[0].buyNow, 3000);
  assert.equal(res.items[0].tradeId, 77);
  const dto = calls.find((c) => c[0] === 'search')[1];
  assert.ok(dto instanceof win.UTSearchCriteriaDTO);
  assert.equal(dto.maskedDefId, 10);
  const buy = await ad.buy(res.items[0].raw, 3000);
  assert.deepEqual(buy, { success: false, status: 461 });
  const l = await ad.list({}, 3900, 4000);
  assert.equal(l.success, true);
  assert.deepEqual(calls.at(-1), ['list', 3900, 4000, 3600]);
  assert.ok(ad.diagnose().every(([, ok]) => ok));
});

test('captura só as buscas feitas manualmente no Web App', async () => {
  const { win } = fakeWindow();
  const ad = ab.createEaAdapter(win);
  const captured = [];
  ad.hookManualSearch((c, card) => captured.push([c, card]));
  ad.hookManualSearch((c, card) => captured.push([c, card])); // segunda chamada não duplica
  win.services.Item.searchTransferMarket({ type: 'player', maskedDefId: 42, maxBuy: 900 }, 1);
  assert.deepEqual(captured, [[{ type: 'player', maskedDefId: 42 }, null]]);
  // Quando os resultados chegam, a carta encontrada é repassada (para o FUTBIN).
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(captured[1], [{ type: 'player', maskedDefId: 42 }, { name: 'Fulano', definitionId: 10, rating: 88 }]);
  await ad.search({ type: 'player', maskedDefId: 1 });
  assert.equal(captured.length, 2);
});
