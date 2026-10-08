const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

test('pontos por nota e conferência da solução', () => {
  assert.equal(ab.ptsScore(87), 5500);
  assert.equal(ab.ptsScore(86), 4100);
  assert.equal(ab.ptsScore(60), 20);
  assert.equal(ab.ptsScore(70), 35);
  assert.equal(ab.ptsTotal([{ qty: 14, rating: 87 }, { qty: 2, rating: 86 }]), 85200);
});

test('clube: usa só a nota exata, comum, fora do time; intransferíveis primeiro', () => {
  const it = (id, rating, extra) => Object.assign({ id, rating, kind: 'player', name: 'J' + id, special: false, untradeable: false }, extra);
  const items = [
    it(1, 87), it(2, 87, { untradeable: true }), it(3, 87, { special: true }), it(4, 87), it(5, 88),
    it(6, 86), it(7, 87), it(8, 86, { special: null }),
  ];
  const plan = ab.planPtsFromClub([{ qty: 3, rating: 87, max: 7000 }, { qty: 4, rating: 86, max: 5000 }], items, new Set([4]));
  const p87 = plan.picks.find((p) => p.rating === 87);
  assert.deepEqual(p87.items.map((x) => x.id), [2, 1, 7]); // intransferível primeiro; sem especial (3), sem time (4), sem 88 (5)
  const p86 = plan.picks.find((p) => p.rating === 86);
  assert.deepEqual(p86.items.map((x) => x.id), [6, 8]);
  assert.deepEqual(plan.need, [{ rating: 86, qty: 2, max: 5000 }]);
});

test('compra por nota exata: ouro, sem especial, faixa de preço e quantidade', () => {
  const t = ab.ptsTarget(87, 9, 7000, 1);
  assert.equal(ab.targetProblem(t), null);
  assert.equal(t.minRating, 87);
  assert.equal(t.maxRating, 87);
  assert.equal(t.maxCount, 9);
  assert.equal(t.minPrice, 4900);
  assert.equal(ab.mismatchReason({ kind: 'player', rating: 87, special: false }, t), null);
  assert.equal(ab.mismatchReason({ kind: 'player', rating: 88, special: false }, t), 'nota acima do máximo');
  assert.equal(ab.mismatchReason({ kind: 'player', rating: 86 }, t), 'nota abaixo do mínimo');
  assert.equal(ab.mismatchReason({ kind: 'player', rating: 87, special: true }, t), 'carta especial');
  const c = ab.buildCriteria(t, 0);
  assert.equal(c.level, 'gold');
  assert.equal(c.minBuy, 4900);
  assert.equal(c.maxBuy, 7000);
});

test('lista "mais baratas" vira candidatas por nota, mais baratas primeiro', () => {
  const c = ab.candidatesFromList([
    { definitionId: 1, name: 'A', rating: 87, price: 5600 }, { definitionId: 2, name: 'B', rating: 87, price: 5200 },
    { definitionId: 3, name: 'C', rating: 86, price: 0 }, { definitionId: 2, name: 'B', rating: 87, price: 5200 },
  ]);
  assert.deepEqual(c[87].map((x) => x.name), ['B', 'A']);
  assert.equal(c[86].length, 1);
});

test('compra de jogador específico: só aquela carta, nota exata, comum', () => {
  const t = ab.ptsCandidateTarget({ definitionId: 231747, name: 'Fulano' }, 87, 11, 5500, 1);
  assert.equal(ab.targetProblem(t), null);
  assert.equal(t.criteria.maskedDefId, 231747);
  assert.equal(t.id, 'pts-87-231747');
  assert.equal(ab.mismatchReason({ kind: 'player', definitionId: 231747, rating: 87, special: false }, t), null);
  assert.equal(ab.mismatchReason({ kind: 'player', definitionId: 231747 + 50331648, rating: 90, special: true }, t), 'outra versão da carta');
});

test('banco do Web App: jogadores de uma nota, sem ícones', () => {
  const db = ab.parsePlayersDb({ Players: [{ id: 1, c: 'Base', r: 87 }, { id: 2, c: 'Outro', r: 86 }], LegendsPlayers: [{ id: 3, c: 'Ícone', r: 87 }] });
  assert.deepEqual(ab.playersOfRating(db, 87).map((p) => p.name), ['Base']);
});
