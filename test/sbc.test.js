const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

const sol = {
  name: '2x 79+ Upgrade', url: 'https://www.futbin.com/27/squad/1/sbc', total: 1300, at: 1,
  players: [
    { definitionId: 227125, name: 'Leroux', rating: 78, position: 'ST', price: 650, pcPrice: 650 },
    { definitionId: 50559000, name: 'Vargas', rating: 78, position: 'LW', price: 1200, pcPrice: 1100 },
  ],
};

test('código da solução vai e volta, com acentos', () => {
  const s = Object.assign({}, sol, { name: 'Ícones à vista' });
  const code = ab.encodeSbc(s);
  assert.match(code, /^FCAB-SBC1:/);
  const r = ab.decodeSbc('copiado: ' + code + '\n');
  assert.equal(r.sbc.name, 'Ícones à vista');
  assert.equal(r.sbc.players.length, 2);
  assert.equal(r.sbc.players[1].price, 1200);
});

test('código errado ou incompleto é recusado', () => {
  assert.match(ab.decodeSbc('qualquer coisa').error, /não achei/);
  assert.match(ab.decodeSbc('FCAB-SBC1:abc').error, /corrompido/);
  assert.match(ab.decodeSbc(ab.encodeSbc({ name: 'x', players: [] })).error, /sem jogadores|não tem jogadores/);
});

test('lê o ID da carta na imagem do FUTBIN', () => {
  assert.equal(ab.futbinImageId('https://cdn.futbin.com/content/fifa27/img/players/227125.png?v=23'), 227125);
  assert.equal(ab.futbinImageId('https://cdn.futbin.com/content/fifa27/img/players/p50559000.webp'), 50559000);
  assert.equal(ab.futbinImageId('background-image: url("https://cdn.futbin.com/content/fifa27/img/players/p84113.png")'), 84113);
  assert.equal(ab.futbinImageId('https://cdn.futbin.com/content/fifa27/img/clubs/10.png'), 0);
});

test('alvo do SBC compra só aquela versão e aquela nota, sem revenda', () => {
  const t = ab.sbcTarget(sol.players[1], sol.name, 1200, 5);
  assert.equal(ab.targetProblem(t), null);
  assert.equal(t.criteria.maskedDefId, ab.baseDefId(50559000));
  assert.equal(t.maxCount, 1);
  assert.equal(t.sellPrice, 0);
  const item = (defId, rating) => ({ kind: 'player', definitionId: defId, rating });
  assert.equal(ab.mismatchReason(item(50559000, 78), t), null);
  assert.equal(ab.mismatchReason(item(ab.baseDefId(50559000), 74), t), 'outra versão da carta');
  assert.equal(ab.mismatchReason(item(50559000, 80), t), 'nota acima do máximo');
});

test('sniper ignora outra versão do jogador e compra a da solução', async () => {
  const t = ab.sbcTarget(sol.players[1], sol.name, 1200, 5);
  const bought = [];
  const adapter = {
    getCoins: () => 1e6,
    async search() {
      return { success: true, status: 200, items: [
        { tradeId: 1, buyNow: 300, kind: 'player', definitionId: ab.baseDefId(50559000), rating: 74, name: 'Vargas', raw: { id: 1 } },
        { tradeId: 2, buyNow: 1100, kind: 'player', definitionId: 50559000, rating: 78, name: 'Vargas', raw: { id: 2 } },
      ] };
    },
    async buy(raw, price) { bought.push([raw.id, price]); return { success: true, status: 200 }; },
    async list() { return { success: true, status: 200 }; },
  };
  const e = new ab.Autobuyer({
    adapter,
    getState: () => ({ settings: { delayMin: 0, delayMax: 0, pauseEvery: 0, maxSearches: 3, maxBuys: 0, budget: 0 }, targets: [t] }),
    log: () => {},
    random: () => 0.5,
  });
  await e.start();
  assert.deepEqual(bought, [[2, 1100]]);
  assert.equal(t.bought, 1);
});

test('montar elenco: cada jogador vai para a vaga da posição dele', () => {
  const slots = ['ST', 'LW', 'LM', 'RCM', 'LCM', 'RM', 'CAM', 'LCB', 'RCB', 'LB', 'GK'].map((position, index) => ({ index, position }));
  const players = [
    { name: 'GK1', position: 'GK' }, { name: 'ST1', position: 'ST' }, { name: 'CM1', position: 'CM' }, { name: 'CM2', position: 'CM' },
    { name: 'CB1', position: 'CB' }, { name: 'X', position: 'RW' },
  ];
  const plan = ab.planSbcSlots(slots, players);
  const at = (i) => (plan.find((x) => x.index === i) || {}).player;
  assert.equal(at(0).name, 'ST1');
  assert.equal(at(10).name, 'GK1');
  assert.equal(at(3).name, 'CM1');
  assert.equal(at(4).name, 'CM2');
  assert.equal(at(7).name, 'CB1');
  assert.equal(plan.length, 6);
  const extra = plan.find((x) => x.player.name === 'X');
  assert.equal(extra.match, false);
  assert.equal(ab.simplePosition('rcb'), 'CB');
});
