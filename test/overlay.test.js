const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

test('formata preços curtos para a etiqueta', () => {
  assert.equal(ab.formatShort(950), '950');
  assert.equal(ab.formatShort(1500), '1.5K');
  assert.equal(ab.formatShort(2000), '2K');
  assert.equal(ab.formatShort(16500), '17K');
  assert.equal(ab.formatShort(1250000), '1.25M');
  assert.equal(ab.formatShort(1000000), '1M');
  assert.equal(ab.formatShort(15000000), '15M');
});

const card = (id) => ({ name: 'J' + id, definitionId: id, rating: 80 });

test('busca várias cartas numa requisição só (FUTBIN em lote)', async () => {
  const urls = [];
  const request = async (url) => {
    urls.push(url);
    return JSON.stringify({
      1: { prices: { ps: { LCPrice: '1,200' }, pc: { LCPrice: '1,500' } } },
      2: { prices: { ps: { LCPrice: '45.5K' }, pc: { LCPrice: '0' } } },
    });
  };
  const futbin = { price: async () => { throw new Error('não deveria ir carta a carta'); } };
  const svc = ab.createPriceService(request, futbin, { batchDelay: 0 });
  const [a, b, a2] = await Promise.all([svc.get(card(1), 'ps'), svc.get(card(2), 'ps'), svc.get(card(1), 'ps')]);
  assert.equal(a, 1200);
  assert.equal(b, 45500);
  assert.equal(a2, 1200);
  assert.deepEqual(urls, ['https://www.futbin.com/27/playerPrices?player=1&rids=2']);
  assert.equal(svc.bulkStatus(), true);
  assert.equal(await svc.get(card(1), 'ps'), 1200); // cache
  assert.equal(urls.length, 1);
});

test('cai para carta a carta quando o lote não existe', async () => {
  const urls = [];
  const request = async (url) => { urls.push(url); throw new Error('FUTBIN respondeu 404'); };
  const asked = [];
  const futbin = { price: async (c) => { asked.push(c.definitionId); if (c.definitionId === 3) throw new Error('não encontrado'); return { price: c.definitionId * 1000 }; } };
  const svc = ab.createPriceService(request, futbin, { batchDelay: 0 });
  const results = await Promise.allSettled([svc.get(card(1), 'ps'), svc.get(card(2), 'ps'), svc.get(card(3), 'ps')]);
  assert.equal(results[0].value, 1000);
  assert.equal(results[1].value, 2000);
  assert.equal(results[2].status, 'rejected');
  assert.deepEqual(asked, [1, 2, 3]);
  assert.equal(svc.bulkStatus(), false);
  await svc.get(card(4), 'ps');
  assert.equal(urls.length, 1); // não tenta o lote de novo
});

test('lote parcial: o que faltar vai carta a carta', async () => {
  const request = async () => JSON.stringify({ 1: { prices: { ps: { LCPrice: '900' } } } });
  const futbin = { price: async (c) => ({ price: 7777 }) };
  const svc = ab.createPriceService(request, futbin, { batchDelay: 0 });
  assert.deepEqual(await Promise.all([svc.get(card(1), 'ps'), svc.get(card(2), 'ps')]), [900, 7777]);
});

test('preço expira depois de 5 minutos', async () => {
  let t = 0;
  let calls = 0;
  const request = async () => { calls++; return JSON.stringify({ 1: { prices: { ps: { LCPrice: String(1000 + calls) } } } }); };
  const svc = ab.createPriceService(request, {}, { batchDelay: 0, now: () => t });
  assert.equal(await svc.get(card(1), 'ps'), 1001);
  t = 4 * 60 * 1000;
  assert.equal(await svc.get(card(1), 'ps'), 1001);
  t = 6 * 60 * 1000;
  assert.equal(await svc.get(card(1), 'ps'), 1002);
});

test('acha objetos do Web App mesmo sem estarem em window', () => {
  assert.equal(ab.lookupGlobal({ services: 1 }, 'services'), 1);
  assert.equal(ab.lookupGlobal({}, 'services'), undefined);
  assert.equal(ab.lookupGlobal({}, 'desconhecido'), undefined);
});

test('código curto do erro na etiqueta', () => {
  assert.equal(ab.errorCode('a ponte FUTBIN não respondeu (o script ...)'), 'ponte');
  assert.equal(ab.errorCode('FUTBIN bloqueou (abra futbin.com ...)'), 'bloqueio');
  assert.equal(ab.errorCode('FUTBIN respondeu 404'), '404');
  assert.equal(ab.errorCode('resposta inesperada do FUTBIN na busca: "x"'), 'formato');
  assert.equal(ab.errorCode('Wirtz não encontrado no FUTBIN'), 'não achou');
  assert.equal(ab.errorCode('???'), 'erro');
});
