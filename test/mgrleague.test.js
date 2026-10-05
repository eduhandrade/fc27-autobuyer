const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

const web = { type: 'training', category: 'managerLeagueModifier', league: 13, level: 'any' };

test('busca de Consumables → Manager Leagues vira alvo de liga de técnico', () => {
  assert.equal(ab.kindFromCriteria(web), 'mgrleague');
  assert.equal(ab.kindFromCriteria({ type: 'staff', category: 'manager' }), 'manager');
  assert.equal(ab.kindFromCriteria({ type: 'training', category: 'playStyle' }), 'chemstyle');
  const c = ab.criteriaForKind('mgrleague', Object.assign({ nation: 5, position: 'ST' }, web), { league: 13 });
  assert.deepEqual(c, web);
});

test('alvo de liga de técnico precisa da liga', () => {
  const t = (criteria) => ({ kind: 'mgrleague', criteria, maxBuy: 1000 });
  assert.equal(ab.targetProblem(t(web)), null);
  assert.match(ab.targetProblem(t({ type: 'training', category: 'managerLeagueModifier' })), /escolha a liga/);
  assert.match(ab.targetProblem(t({ type: 'training', category: 'playStyle', playStyle: 250 })), /não é de liga de técnico/);
});

test('só compra o consumível da liga certa', () => {
  const target = { kind: 'mgrleague', criteria: web };
  assert.equal(ab.mismatchReason({ kind: 'training', leagueId: 13 }, target), null);
  assert.equal(ab.mismatchReason({ kind: 'training', leagueId: 53 }, target), 'liga diferente');
  assert.equal(ab.mismatchReason({ kind: 'training' }, target), 'não deu para confirmar a liga do consumível');
  assert.equal(ab.mismatchReason({ kind: 'training', playStyle: 250, leagueId: 13 }, target), 'é estilo de química, não liga de técnico');
  assert.equal(ab.mismatchReason({ kind: 'manager', leagueId: 13 }, target), 'não é consumível');
  assert.equal(ab.mismatchReason({ kind: 'player', leagueId: 13 }, target), 'não é consumível');
});
