const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

test('lê PlayStyles e PlayStyle+ da carta', () => {
  assert.deepEqual(ab.readPlayStyles({ getPlayStyles: () => [{ traitId: 0, isIcon: true }, { traitId: 14, isIcon: false }] }),
    [{ id: 0, plus: true }, { id: 14, plus: false }]);
  assert.equal(ab.readPlayStyles({}), undefined);
  assert.equal(ab.readPlayStyles({ getPlayStyles: () => { throw new Error('x'); } }), undefined);
});

test('confere PlayStyles e PlayStyle+ exigidos', () => {
  const card = [{ id: 0, plus: true }, { id: 14, plus: false }];
  assert.equal(ab.playStyleMismatch(card, []), null);
  assert.equal(ab.playStyleMismatch(card, [{ id: 0, plus: true }]), null);
  assert.equal(ab.playStyleMismatch(card, [{ id: 14, plus: false }]), null);
  assert.equal(ab.playStyleMismatch(card, [{ id: 14, plus: true }]), 'tem Jockey mas não o +');
  assert.equal(ab.playStyleMismatch(card, [{ id: 16, plus: false }]), 'sem Intercept');
  assert.equal(ab.playStyleMismatch(undefined, [{ id: 0, plus: true }]), 'não deu para confirmar os PlayStyles');
});

test('bot só compra jogador com o PlayStyle+ pedido', () => {
  const target = { kind: 'player', criteria: { type: 'player', position: 'CB' }, playStyles: [{ id: 16, plus: true }], maxBuy: 9000 };
  const base = { kind: 'player', position: 'CB', positions: ['CB'] };
  const items = [
    Object.assign({ tradeId: 1, buyNow: 1000, playStyles: [{ id: 16, plus: false }] }, base),
    Object.assign({ tradeId: 2, buyNow: 2000 }, base),
    Object.assign({ tradeId: 3, buyNow: 3000, playStyles: [{ id: 16, plus: true }] }, base),
  ];
  const skipped = [];
  const pick = ab.pickCandidate(items, target, { onSkip: (it, why) => skipped.push(why) });
  assert.equal(pick.tradeId, 3);
  assert.deepEqual(skipped, ['tem Intercept mas não o +', 'não deu para confirmar os PlayStyles']);
  assert.equal(ab.targetProblem({ kind: 'player', criteria: { type: 'player' }, playStyles: [{ id: 16, plus: true }], maxBuy: 900 }), null);
});

// Tradução falsa no formato do Web App.
const DICT = {
  'global.teamFull.2027.team243': 'Real Madrid',
  'global.teamFull.2027.team241': 'FC Barcelona',
  'global.teamFull.2027.team10': 'Manchester City',
  'global.leagueFull.2027.league13': 'Premier League',
  'global.leagueFull.2027.league53': 'LALIGA EA SPORTS',
  'search.nationName.nation54': 'Brasil',
  'search.nationName.nation18': 'França',
};
const localize = (key) => DICT[key] || key;

test('descobre o ano e traduz times, ligas e países', () => {
  const names = ab.createNameService(() => localize);
  assert.equal(names.available(), true);
  assert.equal(names.club(243), 'Real Madrid');
  assert.equal(names.year(), 2027);
  assert.equal(names.league(13), 'Premier League');
  assert.equal(names.nation(54), 'Brasil');
  assert.equal(names.club(99999), null);
  const none = ab.createNameService(() => null);
  assert.equal(none.available(), false);
  assert.equal(none.club(243), null);
});

test('monta listas por nome e busca sem acento', async () => {
  const names = ab.createNameService(() => localize, { scan: { club: 300, league: 100, nation: 100 }, chunk: 50 });
  const clubs = await names.list('club');
  assert.deepEqual(clubs.map((c) => c.name), ['FC Barcelona', 'Manchester City', 'Real Madrid']);
  assert.deepEqual(ab.searchByName(clubs, 'real').map((c) => c.id), [243]);
  assert.deepEqual(ab.searchByName(clubs, 'CITY').map((c) => c.id), [10]);
  const nations = await names.list('nation');
  assert.deepEqual(ab.searchByName(nations, 'franca').map((c) => c.name), ['França']);
  const empty = await ab.createNameService(() => null).list('club');
  assert.deepEqual(empty, []);
});

test('ignora traduções que não são nomes', () => {
  assert.equal(ab.validName('Real Madrid', 'k'), true);
  assert.equal(ab.validName('k', 'k'), false);
  assert.equal(ab.validName('global.teamFull.2027.team1', 'x'), false);
  assert.equal(ab.validName('', 'x'), false);
});

test('busca jogadores pelo nome na lista do Web App', () => {
  const db = ab.parsePlayersDb({
    Players: [
      { id: 238794, f: 'Vinícius', l: 'José Paixão de Oliveira Júnior', c: 'Vini Jr.', r: 90 },
      { id: 231747, f: 'Kylian', l: 'Mbappé', r: 91 },
      { id: 5, f: 'Vinicius', l: 'Souza', r: 70 },
    ],
    LegendsPlayers: [{ id: 190871, f: 'Neymar', l: 'da Silva Santos Júnior', c: 'Neymar Jr', r: 89 }],
  });
  assert.equal(db.length, 4);
  assert.equal(db.find((p) => p.id === 231747).name, 'Kylian Mbappé');
  assert.deepEqual(ab.searchPlayers(db, 'vini').map((p) => p.id), [238794, 5]);
  assert.deepEqual(ab.searchPlayers(db, 'mbappe').map((p) => p.id), [231747]);
  assert.deepEqual(ab.searchPlayers(db, 'v'), []);
});
