const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

const hit = (id, imageId, rating) => ({
  id,
  ratingSquare: { rating: String(rating) },
  playerImage: { fixed: { url: { image1x: 'https://cdn.futbin.com/content/fifa27/img/players/' + imageId + '.png?v=1' } } },
});

test('lê preços escritos de várias formas', () => {
  assert.equal(ab.parseShortPrice('12,500'), 12500);
  assert.equal(ab.parseShortPrice('1.2M'), 1200000);
  assert.equal(ab.parseShortPrice('45.5K'), 45500);
  assert.equal(ab.parseShortPrice(' 950 '), 950);
  assert.equal(ab.parseShortPrice('—'), 0);
});

test('acha a mesma versão da carta nos resultados do FUTBIN', () => {
  const base = 238794;
  const special = base + 50331648;
  const hits = [hit(1, base, 89), hit(2, special, 93), hit(3, 999, 93)];
  assert.equal(ab.pickFutbinHit(hits, { definitionId: special, rating: 93 }).id, 2);
  assert.equal(ab.pickFutbinHit(hits, { definitionId: base, rating: 89 }).id, 1);
  // Imagem da carta especial com o ID base: casa pelo ID base + nota.
  assert.equal(ab.pickFutbinHit([hit(1, base, 89), hit(4, base, 95)], { definitionId: special, rating: 95 }).id, 4);
  assert.equal(ab.pickFutbinHit([], { definitionId: 1, rating: 1 }), null);
  assert.equal(ab.pickFutbinHit([hit(5, 111, 70)], { definitionId: 222, rating: 80 }), null);
});

test('extrai o menor preço da página do jogador', () => {
  const html = `
    <div class="price-box platform-pc-only"><div class="lowest-price-1">99,000</div></div>
    <div class="price-box player-price-not-pc platform-ps-only">
      <div class="price-box-original-player">
        <div class="price inline-with-icon lowest-price-1"> 12,750 <img src="coin.png"></div>
        <div class="lowest-price-2">13,000</div>
      </div>
    </div>`;
  assert.equal(ab.parseFutbinPrice(html, 'ps'), 12750);
  assert.equal(ab.parseFutbinPrice(html, 'pc'), 99000);
});

test('usa a frase de resumo quando a caixa de preço não existe', () => {
  const html = '<p>His current price on FUT is 1,100 on PlayStation, 1,100 on Xbox, and 1,350 on PC.</p>';
  assert.equal(ab.parseFutbinPrice(html, 'ps'), 1100);
  assert.equal(ab.parseFutbinPrice(html, 'pc'), 1350);
  assert.equal(ab.parseFutbinPrice('<html></html>', 'ps'), 0);
});

test('sugere compra abaixo do FUTBIN e revenda pelo preço do FUTBIN', () => {
  assert.deepEqual(ab.suggestPrices(12750, 15), { maxBuy: 10750, sellPrice: 12750 });
  assert.equal(ab.suggestPrices(0, 15), null);
});

test('cliente FUTBIN busca, escolhe a carta e usa cache', async () => {
  const urls = [];
  let t = 1000;
  const request = async (url) => {
    urls.push(url);
    if (url.includes('/players/search')) return JSON.stringify([hit(77, 238794, 89)]);
    return '<div class="price-box platform-ps-only"><div class="lowest-price-1">20,000</div></div>';
  };
  const fb = ab.createFutbin(request, () => t);
  const card = { name: 'Vini Jr.', definitionId: 238794, rating: 89 };
  const r = await fb.price(card, 'ps');
  assert.deepEqual(r, { price: 20000, futbinId: 77, at: 1000 });
  assert.match(urls[0], /^https:\/\/www\.futbin\.com\/players\/search\?targetPage=PLAYER_PAGE&query=Vini%20Jr\.&year=27&evolutions=false$/);
  assert.equal(urls[1], 'https://www.futbin.com/27/player/77/player');
  await fb.price(card, 'ps');
  assert.equal(urls.length, 2);
  t += 16 * 60 * 1000;
  await fb.price(card, 'ps');
  assert.equal(urls.length, 4);
});

