const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

// Objeto de busca parecido com o da EA: o tipo fica num getter do protótipo,
// não como campo próprio. Foi assim que o tipo "consumível" se perdia.
function EaCriteria(fields) {
  Object.assign(this, fields);
}
Object.defineProperty(EaCriteria.prototype, 'type', { get() { return this._type; }, enumerable: false });
Object.defineProperty(EaCriteria.prototype, 'category', { get() { return this._category; }, enumerable: false });

test('captura o tipo da busca mesmo quando a EA guarda em getter', () => {
  const dto = new EaCriteria({ _type: 'training', _category: 'playStyle', playStyle: 268, maxBuy: 900 });
  const c = ab.serializeCriteria(dto);
  assert.equal(c.type, 'training');
  assert.equal(c.category, 'playStyle');
  assert.equal(c.playStyle, 268);
  assert.equal(c.maxBuy, undefined);
  assert.equal(ab.kindFromCriteria(c), 'chemstyle');
});

test('nunca assume jogador quando o tipo é desconhecido', () => {
  assert.equal(ab.kindFromCriteria({ playStyle: 268 }), null);
  assert.equal(ab.kindFromCriteria({}), null);
  assert.equal(ab.kindFromCriteria({ type: 'training', category: 'fitness' }), null);
  assert.equal(ab.kindFromCriteria({ type: 'player' }), 'player');
  assert.equal(ab.kindFromCriteria({ type: 'training', playStyle: 268 }), 'chemstyle');
});

test('consumível: monta a busca só com o estilo', () => {
  const c = ab.criteriaForKind('chemstyle', { type: 'player', position: 'CB', club: 243 }, { playStyle: '268' });
  assert.deepEqual(c, { type: 'training', category: 'playStyle', playStyle: 268 });
  const captured = { _type: 'training', type: 'training', category: 'playStyle', playStyle: 268, rarities: [1] };
  const kept = ab.criteriaForKind('chemstyle', captured, { playStyle: '268' });
  assert.equal(kept.type, 'training');
  assert.equal(kept.rarities, undefined);
});

test('jogador: monta a busca com posição, química aplicada e time', () => {
  const c = ab.criteriaForKind('player', {}, { position: 'CB', playStyle: '268', level: 'any', club: 243, league: 0, nation: '' });
  assert.deepEqual(c, { position: 'CB', playStyle: 268, club: 243, type: 'player' });
  // Busca capturada de consumível não contamina um alvo de jogador.
  const fromConsumable = ab.criteriaForKind('player', { type: 'training', category: 'playStyle', playStyle: 268 }, { position: 'CB' });
  assert.deepEqual(fromConsumable, { position: 'CB', type: 'player' });
});

test('valida o alvo antes de rodar', () => {
  assert.match(ab.targetProblem({ criteria: { playStyle: 268 }, maxBuy: 900 }), /tipo do alvo/);
  assert.match(ab.targetProblem({ kind: 'chemstyle', criteria: { type: 'training', category: 'playStyle' }, maxBuy: 900 }), /estilo/);
  assert.match(ab.targetProblem({ kind: 'chemstyle', criteria: { type: 'player', playStyle: 268 }, maxBuy: 900 }), /não é de consumível/);
  assert.match(ab.targetProblem({ kind: 'player', criteria: { type: 'player' }, maxBuy: 900 }), /filtro/);
  assert.match(ab.targetProblem({ kind: 'player', criteria: { type: 'player', club: 243 }, maxBuy: 100 }), /200/);
  assert.equal(ab.targetProblem({ kind: 'player', criteria: { type: 'player', club: 243 }, maxBuy: 900 }), null);
  assert.equal(ab.targetProblem({ kind: 'chemstyle', criteria: { type: 'training', category: 'playStyle', playStyle: 268 }, maxBuy: 900 }), null);
  assert.equal(ab.targetProblem({ kind: 'player', criteria: { type: 'player' }, minRating: 85, maxBuy: 900 }), null);
});

const shadowConsumable = { kind: 'chemstyle', criteria: { type: 'training', category: 'playStyle', playStyle: 268 }, maxBuy: 2000 };

