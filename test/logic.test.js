const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

test('preços seguem os degraus da EA', () => {
  assert.equal(ab.roundDown(1234), 1200);
  assert.equal(ab.roundDown(999), 950);
  assert.equal(ab.roundDown(10300), 10250);
  assert.equal(ab.roundDown(100), 150);
  assert.equal(ab.nextPrice(950), 1000);
  assert.equal(ab.nextPrice(1000), 1100);
  assert.equal(ab.prevPrice(1000), 950);
  assert.equal(ab.prevPrice(10000), 9900);
  assert.equal(ab.prevPrice(10250), 10000);
  assert.equal(ab.prevPrice(1234), 1200);
  assert.equal(ab.prevPrice(150), 150);
  assert.equal(ab.netAfterTax(10000), 9500);
});

test('variação anti-cache fica abaixo do preço-alvo', () => {
  assert.deepEqual(ab.cacheBusterValues(300), [0]);
  const v = ab.cacheBusterValues(20000);
  assert.equal(v[0], 0);
  assert.equal(v[v.length - 1], 1000);
  assert.equal(v.length, 18);
  const target = { criteria: { type: 'player', maskedDefId: 1 }, maxBuy: 12345 };
  const a = ab.buildCriteria(target, 0);
  const b = ab.buildCriteria(target, 1);
  assert.equal(a.maxBuy, 12250);
  assert.notEqual(a.minBuy, b.minBuy);
  assert.equal(a.maskedDefId, 1);
});

test('busca manual é copiada sem os campos de preço', () => {
  const c = ab.serializeCriteria({
    type: 'player', maskedDefId: 7, rarities: [3], maxBuy: 5000, minBid: 150,
    fn() {}, nested: { a: 1 },
  });
  assert.deepEqual(c, { type: 'player', maskedDefId: 7, rarities: [3] });
});

test('escolhe a carta mais barata que cabe no preço, moedas e orçamento', () => {
  const items = [
    { tradeId: 1, buyNow: 900, kind: 'player' },
    { tradeId: 2, buyNow: 700, kind: 'player' },
    { tradeId: 3, buyNow: 1200, kind: 'player' },
    { tradeId: 4, buyNow: 500, kind: 'player' },
  ];
  const target = { kind: 'player', criteria: { type: 'player', maskedDefId: 1 }, maxBuy: 1000 };
  assert.equal(ab.pickCandidate(items, target, {}).tradeId, 4);
  assert.equal(ab.pickCandidate(items, target, { seen: new Set([4]) }).tradeId, 2);
  assert.equal(ab.pickCandidate(items, target, { coins: 600 }).tradeId, 4);
  assert.equal(ab.pickCandidate(items, target, { coins: 400 }), null);
  assert.equal(ab.pickCandidate(items, target, { budgetLeft: 450 }), null);
});

test('classifica os códigos de erro da EA', () => {
  assert.equal(ab.classifyStatus(458), 'captcha');
  assert.equal(ab.classifyStatus(401), 'session');
  assert.equal(ab.classifyStatus(429), 'blocked');
  assert.equal(ab.classifyStatus(512), 'blocked');
  assert.equal(ab.classifyStatus(461), 'missed');
  assert.equal(ab.classifyStatus(500), 'unknown');
});

test('lê valores digitados com pontos', () => {
  assert.equal(ab.parseCoins('12.500'), 12500);
  assert.equal(ab.parseCoins(''), 0);
});

test('store mistura configuração salva com padrões', () => {
  const mem = { 'fc27-autobuyer:v1': JSON.stringify({ settings: { delayMin: 9 }, targets: [{ id: 'a' }] }) };
  const store = ab.createStore({ getItem: (k) => mem[k] || null, setItem: (k, v) => { mem[k] = v; } });
  const st = store.load();
  assert.equal(st.settings.delayMin, 9);
  assert.equal(st.settings.delayMax, ab.DEFAULT_SETTINGS.delayMax);
  assert.equal(st.targets.length, 1);
  assert.deepEqual(st.history, []);
});
