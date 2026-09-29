const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

test('editor de filtros aplica e remove filtros', () => {
  const base = { type: 'player', maskedDefId: 5, position: 'ST', club: 10 };
  const c = ab.applyFilterValues(base, { position: 'CB', playStyle: '268', level: 'gold', club: 0, league: 13, nation: '' });
  assert.deepEqual(c, { type: 'player', maskedDefId: 5, position: 'CB', playStyle: 268, level: 'gold', league: 13 });
  const cleared = ab.applyFilterValues(c, { position: 'any', playStyle: '0', level: 'any', league: 0 });
  assert.deepEqual(cleared, { type: 'player', maskedDefId: 5 });
  assert.equal(ab.applyFilterValues({}, {}).type, 'player');
});

test('exige jogador ou pelo menos um filtro', () => {
  assert.equal(ab.hasAnyFilter({ type: 'player' }), false);
  assert.equal(ab.hasAnyFilter({ type: 'player', position: 'any', club: -1 }), false);
  assert.equal(ab.hasAnyFilter({ type: 'player', club: 243 }), true);
  assert.equal(ab.hasAnyFilter({ type: 'player', playStyle: 268 }), true);
  assert.equal(ab.hasAnyFilter({ maskedDefId: 1 }), true);
  assert.equal(ab.hasAnyFilter({ type: 'player' }, { minRating: 85 }), true);
});

test('confere química, clube e nota antes de comprar', () => {
  const target = { criteria: { playStyle: 268, club: 243 }, minRating: 84, maxRating: 86, maxBuy: 10000 };
  assert.equal(ab.matchesFilters({ playStyle: 268, teamId: 243, rating: 85 }, target), true);
  assert.equal(ab.matchesFilters({ playStyle: 250, teamId: 243, rating: 85 }, target), false);
  assert.equal(ab.matchesFilters({ playStyle: 268, teamId: 1, rating: 85 }, target), false);
  assert.equal(ab.matchesFilters({ playStyle: 268, teamId: 243, rating: 83 }, target), false);
  assert.equal(ab.matchesFilters({ playStyle: 268, teamId: 243, rating: 87 }, target), false);
  // Campo que o item não informa não bloqueia a compra.
  assert.equal(ab.matchesFilters({ rating: 85 }, target), true);
});

test('bot pula carta fora do filtro e compra a que confere', () => {
  const target = { criteria: { playStyle: 268 }, maxBuy: 5000 };
  const items = [
    { tradeId: 1, buyNow: 1000, playStyle: 250 },
    { tradeId: 2, buyNow: 3000, playStyle: 268 },
  ];
  assert.equal(ab.pickCandidate(items, target, {}).tradeId, 2);
});

test('descreve filtros com nomes', () => {
  const t = { criteria: { playStyle: 268, position: 'CB', level: 'gold', club: 243 }, minRating: 84, maxRating: 0 };
  assert.equal(ab.describeTarget(t), 'química Shadow · nível Ouro · posição CB · clube 243 · nota 84–?');
});

test('usa os nomes de química do jogo quando disponíveis', () => {
  assert.equal(ab.loadChemStyles(null), false);
  assert.equal(ab.loadChemStyles(() => 'playstyles.playstyle1'), false);
  const names = { 250: 'Básico', 251: 'Atirador', 252: 'Finalizador', 253: 'Olho de Águia', 268: 'Sombra' };
  assert.equal(ab.loadChemStyles((key) => names[key.replace('playstyles.playstyle', '')] || key), true);
  assert.equal(ab.chemStyleName(268), 'Sombra');
  assert.equal(ab.chemStyleName(999), 'estilo #999');
});
