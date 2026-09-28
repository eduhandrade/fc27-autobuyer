// ==UserScript==
// @name         FC27 Autobuyer
// @namespace    fc27-autobuyer
// @version      0.1.0
// @description  Autobuyer para o Web App do EA SPORTS FC 27 Ultimate Team (uso pessoal, por sua conta e risco)
// @match        https://www.ea.com/*ea-sports-fc/ultimate-team/web-app/*
// @grant        none
// @inject-into  page
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Preços do mercado
  // ---------------------------------------------------------------------------

  // A EA só aceita preços em "degraus". Até 1.000 sobe de 50 em 50, até 10.000
  // de 100 em 100, e assim por diante.
  const PRICE_BANDS = [
    { upTo: 1000, step: 50 },
    { upTo: 10000, step: 100 },
    { upTo: 50000, step: 250 },
    { upTo: 100000, step: 500 },
    { upTo: Infinity, step: 1000 },
  ];
  const MIN_PRICE = 150;
  const MAX_PRICE = 15000000;
  const EA_TAX = 0.05;

  function stepAt(price) {
    for (const band of PRICE_BANDS) {
      if (price < band.upTo) return band.step;
    }
    return 1000;
  }

  function clampPrice(price) {
    return Math.min(MAX_PRICE, Math.max(MIN_PRICE, price));
  }

  function roundDown(price) {
    const p = clampPrice(price);
    const step = stepAt(p);
    return Math.floor(p / step) * step;
  }

  function nextPrice(price) {
    const p = roundDown(price);
    return clampPrice(p + stepAt(p));
  }

  function prevPrice(price) {
    const p = roundDown(price);
    if (p < price) return p;
    return clampPrice(p - stepAt(p - 1));
  }

  function netAfterTax(sellPrice) {
    return Math.floor(sellPrice * (1 - EA_TAX));
  }

  // ---------------------------------------------------------------------------
  // Filtros de busca
  // ---------------------------------------------------------------------------

  // Campos que o próprio bot controla; não são copiados da busca manual.
  const CONTROLLED_KEYS = ['minBid', 'maxBid', 'minBuy', 'maxBuy', 'offset', 'count'];

  function serializeCriteria(criteria) {
    const out = {};
    if (!criteria) return out;
    for (const key of Object.keys(criteria)) {
      if (CONTROLLED_KEYS.includes(key)) continue;
      const value = criteria[key];
      const t = typeof value;
      if (t === 'number' || t === 'string' || t === 'boolean') {
        out[key] = value;
      } else if (Array.isArray(value) && value.every((v) => typeof v !== 'object' && typeof v !== 'function')) {
        out[key] = value.slice();
      }
    }
    return out;
  }

  // A EA guarda em cache buscas idênticas, e aí cartas recém-listadas não
  // aparecem. Variar o "preço mínimo de compra" a cada busca evita isso. Os
  // valores ficam bem abaixo do preço-alvo para não esconder nenhuma oferta boa.
  function cacheBusterValues(maxBuy) {
    const cap = Math.min(1000, Math.floor(maxBuy * 0.5));
    const values = [0];
    for (let p = 200; p <= cap; p += 50) values.push(p);
    return values;
  }

  function buildCriteria(target, busterIndex) {
    const values = cacheBusterValues(target.maxBuy);
    return Object.assign({}, target.criteria, {
      maxBuy: roundDown(target.maxBuy),
      minBuy: values[busterIndex % values.length],
    });
  }

  function describeCriteria(c) {
    if (!c) return '';
    const parts = [];
    if (c.maskedDefId) parts.push('jogador ' + c.maskedDefId);
    if (Array.isArray(c.defId) && c.defId.length) parts.push('carta ' + c.defId.join(','));
    if (c.level && c.level !== 'any') parts.push('nível ' + c.level);
    if (Array.isArray(c.rarities) && c.rarities.length) parts.push('raridade ' + c.rarities.join(','));
    if (c.position && c.position !== 'any') parts.push('posição ' + c.position);
    if (c.league > 0) parts.push('liga ' + c.league);
    if (c.nation > 0) parts.push('país ' + c.nation);
    if (c.club > 0) parts.push('clube ' + c.club);
    if (!parts.length && c.type) parts.push('tipo ' + c.type);
    return parts.join(' · ') || 'busca sem filtros';
  }

  // ---------------------------------------------------------------------------
  // Decisão de compra
  // ---------------------------------------------------------------------------

  function pickCandidate(items, target, ctx) {
    const coins = ctx.coins == null ? Infinity : ctx.coins;
    const budgetLeft = ctx.budgetLeft == null ? Infinity : ctx.budgetLeft;
    const eligible = items.filter((it) =>
      it.buyNow > 0 &&
      it.buyNow <= target.maxBuy &&
      it.buyNow <= coins &&
      it.buyNow <= budgetLeft &&
      !(ctx.seen && ctx.seen.has(it.tradeId))
    );
    eligible.sort((a, b) => a.buyNow - b.buyNow);
    return eligible[0] || null;
  }

  // Códigos de resposta da EA que importam para o bot.
  function classifyStatus(status) {
    if (status === 458) return 'captcha';
    if (status === 401) return 'session';
    if (status === 426 || status === 429 || status === 512 || status === 521) return 'blocked';
    if (status === 460 || status === 461 || status === 478) return 'missed';
    if (status === 470) return 'nocoins';
    return 'unknown';
  }

  const STOP_REASONS = {
    captcha: 'captcha da EA',
    session: 'sessão expirada',
    blocked: 'limitado pela EA',
    nocoins: 'moedas insuficientes',
  };

  const FATAL_MESSAGES = {
    captcha: 'A EA pediu verificação (captcha). Resolva no Web App e inicie de novo mais tarde.',
    session: 'Sessão expirada. Faça login de novo no Web App.',
    blocked: 'A EA limitou suas buscas (excesso de requisições / soft ban). Parei. Espere algumas horas.',
    nocoins: 'Moedas insuficientes.',
  };

  function randomBetween(min, max, random) {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return lo + (hi - lo) * random();
  }

  function jitter(ms, fraction, random) {
    return ms * (1 - fraction + 2 * fraction * random());
  }

  function checkLimits(stats, s) {
    if (s.maxSearches > 0 && stats.searches >= s.maxSearches) return 'limite de buscas atingido';
    if (s.maxBuys > 0 && stats.buys >= s.maxBuys) return 'limite de compras atingido';
    if (s.budget > 0 && stats.spent >= s.budget) return 'orçamento esgotado';
    return null;
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString('pt-BR');
  }

  // ---------------------------------------------------------------------------
  // Motor do bot
  // ---------------------------------------------------------------------------

  function emptyStats() {
    return { searches: 0, buys: 0, spent: 0, listed: 0, missed: 0, errors: 0, profit: 0 };
  }

  class Autobuyer {
    constructor(opts) {
      this.adapter = opts.adapter;
      this.getState = opts.getState;
      this.log = opts.log || function () {};
      this.onChange = opts.onChange || function () {};
      this.onPurchase = opts.onPurchase || function () {};
      this.random = opts.random || Math.random;
      this.running = false;
      this.status = 'parado';
      this.stopReason = '';
      this.stats = emptyStats();
      this.seen = new Set();
      this.targetIndex = 0;
      this.busterIndex = 0;
      this.consecutiveErrors = 0;
      this._cancelWait = null;
    }

    start() {
      if (this.running) return this.loopPromise;
      this.running = true;
      this.stats = emptyStats();
      this.seen.clear();
      this.consecutiveErrors = 0;
      this.stopReason = '';
      this.setStatus('rodando');
      this.log('Bot iniciado.');
      this.loopPromise = this.loop();
      return this.loopPromise;
    }

    stop(reason) {
      if (!this.running) return;
      this.running = false;
      this.stopReason = reason || 'parado por você';
      this.log('Bot parado: ' + this.stopReason + '.', 'warn');
      this.setStatus('parado');
      if (this._cancelWait) this._cancelWait();
    }

    setStatus(status) {
      this.status = status;
      this.onChange();
    }

    wait(ms) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this._cancelWait = null;
          resolve();
        }, Math.max(0, ms));
        this._cancelWait = () => {
          clearTimeout(timer);
          this._cancelWait = null;
          resolve();
        };
      });
    }

    async loop() {
      try {
        while (this.running) {
          await this.cycle();
          if (!this.running) break;
          const s = this.getState().settings;
          if (s.pauseEvery > 0 && this.stats.searches > 0 && this.stats.searches % s.pauseEvery === 0) {
            const ms = jitter(s.pauseMinutes * 60000, 0.2, this.random);
            this.setStatus('pausado');
            this.log('Pausa de ' + Math.round(ms / 1000) + 's para não chamar atenção.');
            await this.wait(ms);
            if (this.running) this.setStatus('rodando');
          } else {
            await this.wait(randomBetween(s.delayMin * 1000, s.delayMax * 1000, this.random));
          }
        }
      } catch (err) {
        this.log('Erro inesperado: ' + (err && err.message ? err.message : err), 'error');
        this.stop('erro inesperado');
      }
    }

    async cycle() {
      const state = this.getState();
      const s = state.settings;
      const limit = checkLimits(this.stats, s);
      if (limit) return this.stop(limit);

      const active = state.targets.filter((t) => t.enabled);
      if (!active.length) return this.stop('nenhum alvo ativo');
      const target = active[this.targetIndex++ % active.length];

      const res = await this.adapter.search(buildCriteria(target, this.busterIndex++));
      if (!this.running) return;
      this.stats.searches++;
      this.onChange();
      if (!res.success) return this.handleFailure(res.status, 'busca');
      this.consecutiveErrors = 0;

      const budgetLeft = s.budget > 0 ? s.budget - this.stats.spent : Infinity;
      const item = pickCandidate(res.items, target, {
        coins: this.adapter.getCoins(),
        seen: this.seen,
        budgetLeft,
      });
      if (!item) return;
      this.seen.add(item.tradeId);

      this.log('Achei ' + item.name + ' por ' + fmt(item.buyNow) + ' (' + target.name + '). Comprando...');
      const buy = await this.adapter.buy(item.raw, item.buyNow);
      if (!buy.success) {
        if (classifyStatus(buy.status) === 'missed') {
          this.stats.missed++;
          this.log('Perdi: outro jogador comprou antes.', 'warn');
          this.onChange();
          return;
        }
        return this.handleFailure(buy.status, 'compra');
      }

      this.stats.buys++;
      this.stats.spent += item.buyNow;
      const purchase = {
        at: Date.now(),
        name: item.name,
        price: item.buyNow,
        target: target.name,
        sellPrice: target.sellPrice > 0 ? roundDown(target.sellPrice) : 0,
        listed: false,
      };
      this.log('Comprei ' + item.name + ' por ' + fmt(item.buyNow) + '!', 'success');

      if (purchase.sellPrice) {
        await this.wait(randomBetween(800, 1800, this.random));
        const startBid = prevPrice(purchase.sellPrice);
        const listed = await this.adapter.list(item.raw, startBid, purchase.sellPrice);
        if (listed.success) {
          purchase.listed = true;
          this.stats.listed++;
          const profit = netAfterTax(purchase.sellPrice) - purchase.price;
          this.stats.profit += profit;
          this.log('Listei por ' + fmt(purchase.sellPrice) + ' (lucro estimado ' + fmt(profit) + ' após a taxa).', 'success');
        } else {
          this.log('Não consegui listar (erro ' + listed.status + '). A carta ficou em "Não atribuídos".', 'warn');
          if (FATAL_MESSAGES[classifyStatus(listed.status)]) {
            this.onPurchase(purchase);
            return this.handleFailure(listed.status, 'listagem');
          }
        }
      }
      this.onPurchase(purchase);
      this.onChange();
    }

    handleFailure(status, what) {
      const kind = classifyStatus(status);
      if (FATAL_MESSAGES[kind]) {
        this.log(FATAL_MESSAGES[kind], 'error');
        return this.stop(STOP_REASONS[kind]);
      }
      this.stats.errors++;
      this.consecutiveErrors++;
      this.log('Erro ' + status + ' na ' + what + '.', 'warn');
      this.onChange();
      if (this.consecutiveErrors >= 3) this.stop('3 erros seguidos');
    }
  }

  // ---------------------------------------------------------------------------
  // Integração com o Web App da EA
  // ---------------------------------------------------------------------------

  // O Web App expõe objetos globais (services, UTSearchCriteriaDTO...). O bot
  // usa esses mesmos objetos, então as requisições saem idênticas às do app.
  function createEaAdapter(win) {
    let internalCall = false;

    function observe(observable) {
      return new Promise((resolve) => {
        const scope = {};
        observable.observe(scope, function (sender, response) {
          try {
            if (sender && typeof sender.unobserve === 'function') sender.unobserve(scope);
          } catch (e) { /* ignora */ }
          resolve(response || {});
        });
      });
    }

    function itemName(raw) {
      try {
        if (raw._staticData && raw._staticData.name) return raw._staticData.name;
        if (typeof raw.getStaticData === 'function') {
          const d = raw.getStaticData();
          if (d && d.name) return d.name;
        }
      } catch (e) { /* ignora */ }
      return 'carta ' + (raw.definitionId || '?');
    }

    function toItem(raw) {
      const a = raw._auction || {};
      return {
        raw,
        tradeId: a.tradeId,
        buyNow: a.buyNowPrice || 0,
        expires: a.expires,
        name: itemName(raw),
        rating: raw.rating,
      };
    }

    function result(response) {
      return { success: !!response.success, status: response.status };
    }

    return {
      ready() {
        return !!(win.services && win.services.Item && win.UTSearchCriteriaDTO);
      },

      diagnose() {
        const s = win.services || {};
        const item = s.Item || {};
        return [
          ['services.Item.searchTransferMarket', typeof item.searchTransferMarket === 'function'],
          ['services.Item.bid', typeof item.bid === 'function'],
          ['services.Item.list', typeof item.list === 'function'],
          ['UTSearchCriteriaDTO', typeof win.UTSearchCriteriaDTO === 'function'],
          ['saldo de moedas', this.getCoins() != null],
        ];
      },

      getCoins() {
        try {
          return win.services.User.getUser().coins.amount;
        } catch (e) {
          return null;
        }
      },

      hookManualSearch(callback) {
        const svc = win.services.Item;
        const original = svc.searchTransferMarket;
        if (original.__fcabHooked) return;
        const wrapped = function (criteria) {
          if (!internalCall) {
            try { callback(serializeCriteria(criteria)); } catch (e) { /* ignora */ }
          }
          return original.apply(this, arguments);
        };
        wrapped.__fcabHooked = true;
        svc.searchTransferMarket = wrapped;
      },

      async search(criteria) {
        const svc = win.services.Item;
        const dto = new win.UTSearchCriteriaDTO();
        Object.assign(dto, criteria);
        if (typeof svc.clearTransferMarketCache === 'function') svc.clearTransferMarketCache();
        let observable;
        internalCall = true;
        try {
          observable = svc.searchTransferMarket(dto, 1);
        } finally {
          internalCall = false;
        }
        const response = await observe(observable);
        const items = (response.data && response.data.items) || [];
        return Object.assign(result(response), { items: items.map(toItem) });
      },

      async buy(raw, price) {
        return result(await observe(win.services.Item.bid(raw, price)));
      },

      async list(raw, startBid, buyNow) {
        return result(await observe(win.services.Item.list(raw, startBid, buyNow, 3600)));
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Configuração salva no navegador
  // ---------------------------------------------------------------------------

  const STORAGE_KEY = 'fc27-autobuyer:v1';

  const DEFAULT_SETTINGS = {
    delayMin: 4,
    delayMax: 8,
    pauseEvery: 25,
    pauseMinutes: 3,
    maxSearches: 300,
    maxBuys: 10,
    budget: 0,
  };

  function createStore(storage) {
    return {
      load() {
        let saved = {};
        try {
          saved = JSON.parse(storage.getItem(STORAGE_KEY) || '{}') || {};
        } catch (e) {
          saved = {};
        }
        return {
          settings: Object.assign({}, DEFAULT_SETTINGS, saved.settings),
          targets: Array.isArray(saved.targets) ? saved.targets : [],
          history: Array.isArray(saved.history) ? saved.history : [],
        };
      },
      save(state) {
        try {
          storage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) { /* armazenamento indisponível */ }
      },
    };
  }

  function parseCoins(text) {
    const digits = String(text == null ? '' : text).replace(/\D/g, '');
    return digits ? parseInt(digits, 10) : 0;
  }

  // ---------------------------------------------------------------------------
  // Painel
  // ---------------------------------------------------------------------------

  const CSS = `
#fcab-toggle{position:fixed;right:12px;bottom:96px;z-index:2147483646;width:48px;height:48px;border-radius:50%;border:0;background:#1db954;color:#fff;font-size:22px;box-shadow:0 2px 8px rgba(0,0,0,.4)}
#fcab-panel{position:fixed;right:8px;bottom:8px;z-index:2147483647;width:min(380px,calc(100vw - 16px));max-height:78vh;overflow:auto;background:#15171c;color:#e8e8e8;border:1px solid #333;border-radius:12px;font:14px/1.4 -apple-system,system-ui,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.6)}
#fcab-panel[hidden]{display:none}
#fcab-panel *{box-sizing:border-box}
#fcab-panel .h{display:flex;gap:6px;align-items:center;padding:10px;border-bottom:1px solid #2a2d33;position:sticky;top:0;background:#15171c}
#fcab-panel .st{flex:1;font-weight:600}
#fcab-panel .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:#777}
#fcab-panel button{font:inherit;border:0;border-radius:8px;padding:8px 10px;background:#2a2d33;color:#e8e8e8}
#fcab-panel button:disabled{opacity:.4}
#fcab-panel button.go{background:#1db954;color:#fff}
#fcab-panel button.no{background:#c0392b;color:#fff}
#fcab-panel .stats{padding:8px 10px;font-size:12px;color:#aaa;display:grid;grid-template-columns:repeat(3,1fr);gap:4px}
#fcab-panel .stats b{color:#fff;display:block;font-size:14px}
#fcab-panel .tabs{display:flex;gap:4px;padding:0 10px 8px}
#fcab-panel .tabs button{flex:1;padding:6px}
#fcab-panel .tabs button.on{background:#3b3f47}
#fcab-panel section{padding:0 10px 12px}
#fcab-panel section[hidden]{display:none}
#fcab-panel label{display:block;margin:8px 0 2px;font-size:12px;color:#aaa}
#fcab-panel input[type=text],#fcab-panel input:not([type]){width:100%;font-size:16px;padding:7px;border-radius:6px;border:1px solid #3b3f47;background:#0e0f12;color:#fff}
#fcab-panel .hint{font-size:12px;color:#999;margin:6px 0}
#fcab-panel .tg{border:1px solid #2a2d33;border-radius:8px;padding:8px;margin:6px 0}
#fcab-panel .tg .row{display:flex;gap:6px;align-items:center}
#fcab-panel .tg .name{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#fcab-panel .tg .grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
#fcab-panel .tg small{color:#888}
#fcab-panel .log{font:12px/1.35 ui-monospace,Menlo,monospace;white-space:pre-wrap}
#fcab-panel .log div{padding:2px 0;border-bottom:1px solid #1f2126}
#fcab-panel .log .warn{color:#f5c542}
#fcab-panel .log .error{color:#ff6b6b}
#fcab-panel .log .success{color:#4cd97b}
#fcab-panel .full{width:100%;margin-top:8px}
`;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const SETTING_FIELDS = [
    ['delayMin', 'Espera mínima entre buscas (segundos)'],
    ['delayMax', 'Espera máxima entre buscas (segundos)'],
    ['pauseEvery', 'Fazer uma pausa a cada N buscas (0 = nunca)'],
    ['pauseMinutes', 'Duração da pausa (minutos)'],
    ['maxSearches', 'Máximo de buscas por sessão (0 = sem limite)'],
    ['maxBuys', 'Máximo de compras por sessão (0 = sem limite)'],
    ['budget', 'Orçamento máximo por sessão em moedas (0 = sem limite)'],
  ];

  function createUI(win, deps) {
    const doc = win.document;
    const { app, store, engine, adapter } = deps;
    const logs = [];
    let tab = 'targets';

    const style = doc.createElement('style');
    style.textContent = CSS;
    doc.head.appendChild(style);

    const toggle = doc.createElement('button');
    toggle.id = 'fcab-toggle';
    toggle.textContent = '⚡';
    toggle.title = 'FC27 Autobuyer';

    const panel = doc.createElement('div');
    panel.id = 'fcab-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="h">
        <span class="st"><span class="dot"></span><span data-el="status"></span></span>
        <button class="go" data-act="start">Iniciar</button>
        <button class="no" data-act="stop">Parar</button>
        <button data-act="close">✕</button>
      </div>
      <div class="stats" data-el="stats"></div>
      <div class="tabs">
        <button data-tab="targets">Alvos</button>
        <button data-tab="settings">Config</button>
        <button data-tab="log">Log</button>
        <button data-tab="history">Compras</button>
      </div>
      <section data-pane="targets">
        <div data-el="targets"></div>
        <h4 style="margin:12px 0 4px">Novo alvo</h4>
        <p class="hint">Jeito fácil: feche este painel, vá em <b>Transferências → Pesquisar no mercado</b>, escolha o jogador e os filtros e toque em Pesquisar. A busca aparece aqui embaixo automaticamente.</p>
        <p class="hint" data-el="captured">Nenhuma busca capturada ainda.</p>
        <label>Ou ID do jogador na EA (deixe vazio para usar a busca capturada)</label>
        <input data-el="newId" inputmode="numeric">
        <label>Nome (só pra você identificar)</label>
        <input data-el="newName">
        <label>Preço máximo de compra</label>
        <input data-el="newMax" inputmode="numeric">
        <label>Preço de revenda (opcional, vazio = não revende)</label>
        <input data-el="newSell" inputmode="numeric">
        <button class="go full" data-act="add">Adicionar alvo</button>
      </section>
      <section data-pane="settings" hidden>
        <div data-el="settings"></div>
        <button class="full" data-act="diagnose">Diagnóstico do Web App</button>
        <div class="hint" data-el="diag"></div>
      </section>
      <section data-pane="log" hidden><div class="log" data-el="log"></div></section>
      <section data-pane="history" hidden>
        <div class="log" data-el="history"></div>
        <button class="full" data-act="clearHistory">Limpar histórico</button>
      </section>
    `;

    doc.body.appendChild(toggle);
    doc.body.appendChild(panel);

    const el = (name) => panel.querySelector('[data-el="' + name + '"]');

    function save() {
      store.save(app.state);
    }

    function renderTabs() {
      panel.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
      panel.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
      if (tab === 'log') renderLog();
      if (tab === 'history') renderHistory();
    }

    function renderStatus() {
      const colors = { rodando: '#1db954', pausado: '#f5c542', parado: '#777' };
      panel.querySelector('.dot').style.background = colors[engine.status] || '#777';
      let text = engine.status.charAt(0).toUpperCase() + engine.status.slice(1);
      if (engine.status === 'parado' && engine.stopReason) text += ' — ' + engine.stopReason;
      el('status').textContent = text;
      panel.querySelector('[data-act="start"]').disabled = engine.running;
      panel.querySelector('[data-act="stop"]').disabled = !engine.running;
      const st = engine.stats;
      const coins = adapter.getCoins();
      el('stats').innerHTML = [
        ['Moedas', coins == null ? '—' : fmt(coins)],
        ['Buscas', fmt(st.searches)],
        ['Compras', fmt(st.buys)],
        ['Gasto', fmt(st.spent)],
        ['Perdidas', fmt(st.missed)],
        ['Lucro est.', fmt(st.profit)],
      ].map(([k, v]) => '<div>' + k + '<b>' + v + '</b></div>').join('');
    }

    function renderTargets() {
      const box = el('targets');
      if (!app.state.targets.length) {
        box.innerHTML = '<p class="hint">Nenhum alvo ainda. Adicione um abaixo.</p>';
        return;
      }
      box.innerHTML = app.state.targets.map((t) => `
        <div class="tg" data-id="${escapeHtml(t.id)}">
          <div class="row">
            <input type="checkbox" data-f="enabled" ${t.enabled ? 'checked' : ''}>
            <span class="name">${escapeHtml(t.name)}</span>
            <button data-f="remove">🗑</button>
          </div>
          <small>${escapeHtml(describeCriteria(t.criteria))}</small>
          <div class="grid">
            <div><label>Compra até</label><input data-f="maxBuy" inputmode="numeric" value="${t.maxBuy}"></div>
            <div><label>Revende por</label><input data-f="sellPrice" inputmode="numeric" value="${t.sellPrice || ''}"></div>
          </div>
        </div>`).join('');
    }

    function renderSettings() {
      el('settings').innerHTML = SETTING_FIELDS.map(([key, label]) =>
        '<label>' + label + '</label><input data-setting="' + key + '" inputmode="decimal" value="' + app.state.settings[key] + '">'
      ).join('');
    }

    function renderLog() {
      el('log').innerHTML = logs.slice(0, 80).map((l) =>
        '<div class="' + l.level + '">' + l.time + ' ' + escapeHtml(l.msg) + '</div>'
      ).join('') || '<div>Nada ainda.</div>';
    }

    function renderHistory() {
      el('history').innerHTML = app.state.history.map((p) => {
        const when = new Date(p.at).toLocaleString('pt-BR');
        const sell = p.sellPrice ? (p.listed ? ' → listado ' : ' → não listado ') + fmt(p.sellPrice) : '';
        return '<div>' + escapeHtml(when + ' ' + p.name + ' por ' + fmt(p.price) + sell) + '</div>';
      }).join('') || '<div>Nenhuma compra ainda.</div>';
    }

    function onCaptured(criteria) {
      app.captured = criteria;
      el('captured').innerHTML = 'Busca capturada: <b>' + escapeHtml(describeCriteria(criteria)) + '</b>';
      if (!el('newName').value) el('newName').value = describeCriteria(criteria);
    }

    function addTarget() {
      const id = parseCoins(el('newId').value);
      const criteria = id ? { type: 'player', maskedDefId: id } : app.captured;
      if (!criteria) return win.alert('Faça uma busca no mercado ou informe o ID do jogador.');
      const maxBuy = parseCoins(el('newMax').value);
      if (maxBuy < 200) return win.alert('Informe um preço máximo de compra (mínimo 200).');
      const sellPrice = parseCoins(el('newSell').value);
      if (sellPrice && sellPrice <= maxBuy) {
        if (!win.confirm('O preço de revenda é menor ou igual ao de compra. Adicionar mesmo assim?')) return;
      }
      app.state.targets.push({
        id: Date.now().toString(36),
        name: el('newName').value.trim() || describeCriteria(criteria),
        criteria,
        maxBuy,
        sellPrice,
        enabled: true,
      });
      save();
      ['newId', 'newName', 'newMax', 'newSell'].forEach((k) => { el(k).value = ''; });
      renderTargets();
      log('Alvo adicionado.', 'success');
    }

    function log(msg, level) {
      const time = new Date().toLocaleTimeString('pt-BR');
      logs.unshift({ msg, level: level || 'info', time });
      if (logs.length > 200) logs.length = 200;
      if (tab === 'log' && !panel.hidden) renderLog();
    }

    // Mantém a tela do iPhone acesa enquanto o bot roda.
    let wakeLock = null;
    function requestWakeLock() {
      if (!engine.running || !win.navigator.wakeLock) return;
      win.navigator.wakeLock.request('screen').then((l) => { wakeLock = l; }).catch(() => {});
    }
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'visible') requestWakeLock();
      else if (engine.running) log('Aba em segundo plano: o navegador pode pausar o bot.', 'warn');
    });

    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) { renderStatus(); renderTabs(); }
    });

    panel.addEventListener('click', (e) => {
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) { tab = tabBtn.dataset.tab; renderTabs(); return; }
      const act = e.target.closest('[data-act]');
      if (act) {
        const a = act.dataset.act;
        if (a === 'close') panel.hidden = true;
        if (a === 'start') {
          if (!app.state.targets.some((t) => t.enabled)) return win.alert('Adicione e ative pelo menos um alvo.');
          engine.start();
          requestWakeLock();
        }
        if (a === 'stop') {
          engine.stop();
          if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
        }
        if (a === 'add') addTarget();
        if (a === 'diagnose') {
          el('diag').innerHTML = adapter.diagnose().map(([name, ok]) => (ok ? '✅ ' : '❌ ') + escapeHtml(name)).join('<br>');
        }
        if (a === 'clearHistory' && win.confirm('Apagar o histórico de compras?')) {
          app.state.history = [];
          save();
          renderHistory();
        }
        return;
      }
      const tg = e.target.closest('.tg');
      if (tg && e.target.dataset.f === 'remove') {
        if (!win.confirm('Remover este alvo?')) return;
        app.state.targets = app.state.targets.filter((t) => t.id !== tg.dataset.id);
        save();
        renderTargets();
      }
    });

    panel.addEventListener('change', (e) => {
      const key = e.target.dataset.setting;
      if (key) {
        const v = parseFloat(String(e.target.value).replace(',', '.'));
        app.state.settings[key] = isFinite(v) && v >= 0 ? v : DEFAULT_SETTINGS[key];
        e.target.value = app.state.settings[key];
        save();
        return;
      }
      const tg = e.target.closest('.tg');
      const f = e.target.dataset.f;
      if (!tg || !f) return;
      const target = app.state.targets.find((t) => t.id === tg.dataset.id);
      if (!target) return;
      if (f === 'enabled') target.enabled = e.target.checked;
      if (f === 'maxBuy') target.maxBuy = parseCoins(e.target.value) || target.maxBuy;
      if (f === 'sellPrice') target.sellPrice = parseCoins(e.target.value);
      save();
    });

    renderTargets();
    renderSettings();
    renderStatus();
    renderTabs();

    return {
      log,
      onCaptured,
      refresh() {
        if (panel.hidden) return;
        renderStatus();
        if (tab === 'history') renderHistory();
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Inicialização
  // ---------------------------------------------------------------------------

  function safeStorage(win) {
    try {
      const s = win.localStorage;
      s.getItem(STORAGE_KEY);
      return s;
    } catch (e) {
      const mem = {};
      return { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
    }
  }

  function boot(win) {
    const store = createStore(safeStorage(win));
    const app = { state: store.load(), captured: null };
    const adapter = createEaAdapter(win);
    let ui = null;
    const engine = new Autobuyer({
      adapter,
      getState: () => app.state,
      log: (msg, level) => ui && ui.log(msg, level),
      onChange: () => ui && ui.refresh(),
      onPurchase: (p) => {
        app.state.history.unshift(p);
        if (app.state.history.length > 100) app.state.history.length = 100;
        store.save(app.state);
      },
    });
    ui = createUI(win, { app, store, engine, adapter });
    ui.log('Painel carregado. Aguardando o Web App...');

    const timer = setInterval(() => {
      if (!adapter.ready()) return;
      clearInterval(timer);
      adapter.hookManualSearch((criteria) => ui.onCaptured(criteria));
      ui.log('Web App detectado. Pronto para usar.', 'success');
    }, 1000);
  }

  const api = {
    stepAt, roundDown, nextPrice, prevPrice, netAfterTax,
    serializeCriteria, cacheBusterValues, buildCriteria, describeCriteria,
    pickCandidate, classifyStatus, checkLimits, parseCoins,
    Autobuyer, createEaAdapter, createStore, DEFAULT_SETTINGS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined' && window.document) {
    if (window.__fcabLoaded) return;
    window.__fcabLoaded = true;
    boot(window);
  }
})();
