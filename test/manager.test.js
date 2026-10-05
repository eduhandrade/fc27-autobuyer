const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

test('busca da aba Managers vira alvo de técnico', () => {
  assert.equal(ab.kindFromCriteria({ type: 'staff', category: 'manager', level: 'gold' }), 'manager');
  const c = ab.criteriaForKind('manager', { type: 'player', position: 'ST', club: 5 }, { level: 'gold', league: 13, nation: 'any' });
  assert.deepEqual(c, { type: 'staff', category: 'manager', level: 'gold', league: 13 });
});

test('alvo de técnico precisa de algum filtro e do tipo certo', () => {
  const t = (criteria, maxBuy = 1000) => ({ kind: 'manager', criteria, maxBuy });
  assert.equal(ab.targetProblem(t({ type: 'staff', category: 'manager', level: 'gold' })), null);
  assert.match(ab.targetProblem(t({ type: 'staff', category: 'manager' })), /pelo menos um filtro/);
  assert.match(ab.targetProblem(t({ type: 'player', level: 'gold' })), /não é de técnico/);
  assert.equal(ab.targetProblem(t({ type: 'staff', category: 'manager', maskedDefId: 4000 })), null);
});

test('sniper de técnico nunca compra jogador e confere liga e país', () => {
  const target = { kind: 'manager', criteria: { type: 'staff', category: 'manager', league: 13, nation: 14 } };
  assert.equal(ab.mismatchReason({ kind: 'player', leagueId: 13, nationId: 14 }, target), 'não é técnico');
  assert.equal(ab.mismatchReason({ kind: 'manager', leagueId: 13, nationId: 14 }, target), null);
  assert.equal(ab.mismatchReason({ kind: 'manager', leagueId: 53, nationId: 14 }, target), 'liga diferente');
  assert.equal(ab.mismatchReason({ kind: 'manager', nationId: 14 }, target), 'não deu para confirmar a liga');
  const one = { kind: 'manager', criteria: { type: 'staff', category: 'manager', maskedDefId: 4000 } };
  assert.equal(ab.mismatchReason({ kind: 'manager', definitionId: 4001 }, one), 'outro técnico');
});

test('reconhece cartas de técnico do Web App', () => {
  assert.equal(ab.itemKindOf({ type: 'staff', isManager: () => true }), 'manager');
  assert.equal(ab.itemKindOf({ type: 'staff' }), 'manager');
  assert.equal(ab.itemKindOf({ type: 'staff', category: 'physio' }), 'staff');
  assert.equal(ab.itemKindOf({ type: 'player' }), 'player');
});

test('sniper compra o técnico e ignora jogador no mesmo resultado', async () => {
  const target = { id: 'm', name: 'Técnico Ouro', kind: 'manager', criteria: { type: 'staff', category: 'manager', level: 'gold' }, maxBuy: 600, enabled: true };
  const bought = [];
  const searched = [];
  const adapter = {
    getCoins: () => 1e6,
    async search(c) {
      searched.push(c);
      return { success: true, status: 200, items: [
        { tradeId: 1, buyNow: 300, kind: 'player', name: 'Jogador', raw: { id: 1 } },
        { tradeId: 2, buyNow: 500, kind: 'manager', name: 'Ancelotti', raw: { id: 2 } },
      ] };
    },
    async buy(raw, price) { bought.push([raw.id, price]); return { success: true, status: 200 }; },
    async list() { return { success: true, status: 200 }; },
  };
  const e = new ab.Autobuyer({
    adapter,
    getState: () => ({ settings: { delayMin: 0, delayMax: 0, pauseEvery: 0, maxSearches: 1, maxBuys: 0, budget: 0 }, targets: [target] }),
    log: () => {},
    random: () => 0.5,
  });
  await e.start();
  assert.deepEqual(bought, [[2, 500]]);
  assert.equal(searched[0].type, 'staff');
  assert.equal(searched[0].category, 'manager');
});
