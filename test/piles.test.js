const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

test('acha a função da pilha mesmo com outro nome', () => {
  class Svc { requestTransferItems() {} searchTransferMarket() {} }
  assert.equal(ab.findPileMethod(new Svc(), 'transfer'), 'requestTransferItems');
  class Fc27 { getTradePileItems() {} searchTransferMarket() {} sendToTransferList() {} relistExpiredAuctions() {} requestWatchlistItems() {} getPurchasedItems() {} }
  const s = new Fc27();
  assert.equal(ab.findPileMethod(s, 'transfer'), 'getTradePileItems');
  assert.equal(ab.findPileMethod(s, 'watch'), 'requestWatchlistItems');
  assert.equal(ab.findPileMethod(s, 'unassigned'), 'getPurchasedItems');
  assert.equal(ab.findPileMethod({ searchTransferMarket() {} }, 'transfer'), null);
  assert.equal(ab.findPileMethod(null, 'transfer'), null);
});

test('reconhece as chamadas do Web App pelas URLs', () => {
  assert.equal(ab.pileFromUrl('https://utas.x.ea.com/ut/game/fc27/tradepile'), 'transfer');
  assert.equal(ab.pileFromUrl('https://utas.x.ea.com/ut/game/fc27/tradepile?x=1'), 'transfer');
  assert.equal(ab.pileFromUrl('/ut/game/fc27/purchased/items'), 'unassigned');
  assert.equal(ab.pileFromUrl('/ut/game/fc27/watchlist'), 'watch');
  assert.equal(ab.pileFromUrl('/ut/game/fc27/transfermarket?type=player'), null);
});

test('converte a resposta crua da EA', () => {
  const entity = { id: 11, _staticData: { name: 'Joana' } };
  const lookup = { entity: (id) => (id === 11 ? entity : null), entityName: (e) => e._staticData.name, playerName: (a) => (a === 999 ? 'Pela Lista' : null) };
  const items = ab.itemsFromPileJson({ auctionInfo: [
    { tradeId: 5, tradeState: 'closed', buyNowPrice: 1500, currentBid: 1500, itemData: { id: 11, assetId: 50, resourceId: 50, rating: 85, itemType: 'player', lastSalePrice: 400, marketAverage: 1200 } },
    { tradeId: 0, tradeState: null, itemData: { id: 12, assetId: 999, resourceId: 999, rating: 80, itemType: 'player', untradeable: true } },
    { tradeId: 0, itemData: { id: 13, assetId: 7, rating: 70, itemType: 'training' } },
    { itemData: {} },
  ] }, lookup);
  assert.equal(items.length, 3);
  assert.deepEqual([items[0].name, items[0].raw, items[0].lastSalePrice, items[0].tradeState, items[0].currentBid], ['Joana', entity, 400, 'closed', 1500]);
  assert.equal(items[1].name, 'Pela Lista');
  assert.equal(items[1].raw, null);
  assert.equal(items[1].untradeable, true);
  assert.equal(items[2].name, 'Carta 70 #7');
  assert.equal(items[2].kind, 'training');
  // Não atribuídos vêm como itemData direto.
  const un = ab.itemsFromPileJson({ itemData: [{ id: 20, assetId: 1, rating: 60, itemType: 'player', lastSalePrice: 300 }] });
  assert.equal(un[0].id, 20);
  assert.equal(un[0].lastSalePrice, 300);
  // Integra com o registro de lucro.
  const ledger = {};
  ab.syncLedger(ledger, items);
  assert.equal(ab.entryProfit(ledger.i11), 1025);
});

test('venda pula cartas que o Web App ainda não carregou', async () => {
  const logs = [];
  const group = { items: [{ id: 1, name: 'A', raw: null }, { id: 2, name: 'A', raw: { id: 2 } }] };
  const listed = [];
  const r = await ab.runBulkSell({ adapter: { async list(raw) { listed.push(raw.id); return { success: true }; } },
    orders: [{ group, qty: 2, bin: 1000, start: 950 }], ledger: {}, settings: {}, log: (m) => logs.push(m), wait: () => Promise.resolve() });
  assert.deepEqual(listed, [2]);
  assert.equal(r.failed, 1);
  assert.ok(logs.some((m) => /abra a lista de transferências/.test(m)));
});

test('"intransferível" como função não marca toda carta como intransferível', () => {
  assert.equal(ab.readFlag({ untradeable() { return false; } }, ['untradeable', 'isUntradeable']), false);
  assert.equal(ab.readFlag({ untradeable() { return true; } }, ['untradeable']), true);
  assert.equal(ab.readFlag({ isUntradeable: () => true }, ['untradeable', 'isUntradeable']), true);
  assert.equal(ab.readFlag({ _untradeable: false }, ['untradeable']), false);
  assert.equal(ab.readFlag({}, ['untradeable']), false);
  assert.equal(ab.readFlag({ untradeable: 1 }, ['untradeable']), true);
});

test('adaptador lê cartas da lista com untradeable em função e leilão via getAuctionData', async () => {
  class Entity {
    constructor(id) { this.id = id; this.definitionId = 50; this.rating = 85; this.type = 'player'; this._staticData = { name: 'Le Tissier' }; }
    untradeable() { return false; }
    getAuctionData() { return { tradeState: this.id === 3 ? 'active' : 'inactive', buyNowPrice: 0 }; }
  }
  const win = {
    UTSearchCriteriaDTO: function () {},
    services: { Item: { requestTransferItems() {
      return { observe(scope, cb) { cb({}, { success: true, status: 200, data: { items: [new Entity(1), new Entity(2), new Entity(3)] } }); } };
    } } },
  };
  const ad = ab.createEaAdapter(win);
  const r = await ad.pile('transfer');
  assert.equal(r.success, true);
  assert.equal(r.items.length, 3);
  assert.deepEqual(ab.sellableStats(r.items), { total: 3, ready: 2, listed: 1, sold: 0, untradeable: 0 });
  const groups = ab.groupSellable(r.items, {});
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
});

test('ID da carta como texto ainda entra no registro e na venda', async () => {
  const win = {
    UTSearchCriteriaDTO: function () {},
    services: { Item: { requestTransferItems() {
      return { observe(scope, cb) { cb({}, { success: true, data: { items: [
        { id: '412345678901', definitionId: 50, rating: 85, type: 'player', lastSalePrice: '2000', _staticData: { name: 'Bronze' }, _auction: {} },
      ] } }); } };
    } } },
  };
  const r = await ab.createEaAdapter(win).pile('transfer');
  assert.equal(r.items[0].id, 412345678901);
  assert.equal(r.items[0].lastSalePrice, 2000);
  const ledger = {};
  ab.syncLedger(ledger, r.items);
  assert.equal(ledger.i412345678901.cost, 2000);
});
