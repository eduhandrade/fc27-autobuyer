const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

test('galeria: pagar até = preço do FUT.GG − 5% e revenda no empate', () => {
  assert.equal(ab.galleryMaxBuy(1200), 1100);
  assert.equal(ab.galleryMaxBuy(10000), 9500);
  assert.equal(ab.galleryMaxBuy(0), 0);
  for (const paid of [150, 200, 900, 1100, 1150, 9500, 24750, 100000]) {
    const sell = ab.breakEvenPrice(paid);
    assert.ok(ab.netAfterTax(sell) >= paid, paid + ' → ' + sell);
    assert.ok(ab.netAfterTax(ab.prevPrice(sell)) < paid || ab.prevPrice(sell) === sell, 'menor preço possível para ' + paid);
  }
  assert.equal(ab.breakEvenPrice(900), 950);
  assert.equal(ab.breakEvenPrice(1100), 1200);
});

test('galeria: lê IDs do FUT.GG em links, imagens e na URL', () => {
  assert.equal(ab.futggDefId('/players/266304-birligea/27-266304/'), 266304);
  assert.equal(ab.futggDefId('https://game-assets.fut.gg/2027/player-item/27-50602166.abc.webp'), 50602166);
  assert.equal(ab.futggDefId('/news/27-12345/'), 0);
  const url = 'https://www.fut.gg/fut-gallery/serie-a/frosinone/?players=%5B70163%2C74533%2C50598376%5D';
  assert.deepEqual(ab.galleryIdsFromUrl(url), [70163, 74533, 50598376]);
  assert.deepEqual(ab.galleryIdsFromUrl('https://www.fut.gg/fut-gallery/serie-a/frosinone/'), []);
});

test('galeria: lê nota, nome e preço dos textos da carta', () => {
  const r = ab.readGalleryTexts(['72', 'ST', 'CAM', 'Bîrligea', 'R', '3·4', 'PAC', 'SHO', 'PAS', 'DRI', 'DEF', 'PHY', '87', '70', '61', '71', '36', '77', '35', '1.2K', '1'], 'Birligea');
  assert.deepEqual(r, { rating: 72, price: 1200, name: 'Bîrligea' });
  const gold = ab.readGalleryTexts(['85', 'RW', 'Semenyo', '2.1K', '24,750'], '');
  assert.equal(gold.price, 24750);
  assert.equal(ab.readGalleryTexts(['70', 'RB', '35'], 'Renato Sanches').name, 'Renato Sanches');
  assert.ok(ab.isGreenColor('rgb(34, 197, 94)'));
  assert.ok(!ab.isGreenColor('rgb(60, 63, 71)'));
  assert.ok(!ab.isGreenColor('rgba(34, 197, 94, 0)'));
});

test('galeria: código do FUT.GG guarda as já marcadas', () => {
  const code = ab.encodeSbc({ name: 'Frosinone', kind: 'gallery', players: [
    { definitionId: 1, name: 'A', rating: 70, price: 1200, owned: true },
    { definitionId: 2, name: 'B', rating: 72, price: 900, owned: false },
  ] });
  const r = ab.decodeSbc(code);
  assert.equal(r.sbc.kind, 'gallery');
  assert.deepEqual(r.sbc.players.map((p) => p.owned), [true, false]);
});

test('galeria: compra, manda para o clube e anuncia pelo preço de empate', async () => {
  const calls = [];
  const item = { tradeId: 9, id: 99, definitionId: 7, name: 'Fini', rating: 65, buyNow: 1100, kind: 'player', raw: { id: 99 } };
  const adapter = {
    getCoins: () => 100000,
    async search() { return { success: true, status: 200, items: [item] }; },
    async buy() { calls.push('buy'); return { success: true, status: 200 }; },
    async moveToClub() { calls.push('club'); return { success: true }; },
    async list(raw, start, bin) { calls.push(['list', start, bin]); return { success: true }; },
  };
  const purchases = [];
  const logs = [];
  const target = { id: 'gal-7', name: 'Galeria', kind: 'player', criteria: { type: 'player', maskedDefId: 7 }, definitionId: 7,
    maxCount: 1, bought: 0, minRating: 65, maxRating: 65, maxBuy: 1100, sellPrice: 0, sellBreakEven: true, clubFirst: true, enabled: true };
  const bot = new ab.Autobuyer({ adapter, getState: () => ({ settings: { delayMin: 0, delayMax: 0, pauseEvery: 0, pauseMinutes: 0, maxSearches: 3, maxBuys: 0, budget: 0 }, targets: [target] }),
    log: (m) => logs.push(m), onPurchase: (p) => purchases.push(p), random: () => 0.5 });
  await bot.start();
  assert.deepEqual(calls, ['buy', 'club', ['list', 1100, 1200]], logs.join('\n'));
  assert.equal(purchases[0].sellPrice, 1200);
  assert.equal(purchases[0].listed, true);
  assert.equal(purchases[0].inClub, true);
});