test('alvo de consumível NUNCA compra jogador (o caso que deu prejuízo)', () => {
  const playerWithShadow = { tradeId: 1, buyNow: 500, kind: 'player', playStyle: 268, name: 'Zagueiro', rating: 84 };
  assert.equal(ab.mismatchReason(playerWithShadow, shadowConsumable), 'não é consumível');
  assert.equal(ab.pickCandidate([playerWithShadow], shadowConsumable, {}), null);
  const unknownKind = { tradeId: 2, buyNow: 500, name: 'Shadow' };
  assert.equal(ab.mismatchReason(unknownKind, shadowConsumable), 'não é consumível');
});

test('alvo de consumível compra só o estilo certo', () => {
  assert.equal(ab.mismatchReason({ kind: 'training', playStyle: 268, name: 'Shadow' }, shadowConsumable), null);
  assert.equal(ab.mismatchReason({ kind: 'training', playStyle: 250, name: 'Basic' }, shadowConsumable), 'estilo de química diferente');
  // Sem o ID do estilo no item, confere pelo nome; sem nome que bata, não compra.
  assert.equal(ab.mismatchReason({ kind: 'training', name: 'Shadow' }, shadowConsumable), null);
  assert.match(ab.mismatchReason({ kind: 'training', name: 'Contrato' }, shadowConsumable), /não deu para confirmar/);
  const items = [
    { tradeId: 1, buyNow: 400, kind: 'player', playStyle: 268 },
    { tradeId: 2, buyNow: 600, kind: 'training', playStyle: 250 },
    { tradeId: 3, buyNow: 900, kind: 'training', playStyle: 268 },
  ];
  const skipped = [];
  const pick = ab.pickCandidate(items, shadowConsumable, { onSkip: (it, why) => skipped.push([it.tradeId, why]) });
  assert.equal(pick.tradeId, 3);
  assert.deepEqual(skipped, [[1, 'não é consumível'], [2, 'estilo de química diferente']]);
});

test('zagueiro com Shadow: confere tipo, posição, química, time e nota', () => {
  const t = { kind: 'player', criteria: { type: 'player', position: 'CB', playStyle: 268, club: 243 }, minRating: 84, maxRating: 86, maxBuy: 10000 };
  const ok = { kind: 'player', position: 5, positions: ['CB'], playStyle: 268, teamId: 243, rating: 85 };
  assert.equal(ab.mismatchReason(ok, t), null);
  assert.equal(ab.mismatchReason(Object.assign({}, ok, { kind: 'training' }), t), 'não é jogador');
  assert.equal(ab.mismatchReason(Object.assign({}, ok, { position: 'ST', positions: ['ST'] }), t), 'posição diferente');
  assert.equal(ab.mismatchReason(Object.assign({}, ok, { position: undefined, positions: [] }), t), 'não deu para confirmar a posição');
  assert.equal(ab.mismatchReason(Object.assign({}, ok, { playStyle: 250 }), t), 'a química diferente');
  assert.equal(ab.mismatchReason(Object.assign({}, ok, { playStyle: undefined }), t), 'não deu para confirmar a química');
  assert.equal(ab.mismatchReason(Object.assign({}, ok, { teamId: 1 }), t), 'o clube diferente');
  assert.equal(ab.mismatchReason(Object.assign({}, ok, { teamId: undefined }), t), 'não deu para confirmar o clube');
  assert.equal(ab.mismatchReason(Object.assign({}, ok, { rating: 83 }), t), 'nota abaixo do mínimo');
  assert.equal(ab.mismatchReason(Object.assign({}, ok, { rating: 87 }), t), 'nota acima do máximo');
  // Posição alternativa também vale.
  assert.equal(ab.mismatchReason(Object.assign({}, ok, { position: 'CDM', positions: ['CDM', 'CB'] }), t), null);
});

