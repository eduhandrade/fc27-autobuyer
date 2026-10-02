const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

const noWait = () => Promise.resolve();
const card = { name: 'Le Tissier', definitionId: 50, rating: 85 };

// Mercado falso: lista de compre já; a busca respeita maxBuy e devolve até 20.
function market(bins, other) {
  const calls = [];
  return {
    calls,
    async search(c) {
      calls.push(c);
      const all = bins.map((b, i) => ({ tradeId: i, definitionId: 50, buyNow: b }))
        .concat((other || []).map((b, i) => ({ tradeId: 100 + i, definitionId: 999, buyNow: b })));
      const ok = all.filter((x) => !c.maxBuy || x.buyNow <= c.maxBuy);
      return { success: true, status: 200, items: ok.slice(0, 20) };
    },
  };
}

test('acha o menor compre já mesmo quando há mais de uma página', async () => {
  // 30 anúncios: a primeira página (20) não tem o mais barato.
  const bins = Array.from({ length: 30 }, (_, i) => 3000 + i * 100).reverse().concat([2300]);
  const m = market(bins);
  const r = await ab.lowestBin({ adapter: m, card, wait: noWait });
  assert.equal(r.price, 2300);
  assert.ok(r.searches >= 2 && r.searches <= 5);
  assert.equal(m.calls[0].maskedDefId, 50);
  assert.equal(m.calls[0].maxBuy, undefined);
});

test('uma busca basta quando a página vem incompleta', async () => {
  const m = market([2500, 2400, 2600]);
  const r = await ab.lowestBin({ adapter: m, card, wait: noWait });
  assert.deepEqual(r, { price: 2400, searches: 1 });
});

test('ignora outras versões da carta e informa quando não há anúncio', async () => {
  const m = market([], [500, 600]);
  const r = await ab.lowestBin({ adapter: m, card, wait: noWait });
  assert.equal(r.price, null);
});

test('para em captcha', async () => {
  const m = { async search() { return { success: false, status: 458, items: [] }; } };
  await assert.rejects(ab.lowestBin({ adapter: m, card, wait: noWait }), (e) => e.fatal && /captcha/.test(e.message));
});

test('preços ficam guardados por 10 minutos', () => {
  let t = 0;
  const c = ab.createMarketCache({ now: () => t });
  c.set(50, { price: 2400 });
  assert.equal(c.get(50).price, 2400);
  t = 9 * 60000;
  assert.equal(c.get(50).price, 2400);
  t = 11 * 60000;
  assert.equal(c.get(50), null);
  c.set(51, { state: 'checking' });
  t = 99 * 60000;
  assert.equal(c.get(51).state, 'checking');
});