test('motor: chama e espera o afterSearch a cada busca', async () => {
  const seen = [];
  const adapter = {
    getCoins: () => 100000,
    async search() { return { success: true, status: 200, items: [] }; },
    async buy() { return { success: true }; },
    async list() { return { success: true }; },
  };
  const target = { id: 'gal-7', name: 'Galeria', kind: 'player', criteria: { type: 'player', maskedDefId: 7 }, definitionId: 7, maxCount: 1, maxBuy: 1000, enabled: true };
  const bot = new ab.Autobuyer({ adapter, getState: () => ({ settings: { delayMin: 0, delayMax: 0, pauseEvery: 0, pauseMinutes: 0, maxSearches: 4, maxBuys: 0, budget: 0 }, targets: [target] }),
    log: () => {}, random: () => 0.5,
    afterSearch: async (t) => { await Promise.resolve(); seen.push(t.id); } });
  await bot.start();
  assert.deepEqual(seen, ['gal-7', 'gal-7', 'gal-7', 'gal-7']);
});

test('galeria: separa nome e nota do texto "Nome - 68 - Rare"', () => {
  assert.deepEqual(ab.splitCardLabel('McKenna - 68 - Rare'), { name: 'McKenna', rating: 68 });
  assert.deepEqual(ab.splitCardLabel('Lee Geum Min - 70 - Rare'), { name: 'Lee Geum Min', rating: 70 });
  assert.deepEqual(ab.splitCardLabel('Fini'), { name: 'Fini', rating: 0 });
});

test('galeria: não confunde a pontuação (◆) com a nota da carta', () => {
  const r = ab.readGalleryTexts(['Alfonso Herrero', 'DIV', 'HAN', '90', '2.3K'], '');
  assert.equal(r.rating, 0);
  assert.equal(r.price, 2300);
  assert.equal(ab.readGalleryTexts(['75', 'GK', 'Alfonso Herrero', '90', '2.3K'], '').rating, 75);
  assert.ok(!ab.isGreenColor('rgb(80, 220, 180)'), 'verde-água do diamante não conta como marcada');
});

test('galeria: barganha (10% abaixo do FUT.GG) vai para o clube e não é anunciada', async () => {
  const calls = [];
  const item = { tradeId: 9, id: 99, definitionId: 7, name: 'Fini', rating: 65, buyNow: 900, kind: 'player', raw: { id: 99 } };
  const adapter = {
    getCoins: () => 100000,
    async search() { return { success: true, status: 200, items: [item] }; },
    async buy() { calls.push('buy'); return { success: true, status: 200 }; },
    async moveToClub() { calls.push('club'); return { success: true }; },
    async list() { calls.push('list'); return { success: true }; },
  };
  const purchases = [];
  const target = { id: 'gal-7', name: 'Galeria', kind: 'player', criteria: { type: 'player', maskedDefId: 7 }, definitionId: 7,
    maxCount: 1, bought: 0, maxBuy: 1100, sellBreakEven: true, clubFirst: true, refPrice: 1200, bargainAt: 1080, enabled: true };
  const bot = new ab.Autobuyer({ adapter, getState: () => ({ settings: { delayMin: 0, delayMax: 0, pauseEvery: 0, pauseMinutes: 0, maxSearches: 3, maxBuys: 0, budget: 0 }, targets: [target] }),
    log: () => {}, onPurchase: (p) => purchases.push(p), random: () => 0.5 });
  await bot.start();
  assert.deepEqual(calls, ['buy', 'club']);
  assert.equal(purchases[0].bargain, true);
  assert.equal(purchases[0].listed, false);
  assert.equal(purchases[0].inClub, true);
});