test('cliente FUTBIN explica quando não acha a carta', async () => {
  const fb = ab.createFutbin(async () => '[]');
  await assert.rejects(fb.price({ name: 'X', definitionId: 1, rating: 50 }, 'ps'), /não encontrado no FUTBIN/);
  const bad = ab.createFutbin(async () => '<html>captcha</html>');
  await assert.rejects(bad.price({ name: 'X', definitionId: 1, rating: 50 }, 'ps'), /resposta inesperada do FUTBIN/);
});

// Página e ponte conversam por eventos no window, como no navegador.
function fakeWin() {
  const w = new EventTarget();
  w.CustomEvent = CustomEvent;
  return w;
}

function installBridge(w, handler) {
  w.addEventListener('fcab:ping', () => w.dispatchEvent(new CustomEvent('fcab:bridge-ready')));
  w.addEventListener('fcab:fetch', (e) => {
    const req = JSON.parse(e.detail);
    Promise.resolve(handler(req.url)).then((d) =>
      w.dispatchEvent(new CustomEvent('fcab:fetch:result', { detail: JSON.stringify(Object.assign({ id: req.id }, d)) })));
  });
}

test('ponte entrega a resposta do FUTBIN para a página', async () => {
  const w = fakeWin();
  installBridge(w, (url) => ({ ok: true, status: 200, text: 'oi ' + url }));
  const request = ab.createBridgeRequest(w, 1000);
  const [a, b] = await Promise.all([request('https://www.futbin.com/a'), request('https://www.futbin.com/b')]);
  assert.equal(a, 'oi https://www.futbin.com/a');
  assert.equal(b, 'oi https://www.futbin.com/b');
});

test('ponte avisa erros e ausência do segundo script', async () => {
  const w = fakeWin();
  installBridge(w, () => ({ ok: false, status: 403, error: 'FUTBIN bloqueou' }));
  const request = ab.createBridgeRequest(w, 1000);
  await assert.rejects(request('https://www.futbin.com/x'), /FUTBIN bloqueou/);

  const lonely = ab.createBridgeRequest(fakeWin(), 30);
  await assert.rejects(lonely('https://www.futbin.com/x'), /ponte FUTBIN não respondeu/);
});

test('ponte responde ao ping quando já está instalada', () => {
  const w = fakeWin();
  installBridge(w, () => ({}));
  const request = ab.createBridgeRequest(w, 1000);
  assert.equal(request.isReady(), true);
});

test('bot identifica a carta e mostra o FUTBIN no log', async () => {
  const seen = [];
  const target = { id: 't', name: 'Alvo', criteria: { maskedDefId: 5 }, maxBuy: 10000, enabled: true, futbin: { price: 12000 } };
  const adapter = {
    getCoins: () => 1e6,
    async search() {
      return { success: true, status: 200, items: [{ tradeId: 1, buyNow: 9000, name: 'Fulano', definitionId: 5, rating: 80, raw: {} }] };
    },
    async buy() { return { success: true, status: 200 }; },
    async list() { return { success: true, status: 200 }; },
  };
  const logs = [];
  const e = new ab.Autobuyer({
    adapter,
    getState: () => ({ settings: { delayMin: 0, delayMax: 0, pauseEvery: 0, maxSearches: 0, maxBuys: 1, budget: 0 }, targets: [target] }),
    log: (m) => logs.push(m),
    onSearchResults: (t, items) => seen.push(ab.cardFromItems(items)),
  });
  await e.start();
  assert.deepEqual(seen[0], { name: 'Fulano', definitionId: 5, rating: 80 });
  assert.ok(logs.some((m) => m.includes('FUTBIN 12.000')));
});
