const test = require('node:test');
const assert = require('node:assert/strict');
const ab = require('../fc27-autobuyer.user.js');

const at = (y, m, d, h) => new Date(y, m - 1, d, h == null ? 12 : h).getTime();

function ledger() {
  return {
    a: { status: 'vendida', cost: 1000, soldFor: 2000, soldAt: at(2026, 9, 28), boughtAt: at(2026, 9, 27) },  // +900
    b: { status: 'vendida', cost: 1000, soldFor: 3000, soldAt: at(2026, 9, 30, 9), boughtAt: at(2026, 9, 29) }, // +1850
    c: { status: 'vendida', cost: 5000, soldFor: 4000, soldAt: at(2026, 9, 30, 22), boughtAt: at(2026, 9, 30) }, // -1200
    d: { status: 'vendida', cost: 1000, soldFor: 1500, soldAt: at(2026, 10, 1), boughtAt: at(2026, 9, 30) },    // +425
    e: { status: 'na lista', cost: 700, boughtAt: at(2026, 10, 1) },
  };
}

test('lucro por período (vendas pela data da venda)', () => {
  const all = ab.ledgerSummary(ledger());
  assert.equal(all.profit, 900 + 1850 - 1200 + 425);
  assert.equal(all.soldCount, 4);
  const sep30 = ab.dayRange('2026-09-30');
  const s = ab.ledgerSummary(ledger(), sep30);
  assert.equal(s.profit, 1850 - 1200);
  assert.equal(s.soldCount, 2);
  // Compras no período, e estoque sempre o atual.
  assert.equal(s.boughtCount, 2);
  assert.equal(s.boughtCost, 6000);
  assert.equal(s.openCount, 1);
  const range = { from: ab.dayRange('2026-09-28').from, to: ab.dayRange('2026-09-30').to };
  assert.equal(ab.ledgerSummary(ledger(), range).profit, 900 + 1850 - 1200);
});

test('lucro por dia', () => {
  const days = ab.dailyProfit(ledger(), null);
  assert.deepEqual(days, [
    { day: '2026-10-01', count: 1, profit: 425 },
    { day: '2026-09-30', count: 2, profit: 650 },
    { day: '2026-09-28', count: 1, profit: 900 },
  ]);
});

test('períodos prontos', () => {
  const now = at(2026, 10, 15, 10);
  const today = ab.presetPeriod('today', now);
  assert.equal(today.from, at(2026, 10, 15, 0));
  assert.equal(today.to, at(2026, 10, 16, 0) - 1);
  assert.equal(ab.presetPeriod('7d', now).from, at(2026, 10, 9, 0));
  assert.equal(ab.presetPeriod('month', now).from, at(2026, 10, 1, 0));
  const last = ab.presetPeriod('lastMonth', now);
  assert.equal(last.from, at(2026, 9, 1, 0));
  assert.equal(last.to, at(2026, 10, 1, 0) - 1);
  assert.equal(ab.presetPeriod('all', now), null);
  assert.equal(ab.inPeriod(5, null), true);
  assert.equal(ab.inPeriod(undefined, { from: 1, to: 9 }), false);
  assert.equal(ab.dayKey(at(2026, 1, 5)), '2026-01-05');
  assert.equal(ab.dayRange('xx'), null);
});

test('lucro por alvo soma as vendas do alvo e das compras antigas da mesma carta', () => {
  const ab3 = require('../fc27-autobuyer.user.js');
  const kane = { id: 'k', kind: 'player', criteria: { maskedDefId: 202126 } };
  const ledger = {
    i1: { itemId: 1, definitionId: 202126, rating: 90, cost: 25750, status: 'vendida', soldFor: 27250, targetId: 'k' },
    i2: { itemId: 2, definitionId: 202126, rating: 90, cost: 25500, status: 'vendida', soldFor: 27250 },
    i3: { itemId: 3, definitionId: 202126, rating: 90, cost: 25750, status: 'à venda', targetId: 'k' },
    i4: { itemId: 4, definitionId: 202126, rating: 90, cost: 25750, status: 'vendida', soldFor: 27000, targetId: 'outro' },
    i5: { itemId: 5, definitionId: 999, rating: 80, cost: 1000, status: 'vendida', soldFor: 2000 },
    i6: { itemId: 6, definitionId: 202126, rating: 90, cost: 25000, status: 'removida', targetId: 'k' },
  };
  const r = ab3.targetLedgerStats(kane, ledger);
  assert.equal(r.sold, 2);
  assert.equal(r.profit, (25887 - 25750) + (25887 - 25500));
  assert.equal(r.open, 1);
});