test('identifica o tipo do item vindo da EA', () => {
  assert.equal(ab.itemKindOf({ type: 'player' }), 'player');
  assert.equal(ab.itemKindOf({ isPlayer: () => true }), 'player');
  assert.equal(ab.itemKindOf({ type: 'training' }), 'training');
  assert.equal(ab.itemKindOf({ _type: 'training' }), 'training');
  assert.equal(ab.itemKindOf({ isPlayer: () => false, isTraining: () => true }), 'training');
  assert.equal(ab.itemKindOf({ type: 'player', isPlayer: () => false }), null);
  assert.equal(ab.itemKindOf({}), null);
});

test('alvos de versões antigas ficam desligados até revisar', () => {
  const old = { id: 'x', criteria: { type: 'player', playStyle: 268 }, maxBuy: 900, enabled: true };
  const m = ab.migrateTarget(old);
  assert.equal(m.enabled, false);
  assert.equal(m.needsReview, true);
  assert.equal(m.kind, 'player');
  const fresh = { id: 'y', kind: 'chemstyle', enabled: true };
  assert.equal(ab.migrateTarget(fresh), fresh);
});

test('descreve alvos deixando claro o tipo', () => {
  assert.equal(ab.describeTarget(shadowConsumable), 'CONSUMÍVEL · estilo Shadow');
  const t = { kind: 'player', criteria: { type: 'player', playStyle: 268, position: 'CB', level: 'gold', club: 243 }, minRating: 84, maxRating: 0 };
  assert.equal(ab.describeTarget(t), 'JOGADOR · com química Shadow · nível Ouro · posição CB · clube 243 · nota 84–?');
  assert.match(ab.describeTarget({ criteria: {} }), /^TIPO NÃO DEFINIDO/);
});

test('modo simulação procura mas não compra', async () => {
  const buys = [];
  const logs = [];
  const target = Object.assign({ id: 't', name: 'Shadow', enabled: true }, shadowConsumable);
  const e = new ab.Autobuyer({
    adapter: {
      getCoins: () => 1e6,
      async search() {
        return { success: true, status: 200, items: [{ tradeId: 9, buyNow: 800, kind: 'training', playStyle: 268, name: 'Shadow', raw: {} }] };
      },
      async buy() { buys.push(1); return { success: true, status: 200 }; },
      async list() { return { success: true, status: 200 }; },
    },
    getState: () => ({ settings: { delayMin: 0, delayMax: 0, pauseEvery: 0, maxSearches: 2, maxBuys: 0, budget: 0, dryRun: true }, targets: [target] }),
    log: (m) => logs.push(m),
  });
  await e.start();
  assert.equal(buys.length, 0);
  assert.equal(e.stats.simulated, 1);
  assert.ok(logs.some((m) => /SIMULAÇÃO: compraria consumível Shadow por 800/.test(m)));
});

test('bot ignora alvo sem tipo e avisa', async () => {
  const logs = [];
  const e = new ab.Autobuyer({
    adapter: { getCoins: () => 1e6, async search() { throw new Error('não deveria buscar'); } },
    getState: () => ({ settings: { delayMin: 0, delayMax: 0 }, targets: [{ id: 'x', name: 'Velho', enabled: true, criteria: { playStyle: 268 }, maxBuy: 900 }] }),
    log: (m) => logs.push(m),
  });
  await e.start();
  assert.equal(e.stopReason, 'nenhum alvo válido e ativo');
  assert.ok(logs.some((m) => /Velho.*tipo do alvo/.test(m)));
});

test('usa os nomes de química do jogo quando disponíveis', () => {
  assert.equal(ab.loadChemStyles(null), false);
  assert.equal(ab.loadChemStyles(() => 'playstyles.playstyle1'), false);
  const names = { 250: 'Básico', 251: 'Atirador', 252: 'Finalizador', 253: 'Olho de Águia', 268: 'Sombra' };
  assert.equal(ab.loadChemStyles((key) => names[key.replace('playstyles.playstyle', '')] || key), true);
  assert.equal(ab.chemStyleName(268), 'Sombra');
  // Nome em português ou inglês confirma o consumível.
  assert.equal(ab.mismatchReason({ kind: 'training', name: 'Sombra' }, shadowConsumable), null);
  assert.equal(ab.mismatchReason({ kind: 'training', name: 'Shadow' }, shadowConsumable), null);
});
