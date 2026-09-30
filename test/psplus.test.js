const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

// Busca parecida com a da EA: o filtro de PlayStyle+ num getter do protótipo.
function Dto() { this._type = 'player'; this._psPlus = false; this.nation = -1; }
Object.defineProperty(Dto.prototype, 'type', { get() { return this._type; }, set(v) { this._type = v; } });
Object.defineProperty(Dto.prototype, 'playStylePlus', { get() { return this._psPlus; }, set(v) { this._psPlus = v; } });

test('captura filtros guardados em getter do protótipo', () => {
  const d = new Dto();
  d.playStylePlus = true;
  d.nation = 54;
  const c = ab.serializeCriteria(d);
  assert.equal(c.playStylePlus, true);
  assert.equal(c._psPlus, true);
  assert.equal(c.type, 'player');
  assert.equal(c.nation, 54);
});

test('aprende o campo do filtro PlayStyle+ comparando com o padrão', () => {
  const defaults = ab.serializeCriteria(new Dto());
  const d = new Dto();
  d.playStylePlus = true;
  d.nation = 54;
  const field = ab.learnPsPlusField(ab.serializeCriteria(d), defaults);
  assert.deepEqual(field, { key: 'playStylePlus', internal: null, value: true, off: false });
  // Busca sem PlayStyle+ não ensina nada.
  assert.equal(ab.learnPsPlusField(defaults, defaults), null);
  // Estilo de química (playStyle) não é confundido com PlayStyle+.
  assert.equal(ab.learnPsPlusField(Object.assign({}, defaults, { playStyle: 268 }), defaults), null);
});

test('liga e desliga o filtro aprendido nos critérios', () => {
  const field = { key: 'playStylePlus', internal: '_psPlus', value: true, off: false };
  const on = ab.applyPsPlus({ type: 'player', nation: 54 }, true, field);
  assert.deepEqual(on, { type: 'player', nation: 54, playStylePlus: true, _psPlus: true });
  assert.equal(ab.hasPsPlusFilter(on, field), true);
  const off = ab.applyPsPlus(on, false, field);
  assert.deepEqual(off, { type: 'player', nation: 54 });
  assert.equal(ab.hasPsPlusFilter(off, field), false);
  assert.deepEqual(ab.applyPsPlus({ type: 'player' }, true, null), { type: 'player' });
});

test('confere "tem PlayStyle+" antes de comprar', () => {
  const withServer = { kind: 'player', psPlus: true, psPlusServer: true, criteria: { type: 'player', nation: 54 }, maxBuy: 20000 };
  const withoutServer = Object.assign({}, withServer, { psPlusServer: false });
  const base = { kind: 'player', nationId: 54 };
  const plus = Object.assign({ playStyles: [{ id: 3, plus: true }] }, base);
  const noPlus = Object.assign({ playStyles: [{ id: 3, plus: false }] }, base);
  const unknown = Object.assign({}, base);
  assert.equal(ab.mismatchReason(plus, withServer), null);
  assert.equal(ab.mismatchReason(noPlus, withServer), 'sem PlayStyle+');
  // Sem dados na carta: aceita só se a própria busca da EA filtrou.
  assert.equal(ab.mismatchReason(unknown, withServer), null);
  assert.equal(ab.mismatchReason(unknown, withoutServer), 'não deu para confirmar PlayStyle+');
  assert.equal(ab.mismatchReason(noPlus, withoutServer), 'sem PlayStyle+');
  assert.equal(ab.targetProblem({ kind: 'player', psPlus: true, criteria: { type: 'player' }, maxBuy: 900 }), null);
  assert.deepEqual(ab.targetParts({ kind: 'player', psPlus: true, criteria: { type: 'player', nation: 54 } }, { nation: () => 'Brasil' }),
    ['Brasil', 'Com PlayStyle+']);
});

test('busca do bot envia o filtro para a EA (campo com setter)', async () => {
  const sent = [];
  const win = {
    UTSearchCriteriaDTO: Dto,
    services: { Item: {
      searchTransferMarket(dto) { sent.push({ plus: dto.playStylePlus, internal: dto._psPlus, nation: dto.nation });
        return { observe(scope, cb) { cb({}, { success: true, status: 200, data: { items: [] } }); } }; },
    } },
  };
  const ad = ab.createEaAdapter(win);
  await ad.search({ type: 'player', nation: 54, playStylePlus: true, _psPlus: true });
  assert.deepEqual(sent, [{ plus: true, internal: true, nation: 54 }]);
  // Campo só-leitura não quebra a busca.
  const RO = function () {};
  Object.defineProperty(RO.prototype, 'locked', { get() { return 1; } });
  win.UTSearchCriteriaDTO = RO;
  await ad.search({ type: 'player', locked: 2 });
  assert.equal(ad.criteriaDefaults().locked, 1);
});
