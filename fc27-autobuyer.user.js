// ==UserScript==
// @name         FC27 Autobuyer
// @namespace    fc27-autobuyer
// @version      0.6.0
// @description  Autobuyer para o Web App do EA SPORTS FC 27 Ultimate Team (uso pessoal, por sua conta e risco)
// @match        https://www.ea.com/*ea-sports-fc/ultimate-team/web-app/*
// @grant        none
// @inject-into  page
// @updateURL    https://raw.githubusercontent.com/eduhandrade/fc27-autobuyer/main/fc27-autobuyer.user.js
// @downloadURL  https://raw.githubusercontent.com/eduhandrade/fc27-autobuyer/main/fc27-autobuyer.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Preços do mercado
  // ---------------------------------------------------------------------------

  // A EA só aceita preços em "degraus". Até 1.000 sobe de 50 em 50, até 10.000
  // de 100 em 100, e assim por diante.
  const SCRIPT_VERSION = '0.6.0';

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

  // Campos da busca que precisam ser lidos mesmo quando o objeto da EA os guarda
  // como getter ou com "_" na frente. O tipo (jogador x consumível) é o mais
  // importante: sem ele, uma busca de consumível viraria busca de jogador.
  const KNOWN_CRITERIA_KEYS = ['type', 'category', 'playStyle', 'position', 'zone', 'level', 'rarities',
    'nation', 'league', 'club', 'maskedDefId', 'defId'];

  function plainValue(value) {
    const t = typeof value;
    if (t === 'number' || t === 'string' || t === 'boolean') return value;
    if (Array.isArray(value) && value.every((v) => typeof v !== 'object' && typeof v !== 'function')) return value.slice();
    return undefined;
  }

  function serializeCriteria(criteria) {
    const out = {};
    if (!criteria) return out;
    for (const key of Object.keys(criteria)) {
      if (CONTROLLED_KEYS.includes(key)) continue;
      const value = plainValue(criteria[key]);
      if (value !== undefined) out[key] = value;
    }
    for (const key of KNOWN_CRITERIA_KEYS) {
      if (out[key] !== undefined) continue;
      let value;
      try { value = plainValue(criteria[key]); } catch (e) { value = undefined; }
      if (value === undefined) value = plainValue(criteria['_' + key]);
      if (value !== undefined) out[key] = value;
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

  // Filtros extras. Posição, nível e estilo de química têm nomes conhecidos;
  // clube, liga e país usam o ID da EA (a busca do Web App preenche sozinha).
  const POSITIONS = ['GK', 'RB', 'LB', 'CB', 'CDM', 'CM', 'CAM', 'RM', 'LM', 'RW', 'LW', 'ST'];
  // Posições numéricas usadas internamente pela EA.
  const POSITION_IDS = {
    0: 'GK', 1: 'SW', 2: 'RWB', 3: 'RB', 4: 'RCB', 5: 'CB', 6: 'LCB', 7: 'LB', 8: 'LWB', 9: 'RDM',
    10: 'CDM', 11: 'LDM', 12: 'RM', 13: 'RCM', 14: 'CM', 15: 'LCM', 16: 'LM', 17: 'RAM', 18: 'CAM',
    19: 'LAM', 20: 'RF', 21: 'CF', 22: 'LF', 23: 'RW', 24: 'RS', 25: 'ST', 26: 'LS', 27: 'LW',
  };
  const LEVELS = [['bronze', 'Bronze'], ['silver', 'Prata'], ['gold', 'Ouro'], ['SP', 'Especial']];
  const DEFAULT_CHEM_STYLES = {
    250: 'Basic', 251: 'Sniper', 252: 'Finisher', 253: 'Deadeye', 254: 'Marksman', 255: 'Hawk',
    256: 'Artist', 257: 'Architect', 258: 'Powerhouse', 259: 'Maestro', 260: 'Engine', 261: 'Sentinel',
    262: 'Guardian', 263: 'Gladiator', 264: 'Backbone', 265: 'Anchor', 266: 'Hunter', 267: 'Catalyst',
    268: 'Shadow', 269: 'Wall', 270: 'Shield', 271: 'Cat', 272: 'Glove', 273: 'GK Basic',
  };
  let chemStyles = Object.assign({}, DEFAULT_CHEM_STYLES);
  let chemStylesSource = 'lista padrão';

  // Usa os nomes (e IDs) de estilos de química do próprio jogo quando o Web App
  // oferece a tradução; assim a lista acompanha o FC 27 mesmo se a EA mudar algo.
  function loadChemStyles(localize) {
    if (typeof localize !== 'function') return false;
    const found = {};
    for (let id = 240; id <= 320; id++) {
      let name;
      try { name = localize('playstyles.playstyle' + id); } catch (e) { name = null; }
      if (typeof name === 'string' && name && !/playstyle/i.test(name)) found[id] = name;
    }
    if (Object.keys(found).length < 5) return false;
    chemStyles = found;
    chemStylesSource = 'nomes do jogo';
    return true;
  }

  function chemStyleName(id) {
    return chemStyles[id] || DEFAULT_CHEM_STYLES[id] || ('estilo #' + id);
  }

  function normalizeName(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  }

  function isChemStyleName(name, id) {
    const n = normalizeName(name);
    return !!n && [chemStyles[id], DEFAULT_CHEM_STYLES[id]].some((x) => x && normalizeName(x) === n);
  }

  // Tipo do alvo: define o que a busca procura e o que o bot aceita comprar.
  const KINDS = [['player', 'Jogador'], ['chemstyle', 'Consumível: estilo de química']];

  function kindLabel(kind) {
    return (KINDS.find((k) => k[0] === kind) || [null, 'tipo não definido'])[1];
  }

  // Tipo a partir da busca capturada do Web App. Na dúvida devolve null e o
  // usuário escolhe; nunca assume "jogador".
  function kindFromCriteria(c) {
    if (!c) return null;
    const type = String(c.type || '').toLowerCase();
    const category = String(c.category || '').toLowerCase();
    if (type === 'player') return 'player';
    if (/playstyle|chem/.test(category)) return 'chemstyle';
    if (type === 'training' && c.playStyle > 0) return 'chemstyle';
    return null;
  }

  const PLAYER_FILTER_KEYS = ['position', 'playStyle', 'level', 'club', 'league', 'nation'];
  const PLAYER_ONLY_KEYS = ['position', 'zone', 'level', 'club', 'league', 'nation', 'maskedDefId', 'defId', 'rarities'];
  const NUMERIC_KEYS = ['playStyle', 'club', 'league', 'nation'];

  function isEmptyValue(v) {
    return v == null || v === '' || v === 'any' || v === 0 || v === '0' || v === -1;
  }

  // Monta os critérios da busca para o tipo escolhido. Só reaproveita a busca
  // capturada quando ela é do mesmo tipo.
  function criteriaForKind(kind, base, values) {
    base = base || {};
    if (kind === 'chemstyle') {
      const style = parseInt(values.playStyle, 10);
      const out = kindFromCriteria(base) === 'chemstyle'
        ? Object.assign({}, base)
        : { type: 'training', category: 'playStyle' };
      PLAYER_ONLY_KEYS.forEach((k) => { delete out[k]; });
      if (style > 0) out.playStyle = style;
      else delete out.playStyle;
      return out;
    }
    if (kind === 'player') {
      const out = kindFromCriteria(base) === 'player' ? Object.assign({}, base) : {};
      delete out.category;
      for (const key of PLAYER_FILTER_KEYS) {
        const v = values[key];
        if (isEmptyValue(v)) delete out[key];
        else out[key] = NUMERIC_KEYS.includes(key) ? parseInt(v, 10) : v;
      }
      out.type = 'player';
      return out;
    }
    return Object.assign({}, base);
  }

  function hasPlayerFilter(c, target) {
    c = c || {};
    return !!(c.maskedDefId || (Array.isArray(c.defId) && c.defId.length) ||
      PLAYER_FILTER_KEYS.some((k) => !isEmptyValue(c[k])) ||
      (Array.isArray(c.rarities) && c.rarities.length) ||
      (target && (target.minRating > 0 || target.maxRating > 0)));
  }

  // Motivo para não aceitar o alvo, ou null se está tudo certo.
  function targetProblem(t) {
    if (!t || !KINDS.some((k) => k[0] === t.kind)) return 'escolha o tipo do alvo (jogador ou consumível)';
    const c = t.criteria || {};
    if (t.kind === 'chemstyle') {
      if (!(c.playStyle > 0)) return 'escolha qual estilo de química (consumível) comprar';
      if (kindFromCriteria(c) !== 'chemstyle') return 'a busca não é de consumível';
    }
    if (t.kind === 'player') {
      if (kindFromCriteria(c) !== 'player') return 'a busca não é de jogador';
      if (!hasPlayerFilter(c, t)) return 'escolha um jogador ou pelo menos um filtro';
    }
    if (!(t.maxBuy >= 200)) return 'preço máximo de compra precisa ser pelo menos 200';
    return null;
  }

  function positionsOf(it) {
    const list = [];
    const add = (p) => {
      const name = typeof p === 'number' ? POSITION_IDS[p] : p;
      if (typeof name === 'string' && name) list.push(name.toUpperCase());
    };
    add(it.position);
    (it.positions || []).forEach(add);
    return list;
  }

  // Confere a carta antes de comprar. Devolve o motivo para NÃO comprar, ou
  // null. Na dúvida (dado que o item não informa), não compra.
  function mismatchReason(it, target) {
    const c = target.criteria || {};
    if (target.kind === 'chemstyle') {
      if (it.kind !== 'training') return 'não é consumível';
      if (it.playStyle != null && it.playStyle > 0) return it.playStyle === c.playStyle ? null : 'estilo de química diferente';
      return isChemStyleName(it.name, c.playStyle) ? null : 'não deu para confirmar o estilo do consumível';
    }
    if (target.kind === 'player') {
      if (it.kind !== 'player') return 'não é jogador';
      const need = (want, got, label) => {
        if (isEmptyValue(want)) return null;
        if (got == null) return 'não deu para confirmar ' + label;
        return got === want ? null : label + ' diferente';
      };
      if (!isEmptyValue(c.position)) {
        const pos = positionsOf(it);
        if (!pos.length) return 'não deu para confirmar a posição';
        if (!pos.includes(String(c.position).toUpperCase())) return 'posição diferente';
      }
      return need(c.playStyle, it.playStyle, 'a química') ||
        need(c.club, it.teamId, 'o clube') ||
        need(c.league, it.leagueId, 'a liga') ||
        need(c.nation, it.nationId, 'o país') ||
        (target.minRating > 0 && !(it.rating >= target.minRating) ? 'nota abaixo do mínimo' : null) ||
        (target.maxRating > 0 && !(it.rating <= target.maxRating) ? 'nota acima do máximo' : null);
    }
    return 'alvo sem tipo definido';
  }

  function describeTarget(t) {
    const c = t.criteria || {};
    if (t.kind === 'chemstyle') return 'CONSUMÍVEL · estilo ' + (c.playStyle > 0 ? chemStyleName(c.playStyle) : '?');
    let text = (t.kind === 'player' ? 'JOGADOR · ' : 'TIPO NÃO DEFINIDO · ') + describeCriteria(c);
    if (t.minRating > 0 || t.maxRating > 0) {
      text += ' · nota ' + (t.minRating || '?') + '–' + (t.maxRating || '?');
    }
    return text;
  }

  function describeCriteria(c) {
    if (!c) return '';
    const parts = [];
    if (c.maskedDefId) parts.push('jogador ' + c.maskedDefId);
    if (Array.isArray(c.defId) && c.defId.length) parts.push('carta ' + c.defId.join(','));
    if (c.playStyle > 0) parts.push((kindFromCriteria(c) === 'chemstyle' ? 'estilo ' : 'com química ') + chemStyleName(c.playStyle));
    if (c.level && c.level !== 'any') parts.push('nível ' + ((LEVELS.find((l) => l[0] === c.level) || [])[1] || c.level));
    if (Array.isArray(c.rarities) && c.rarities.length) parts.push('raridade ' + c.rarities.join(','));
    if (c.position && c.position !== 'any') parts.push('posição ' + c.position);
    if (c.league > 0) parts.push('liga ' + c.league);
    if (c.nation > 0) parts.push('país ' + c.nation);
    if (c.club > 0) parts.push('clube ' + c.club);
    return parts.join(' · ') || 'sem filtros';
  }

  function describeItem(it) {
    if (it.kind === 'training') return 'consumível ' + it.name;
    const extra = [];
    if (it.playStyle > 0) extra.push('química ' + chemStyleName(it.playStyle));
    const pos = positionsOf(it)[0];
    if (pos) extra.push(pos);
    return it.name + (it.rating ? ' ' + it.rating : '') + (extra.length ? ' (' + extra.join(', ') + ')' : '');
  }

  // ---------------------------------------------------------------------------
  // Decisão de compra
  // ---------------------------------------------------------------------------

  function pickCandidate(items, target, ctx) {
    const coins = ctx.coins == null ? Infinity : ctx.coins;
    const budgetLeft = ctx.budgetLeft == null ? Infinity : ctx.budgetLeft;
    const eligible = [];
    for (const it of items) {
      if (!(it.buyNow > 0) || it.buyNow > target.maxBuy || it.buyNow > coins || it.buyNow > budgetLeft) continue;
      if (ctx.seen && ctx.seen.has(it.tradeId)) continue;
      const reason = mismatchReason(it, target);
      if (reason) {
        if (ctx.onSkip) ctx.onSkip(it, reason);
        continue;
      }
      eligible.push(it);
    }
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

  // ---------------------------------------------------------------------------
  // Preços do FUTBIN
  // ---------------------------------------------------------------------------

  const FUTBIN_BASE = 'https://www.futbin.com';
  const FUTBIN_YEAR = 27;
  const FUTBIN_MAX_AGE = 15 * 60 * 1000;

  // Cartas especiais usam o ID base do jogador somado a múltiplos de 2^24.
  function baseDefId(defId) {
    return defId % 16777216;
  }

  function parseShortPrice(text) {
    const m = /(\d[\d.,]*)\s*([KM])?/i.exec(String(text || ''));
    if (!m) return 0;
    const suffix = (m[2] || '').toUpperCase();
    if (suffix) {
      const n = parseFloat(m[1].replace(',', '.'));
      return Math.round(n * (suffix === 'K' ? 1000 : 1000000));
    }
    return parseInt(m[1].replace(/[.,]/g, ''), 10) || 0;
  }

  function futbinImageId(hit) {
    try {
      const m = /\/players\/p?(\d+)\.png/.exec(hit.playerImage.fixed.url.image1x);
      return m ? parseInt(m[1], 10) : 0;
    } catch (e) {
      return 0;
    }
  }

  function futbinRating(hit) {
    return parseInt(hit && hit.ratingSquare && hit.ratingSquare.rating, 10) || 0;
  }

  // Escolhe, entre os resultados da busca do FUTBIN, a mesma versão da carta.
  function pickFutbinHit(hits, card) {
    if (!Array.isArray(hits) || !hits.length) return null;
    const base = baseDefId(card.definitionId || 0);
    return (
      hits.find((h) => futbinImageId(h) === card.definitionId) ||
      hits.find((h) => baseDefId(futbinImageId(h)) === base && futbinRating(h) === card.rating) ||
      hits.find((h) => futbinRating(h) === card.rating) ||
      hits.find((h) => baseDefId(futbinImageId(h)) === base) ||
      null
    );
  }

  // Lê o menor preço (BIN) da página do jogador no FUTBIN.
  function parseFutbinPrice(html, platform) {
    const box = platform === 'pc' ? 'platform-pc-only' : 'platform-ps-only';
    const boxRe = new RegExp('class="[^"]*\\b(?:price-box\\b[^"]*\\b' + box + '|' + box + '\\b[^"]*\\bprice-box)\\b[^"]*"');
    const boxMatch = boxRe.exec(html);
    if (boxMatch) {
      const rest = html.slice(boxMatch.index, boxMatch.index + 8000);
      const lowRe = /class="[^"]*lowest-price[^"]*"[^>]*>([\s\S]{0,300}?)<\/(?:div|span)>/g;
      let m;
      while ((m = lowRe.exec(rest))) {
        const price = parseShortPrice(m[1].replace(/<[^>]*>/g, ' '));
        if (price > 0) return price;
      }
    }
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const s = /current price on FUT is ([\d,]+) on PlayStation, ([\d,]+) on Xbox, and ([\d,]+) on PC/.exec(text);
    if (s) return parseShortPrice(platform === 'pc' ? s[3] : s[1]);
    return 0;
  }

  // Sugestão: comprar com a margem configurada abaixo do FUTBIN e revender
  // pelo preço do FUTBIN.
  function suggestPrices(futbinPrice, marginPercent) {
    if (!(futbinPrice > 0)) return null;
    return {
      maxBuy: roundDown(futbinPrice * (1 - (marginPercent || 0) / 100)),
      sellPrice: roundDown(futbinPrice),
    };
  }

  function createFutbin(request, now) {
    now = now || Date.now;
    const cache = new Map();
    return {
      async price(card, platform) {
        const key = card.definitionId + ':' + platform;
        const hit = cache.get(key);
        if (hit && now() - hit.at < FUTBIN_MAX_AGE) return hit;
        const searchUrl = FUTBIN_BASE + '/players/search?targetPage=PLAYER_PAGE&query=' +
          encodeURIComponent(card.name) + '&year=' + FUTBIN_YEAR + '&evolutions=false';
        const body = await request(searchUrl);
        let hits;
        try {
          hits = JSON.parse(body);
        } catch (e) {
          throw new Error('resposta inesperada do FUTBIN na busca: "' + snippet(body) + '"');
        }
        const found = pickFutbinHit(hits, card);
        if (!found) throw new Error(card.name + ' não encontrado no FUTBIN');
        const html = await request(FUTBIN_BASE + '/' + FUTBIN_YEAR + '/player/' + found.id + '/player');
        const price = parseFutbinPrice(html, platform);
        if (!price) throw new Error('preço não encontrado na página do FUTBIN');
        const result = { price, futbinId: found.id, at: now() };
        cache.set(key, result);
        return result;
      },
    };
  }

  function snippet(text) {
    return String(text == null ? '' : text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  // A página da EA não pode ler o futbin.com direto (bloqueio do navegador).
  // O script "ponte" roda com permissão extra e faz a requisição por nós.
  function createBridgeRequest(win, timeoutMs) {
    let seq = 0;
    let ready = false;
    const pending = new Map();
    win.addEventListener('fcab:bridge-ready', () => { ready = true; });
    win.addEventListener('fcab:fetch:result', (e) => {
      let d;
      try { d = JSON.parse(e.detail); } catch (err) { return; }
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      clearTimeout(p.timer);
      if (d.ok) p.resolve(d.text);
      else p.reject(new Error(d.error || 'FUTBIN respondeu ' + d.status));
    });
    win.dispatchEvent(new win.CustomEvent('fcab:ping'));
    function request(url) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('a ponte FUTBIN não respondeu (o script "FC27 Autobuyer - ponte FUTBIN" está instalado?)'));
        }, timeoutMs || 20000);
        pending.set(id, { resolve, reject, timer });
        win.dispatchEvent(new win.CustomEvent('fcab:fetch', { detail: JSON.stringify({ id, url }) }));
      });
    }
    request.isReady = () => ready;
    return request;
  }

  // Preço médio de mercado que a própria EA manda nos dados da carta (o mesmo
  // "Market average" do Web App). Não precisa de rede nem de site externo.
  function readNumberField(item, names) {
    for (const name of names) {
      let v;
      try {
        v = typeof item['get' + name.charAt(0).toUpperCase() + name.slice(1)] === 'function'
          ? item['get' + name.charAt(0).toUpperCase() + name.slice(1)]()
          : undefined;
      } catch (e) { v = undefined; }
      if (v == null) v = item[name];
      if (v == null) v = item['_' + name];
      if (typeof v === 'number' && isFinite(v) && v > 0) return v;
    }
    return null;
  }

  function eaMarketAverage(item) {
    if (!item) return null;
    const direct = readNumberField(item, ['marketAverage']);
    if (direct) return direct;
    // Nome pode vir diferente no objeto do Web App; procura qualquer campo parecido.
    for (const key of Object.keys(item)) {
      if (/market_?average/i.test(key) && typeof item[key] === 'number' && item[key] > 0) return item[key];
    }
    return null;
  }

  // Lista os campos de preço/mercado de um item (para o Diagnóstico).
  function priceFieldsOf(item) {
    if (!item) return '';
    return Object.keys(item)
      .filter((k) => /price|market|average|discard/i.test(k) && typeof item[k] !== 'function')
      .slice(0, 10)
      .map((k) => k + '=' + (item[k] && typeof item[k] === 'object' ? JSON.stringify(item[k]).slice(0, 60) : item[k]))
      .join(', ');
  }

  // Se o FUTBIN bloquear (403/429), para de consultar por um tempo em vez de
  // insistir, o que só piora o bloqueio.
  function withCircuitBreaker(request, opts) {
    opts = opts || {};
    const now = opts.now || Date.now;
    const pauseMs = opts.pauseMs || 30 * 60 * 1000;
    let until = 0;
    const wrapped = async function (url) {
      if (now() < until) {
        throw new Error('FUTBIN bloqueou; consultas pausadas por mais ' + Math.ceil((until - now()) / 60000) + ' min');
      }
      try {
        return await request(url);
      } catch (err) {
        if (/bloqueou|respondeu (403|429)/.test(err && err.message)) until = now() + pauseMs;
        throw err;
      }
    };
    wrapped.isReady = request.isReady;
    wrapped.blocked = () => now() < until;
    return wrapped;
  }

  function formatShort(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 2).replace(/\.?0+$/, '') + 'M';
    if (n >= 10000) return Math.round(n / 1000) + 'K';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  // Preços para as cartas que aparecem na tela. Tenta primeiro o endpoint em
  // lote do FUTBIN (vários jogadores por requisição, pelo ID da EA). Se ele não
  // existir mais, cai para a busca carta a carta, em fila, para não sobrecarregar.
  function createPriceService(request, futbin, opts) {
    opts = opts || {};
    const now = opts.now || Date.now;
    const maxAge = opts.maxAge || 5 * 60 * 1000;
    const batchDelay = opts.batchDelay == null ? 300 : opts.batchDelay;
    const cache = new Map();
    const pending = new Map();
    let queue = [];
    let timer = null;
    let bulkWorks = null;
    let bulkError = '';

    function bulkUrl(ids) {
      return FUTBIN_BASE + '/' + FUTBIN_YEAR + '/playerPrices?player=' + ids[0] +
        (ids.length > 1 ? '&rids=' + ids.slice(1).join(',') : '');
    }

    function settle(key, value, error) {
      const waiters = pending.get(key) || [];
      pending.delete(key);
      if (value) cache.set(key, { price: value, at: now() });
      waiters.forEach((w) => (value ? w.resolve(value) : w.reject(error || new Error('sem preço'))));
    }

    async function tryBulk(jobs, platform) {
      const ids = jobs.map((j) => j.card.definitionId);
      const body = await request(bulkUrl(ids));
      let data;
      try {
        data = JSON.parse(body);
      } catch (e) {
        throw new Error('resposta inesperada: "' + snippet(body) + '"');
      }
      const left = [];
      for (const j of jobs) {
        const entry = data && data[j.card.definitionId];
        const p = entry && entry.prices && entry.prices[platform === 'pc' ? 'pc' : 'ps'];
        const price = p ? parseShortPrice(p.LCPrice) : 0;
        if (price > 0) settle(j.key, price);
        else left.push(j);
      }
      return left;
    }

    async function perCard(jobs, platform) {
      for (const j of jobs) {
        try {
          const r = await futbin.price(j.card, platform);
          settle(j.key, r.price);
        } catch (err) {
          settle(j.key, 0, err);
        }
      }
    }

    async function flush() {
      timer = null;
      const jobs = queue;
      queue = [];
      const byPlatform = {};
      jobs.forEach((j) => { (byPlatform[j.platform] = byPlatform[j.platform] || []).push(j); });
      for (const platform of Object.keys(byPlatform)) {
        let left = byPlatform[platform];
        if (bulkWorks !== false) {
          for (let i = 0; i < left.length; i += 20) {
            const chunk = left.slice(i, i + 20);
            try {
              const rest = await tryBulk(chunk, platform);
              bulkWorks = true;
              await perCard(rest, platform);
            } catch (err) {
              if (bulkWorks === null) {
                bulkWorks = false;
                bulkError = err && err.message ? err.message : String(err);
              }
              await perCard(chunk, platform);
            }
          }
          continue;
        }
        await perCard(left, platform);
      }
    }

    return {
      get(card, platform) {
        const key = card.definitionId + ':' + platform;
        const hit = cache.get(key);
        if (hit && now() - hit.at < maxAge) return Promise.resolve(hit.price);
        return new Promise((resolve, reject) => {
          if (!pending.has(key)) {
            pending.set(key, []);
            queue.push({ key, card, platform });
            if (!timer) timer = setTimeout(flush, batchDelay);
          }
          pending.get(key).push({ resolve, reject });
        });
      },
      bulkStatus: () => bulkWorks,
      bulkError: () => bulkError,
      blocked: () => !!(request.blocked && request.blocked()),
    };
  }

  // Coloca uma etiqueta com o preço do FUTBIN em cada carta desenhada pelo
  // Web App, "pendurando" o código nas funções que desenham as cartas.
  const RENDER_HOOKS = [
    ['UTItemTableCellView', 'render', 'row'],
    ['UTPlayerItemView', 'renderItem', 'card'],
    ['UTItemView', 'renderItem', 'card'],
  ];

  function isPlayerItem(item) {
    if (!item || !item.definitionId) return false;
    if (typeof item.isPlayer === 'function') return item.isPlayer();
    return item.type === 'player' || item.type == null;
  }

  function itemFromView(view, args) {
    const candidates = [args[0], view.data, view._data, view.item, view._item];
    return candidates.find((c) => c && typeof c === 'object' && c.definitionId) || null;
  }

  function rootFromView(view) {
    try {
      if (typeof view.getRootElement === 'function') return view.getRootElement();
    } catch (e) { /* ignora */ }
    return view.__root || view._root || null;
  }

  function createPriceOverlay(win, prices, getSettings, onError) {
    onError = onError || function () {};
    const installed = [];

    let rowSample = '';
    let eaSample = '';
    const counters = { calls: 0, badges: 0, priced: 0, failed: 0, lastError: '' };

    // Elemento que mostra exatamente o nome do jogador (ex.: "Hazard").
    function findNameElement(root, name, exclude) {
      const target = String(name || '').trim().toLowerCase();
      if (!target) return null;
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.classList.contains('fcab-fb')) continue;
        if (exclude && exclude.contains(el)) continue;
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim().toLowerCase();
        if (own === target) return el;
      }
      return null;
    }

    // Nas linhas de lista, a etiqueta vai ao lado do preço (mercado) ou do
    // nome do jogador (clube). Sobre a carta ela seria cortada pela borda.
    function rowSpot(root, name) {
      const auction = root.querySelector('.auction');
      if (auction) return { parent: auction, before: null, mode: 'inline' };
      const nameEl = findNameElement(root, name);
      if (nameEl && nameEl.parentNode) return { parent: nameEl.parentNode, before: nameEl.nextSibling, mode: 'inline' };
      return { parent: root, before: null, mode: 'corner' };
    }

    const badges = new WeakMap();

    // Carta pequena dentro de uma linha (ex.: lista do clube): a etiqueta
    // sobre a miniatura fica cortada, então vai para o lado do nome na linha.
    function moveNextToRowName(root, badge, name) {
      let node = root.parentElement;
      for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
        const nameEl = findNameElement(node, name, root);
        if (nameEl && nameEl.parentNode) {
          nameEl.parentNode.insertBefore(badge, nameEl.nextSibling);
          badge.className = badge.className.replace('fcab-fb-card', 'fcab-fb-inline');
          if (!rowSample) rowSample = 'carta na linha | ' + describeDom(node);
          return true;
        }
      }
      return false;
    }

    function badgeFor(root, kind, name) {
      let badge = badges.get(root);
      if (badge && !badge.isConnected && !root.contains(badge)) badge = null;
      if (!badge) {
        badge = win.document.createElement('div');
        let spot = { parent: root, before: null, mode: 'card' };
        if (kind === 'row') {
          spot = rowSpot(root, name);
          if (!rowSample) rowSample = spot.mode + ' | ' + describeDom(root);
        }
        counters.badges++;
        badge.className = 'fcab-fb fcab-fb-' + spot.mode;
        spot.parent.insertBefore(badge, spot.before);
        badges.set(root, badge);
        // A carta costuma ser desenhada antes de entrar na tela; só dá para
        // conferir o posicionamento depois que ela aparece.
        if (spot.parent === root) {
          let tries = 0;
          const fix = () => {
            if (!root.isConnected) {
              if (++tries < 20) setTimeout(fix, 100);
              return;
            }
            if (spot.mode === 'card' && moveNextToRowName(root, badge, name)) return;
            if (win.getComputedStyle(root).position === 'static') root.style.position = 'relative';
          };
          (win.requestAnimationFrame || setTimeout)(fix);
        }
      }
      return badge;
    }

    function show(view, args, kind) {
      const settings = getSettings();
      if (!settings.showCardPrices) return;
      counters.calls++;
      const item = itemFromView(view, args);
      const root = rootFromView(view);
      if (!root || !root.querySelector || !isPlayerItem(item)) return;
      const card = { name: itemNameOf(item), definitionId: item.definitionId, rating: item.rating };
      const badge = badgeFor(root, kind, card.name);
      const tag = card.definitionId + ':' + settings.platform;
      badge.dataset.tag = tag;
      if (!eaSample) eaSample = priceFieldsOf(item) || '(nenhum campo de preço no item)';
      const bin = item._auction && item._auction.buyNowPrice;
      const avg = eaMarketAverage(item);
      const setPrice = (label, price, title) => {
        badge.textContent = label + ' ' + formatShort(price);
        badge.classList.toggle('fcab-good', bin > 0 && bin < price);
        badge.title = title;
      };
      const showEa = (why) => {
        if (avg) {
          counters.priced++;
          setPrice('Média EA', avg, 'Média de mercado da EA: ' + fmt(avg) + (why ? ' (FUTBIN: ' + why + ')' : ''));
        } else {
          badge.classList.remove('fcab-good');
          badge.textContent = why ? 'FUTBIN ? ' + errorCode(why) : 'Média EA —';
          badge.title = why || 'A EA não informou média de mercado para esta carta';
        }
      };
      if (settings.priceSource !== 'futbin' || prices.blocked()) return showEa(prices.blocked() ? 'bloqueado' : '');
      badge.classList.remove('fcab-good');
      badge.textContent = 'FUTBIN …';
      prices.get(card, settings.platform).then((price) => {
        counters.priced++;
        if (badge.dataset.tag !== tag) return;
        setPrice('FUTBIN', price, 'Menor preço no FUTBIN: ' + fmt(price));
      }).catch((err) => {
        counters.failed++;
        const msg = err && err.message ? err.message : String(err);
        if (msg !== counters.lastError) onError(msg);
        counters.lastError = msg;
        if (badge.dataset.tag === tag) showEa(msg);
      });
    }

    return {
      install() {
        for (const [className, method, kind] of RENDER_HOOKS) {
          const C = lookupGlobal(win, className);
          const proto = C && C.prototype;
          if (!proto || typeof proto[method] !== 'function') continue;
          if (installed.some((h) => h[0] === className)) continue;
          const original = proto[method];
          proto[method] = function () {
            const out = original.apply(this, arguments);
            try { show(this, arguments, kind); } catch (e) { /* nunca quebra o Web App */ }
            return out;
          };
          installed.push([className, method]);
        }
        return installed.map((h) => h[0] + '.' + h[1]);
      },
      installed: () => installed.map((h) => h[0] + '.' + h[1]),
      rowSample: () => rowSample,
      counters: () => counters,
      eaSample: () => eaSample,
    };
  }

  // Código curto do erro, mostrado na própria etiqueta ("FUTBIN ? ponte").
  function errorCode(msg) {
    const m = String(msg || '');
    if (/ponte FUTBIN não respondeu/.test(m)) return 'ponte';
    if (/GM\.xmlHttpRequest/.test(m)) return 'permissão';
    if (/bloqueou/.test(m)) return 'bloqueio';
    if (/demorou/.test(m)) return 'lento';
    if (/falha de rede/.test(m)) return 'rede';
    if (/não encontrado no FUTBIN/.test(m)) return 'não achou';
    if (/resposta inesperada/.test(m)) return 'formato';
    if (/preço não encontrado/.test(m)) return 'sem preço';
    const status = /respondeu (\d+)/.exec(m);
    if (status) return status[1];
    return 'erro';
  }

  // Resumo da estrutura de uma linha, mostrado no Diagnóstico para ajustar a
  // posição da etiqueta se a EA mudar o layout.
  function describeDom(el, depth) {
    depth = depth || 0;
    if (!el || !el.tagName || depth > 3) return '';
    const cls = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    const kids = Array.from(el.children || []).filter((c) => !c.classList.contains('fcab-fb')).slice(0, 6)
      .map((c) => describeDom(c, depth + 1)).filter(Boolean);
    return el.tagName.toLowerCase() + cls + (kids.length ? ' > [' + kids.join(', ') + ']' : '');
  }

  function itemNameOf(raw) {
    try {
      if (raw._staticData && raw._staticData.name) return raw._staticData.name;
      if (typeof raw.getStaticData === 'function') {
        const d = raw.getStaticData();
        if (d && d.name) return d.name;
      }
    } catch (e) { /* ignora */ }
    return String(raw.definitionId);
  }

  function cardFromItems(items) {
    const it = (items || []).find((x) => x.kind == null || x.kind === 'player');
    if (!it || !it.definitionId) return null;
    return { name: it.name, definitionId: it.definitionId, rating: it.rating };
  }

  function emptyStats() {
    return { searches: 0, buys: 0, spent: 0, listed: 0, missed: 0, errors: 0, profit: 0, skipped: 0, simulated: 0 };
  }

  class Autobuyer {
    constructor(opts) {
      this.adapter = opts.adapter;
      this.getState = opts.getState;
      this.log = opts.log || function () {};
      this.onChange = opts.onChange || function () {};
      this.onPurchase = opts.onPurchase || function () {};
      this.onSearchResults = opts.onSearchResults || function () {};
      this.random = opts.random || Math.random;
      this.running = false;
      this.status = 'parado';
      this.stopReason = '';
      this.stats = emptyStats();
      this.seen = new Set();
      this.skipped = new Set();
      this.warned = new Set();
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
      this.skipped = new Set();
      this.warned = new Set();
      this.consecutiveErrors = 0;
      this.stopReason = '';
      this.setStatus('rodando');
      this.log(this.getState().settings.dryRun
        ? 'Bot iniciado em MODO SIMULAÇÃO: nada será comprado.'
        : 'Bot iniciado. Compras de verdade ligadas.');
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

      const active = state.targets.filter((t) => {
        if (!t.enabled) return false;
        const problem = targetProblem(t);
        if (problem && !this.warned.has(t.id)) {
          this.warned.add(t.id);
          this.log('Alvo "' + t.name + '" ignorado: ' + problem + '.', 'error');
        }
        return !problem;
      });
      if (!active.length) return this.stop('nenhum alvo válido e ativo');
      const target = active[this.targetIndex++ % active.length];

      const res = await this.adapter.search(buildCriteria(target, this.busterIndex++));
      if (!this.running) return;
      this.stats.searches++;
      this.onChange();
      if (!res.success) return this.handleFailure(res.status, 'busca');
      this.consecutiveErrors = 0;
      this.onSearchResults(target, res.items);

      const budgetLeft = s.budget > 0 ? s.budget - this.stats.spent : Infinity;
      const item = pickCandidate(res.items, target, {
        coins: this.adapter.getCoins(),
        seen: this.seen,
        budgetLeft,
        onSkip: (it, reason) => {
          if (this.skipped.has(it.tradeId)) return;
          this.skipped.add(it.tradeId);
          this.stats.skipped++;
          this.log('Pulei ' + describeItem(it) + ' por ' + fmt(it.buyNow) + ': ' + reason + '.', 'warn');
        },
      });
      if (!item) return;
      this.seen.add(item.tradeId);

      if (s.dryRun) {
        this.stats.simulated++;
        this.log('SIMULAÇÃO: compraria ' + describeItem(item) + ' por ' + fmt(item.buyNow) +
          ' (' + target.name + '). Nada foi comprado.', 'success');
        this.onChange();
        return;
      }

      const ref = target.futbin && target.futbin.price ? ', FUTBIN ' + fmt(target.futbin.price) : '';
      this.log('Achei ' + describeItem(item) + ' por ' + fmt(item.buyNow) + ' (' + target.name + ref + '). Comprando...');
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

  // Objetos do Web App podem ser globais "de verdade" (window.x) ou globais
  // léxicos (declarados com class/let), que não aparecem em window. Como este
  // script roda dentro da página, dá para ler os dois pelo nome.
  const PAGE_GLOBALS = {
    services: () => (typeof services !== 'undefined' ? services : undefined),
    UTSearchCriteriaDTO: () => (typeof UTSearchCriteriaDTO !== 'undefined' ? UTSearchCriteriaDTO : undefined),
    UTItemTableCellView: () => (typeof UTItemTableCellView !== 'undefined' ? UTItemTableCellView : undefined),
    UTPlayerItemView: () => (typeof UTPlayerItemView !== 'undefined' ? UTPlayerItemView : undefined),
    UTItemView: () => (typeof UTItemView !== 'undefined' ? UTItemView : undefined),
  };

  function lookupGlobal(win, name) {
    if (win && win[name] !== undefined) return win[name];
    try {
      return PAGE_GLOBALS[name] ? PAGE_GLOBALS[name]() : undefined;
    } catch (e) {
      return undefined;
    }
  }

  // O Web App expõe objetos globais (services, UTSearchCriteriaDTO...). O bot
  // usa esses mesmos objetos, então as requisições saem idênticas às do app.
  // Tipo do item que veio na busca: 'player', 'training' (consumível) ou outro.
  // Sem confirmação, devolve null, e o bot não compra.
  function itemKindOf(raw) {
    if (!raw) return null;
    const type = String(raw.type != null ? raw.type : (raw._type != null ? raw._type : '')).toLowerCase();
    let isPlayer = null;
    try { if (typeof raw.isPlayer === 'function') isPlayer = !!raw.isPlayer(); } catch (e) { isPlayer = null; }
    if (isPlayer === true) return 'player';
    if (type === 'player') return isPlayer === false ? null : 'player';
    if (type === 'training') return 'training';
    try { if (typeof raw.isTraining === 'function' && raw.isTraining()) return 'training'; } catch (e) { /* ignora */ }
    return type || null;
  }

  function createEaAdapter(win) {
    let internalCall = false;
    const G = (name) => lookupGlobal(win, name);

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
        definitionId: raw.definitionId,
        kind: itemKindOf(raw),
        playStyle: field(raw, 'playStyle'),
        teamId: field(raw, 'teamId'),
        leagueId: field(raw, 'leagueId'),
        nationId: field(raw, 'nationId'),
        position: any(raw, 'preferredPosition'),
        positions: list(raw, 'possiblePositions'),
      };
    }

    function field(raw, name) {
      const v = raw[name] != null ? raw[name] : raw['_' + name];
      return typeof v === 'number' ? v : undefined;
    }

    function any(raw, name) {
      const v = raw[name] != null ? raw[name] : raw['_' + name];
      return typeof v === 'number' || typeof v === 'string' ? v : undefined;
    }

    function list(raw, name) {
      const v = raw[name] != null ? raw[name] : raw['_' + name];
      return Array.isArray(v) ? v : [];
    }

    function result(response) {
      return { success: !!response.success, status: response.status };
    }

    return {
      ready() {
        const svc = G('services');
        return !!(svc && svc.Item && G('UTSearchCriteriaDTO'));
      },

      diagnose() {
        const s = G('services') || {};
        const item = s.Item || {};
        return [
          ['services.Item.searchTransferMarket', typeof item.searchTransferMarket === 'function'],
          ['services.Item.bid', typeof item.bid === 'function'],
          ['services.Item.list', typeof item.list === 'function'],
          ['UTSearchCriteriaDTO', typeof G('UTSearchCriteriaDTO') === 'function'],
          ['saldo de moedas', this.getCoins() != null],
        ];
      },

      localize() {
        const svc = G('services');
        const loc = svc && svc.Localization;
        return loc && typeof loc.localize === 'function' ? loc.localize.bind(loc) : null;
      },

      getCoins() {
        try {
          return G('services').User.getUser().coins.amount;
        } catch (e) {
          return null;
        }
      },

      hookManualSearch(callback) {
        const svc = G('services').Item;
        const original = svc.searchTransferMarket;
        if (original.__fcabHooked) return;
        const wrapped = function (criteria) {
          const observable = original.apply(this, arguments);
          if (!internalCall) {
            const captured = serializeCriteria(criteria);
            try { callback(captured, null); } catch (e) { /* ignora */ }
            // Os resultados trazem o nome da carta, usado para achar o preço no FUTBIN.
            if (observable && typeof observable.observe === 'function') {
              observe(observable).then((response) => {
                const items = ((response.data && response.data.items) || []).map(toItem);
                const card = cardFromItems(items);
                if (card) callback(captured, card);
              }).catch(() => {});
            }
          }
          return observable;
        };
        wrapped.__fcabHooked = true;
        svc.searchTransferMarket = wrapped;
      },

      async search(criteria) {
        const svc = G('services').Item;
        const dto = new (G('UTSearchCriteriaDTO'))();
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
        return result(await observe(G('services').Item.bid(raw, price)));
      },

      async list(raw, startBid, buyNow) {
        return result(await observe(G('services').Item.list(raw, startBid, buyNow, 3600)));
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
    platform: 'ps',
    futbinMargin: 15,
    showCardPrices: true,
    priceSource: 'ea',
    dryRun: true,
  };

  // Alvos criados antes da versão 0.6 não tinham tipo confirmado (foi assim que
  // uma busca de consumível virou compra de jogador). Ficam desligados até o
  // usuário revisar e salvar.
  function migrateTarget(t) {
    if (!t || t.kind) return t;
    return Object.assign({}, t, { kind: kindFromCriteria(t.criteria), enabled: false, needsReview: true });
  }

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
          targets: (Array.isArray(saved.targets) ? saved.targets : []).map(migrateTarget),
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
.fcab-fb{z-index:5;background:#101418;color:#ffd24d;border:1px solid #ffd24d;border-radius:6px;padding:2px 7px;font:700 13px/1.3 -apple-system,system-ui,sans-serif;white-space:nowrap;pointer-events:none}
.fcab-fb-card{position:absolute;left:50%;top:2px;transform:translateX(-50%);font-size:11px;padding:1px 5px}
.fcab-fb-inline{position:static;display:inline-block;margin:4px 0 4px 8px;vertical-align:middle}
.fcab-fb-corner{position:absolute;top:8px;right:44px}
.fcab-fb.fcab-good{background:#0f3d22;color:#4cd97b;border-color:#4cd97b}
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
#fcab-panel .fberr{margin:0 10px 8px;padding:8px;border-radius:8px;background:#3a1d1d;color:#ffb4b4;font-size:12px;word-break:break-word}
#fcab-panel .fberr[hidden]{display:none}
#fcab-panel .stats{padding:8px 10px;font-size:12px;color:#aaa;display:grid;grid-template-columns:repeat(3,1fr);gap:4px}
#fcab-panel .stats b{color:#fff;display:block;font-size:14px}
#fcab-panel .tabs{display:flex;gap:4px;padding:0 10px 8px}
#fcab-panel .tabs button{flex:1;padding:6px}
#fcab-panel .tabs button.on{background:#3b3f47}
#fcab-panel section{padding:0 10px 12px}
#fcab-panel section[hidden]{display:none}
#fcab-panel label{display:block;margin:8px 0 2px;font-size:12px;color:#aaa}
#fcab-panel input[type=text],#fcab-panel input:not([type]){width:100%;font-size:16px;padding:7px;border-radius:6px;border:1px solid #3b3f47;background:#0e0f12;color:#fff}
#fcab-panel select{width:100%;font-size:16px;padding:7px;border-radius:6px;border:1px solid #3b3f47;background:#0e0f12;color:#fff}
#fcab-panel .fb{margin-top:4px}
#fcab-panel .fe{margin:6px 0}
#fcab-panel .fe [hidden]{display:none}
#fcab-panel .kind{font-weight:700;font-size:13px;margin:4px 0}
#fcab-panel .kind-chemstyle{color:#b58cff}
#fcab-panel .kind-player{color:#6fc3ff}
#fcab-panel .kind-none{color:#ff6b6b}
#fcab-panel .warnbox{background:#3a2a10;color:#ffd24d;border-radius:6px;padding:6px;font-size:12px;margin:4px 0}
#fcab-panel .dry{margin:0 10px 8px;padding:8px;border-radius:8px;background:#3a3210;color:#ffe27a;font-size:12px;font-weight:600}
#fcab-panel .dry[hidden]{display:none}
#fcab-panel .fe-box{border-top:1px solid #2a2d33;margin-top:6px;padding-top:4px}
#fcab-panel .fe-box[hidden]{display:none}
#fcab-panel .tg small+button{padding:3px 8px;font-size:12px}
#fcab-panel .fb button{padding:4px 8px;font-size:12px;margin-top:4px}
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
    ['futbinMargin', 'Margem abaixo do FUTBIN para sugerir a compra (%)'],
  ];

  function createUI(win, deps) {
    const doc = win.document;
    const { app, store, engine, adapter, futbin } = deps;
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
      <div class="dry" data-el="dry" hidden>🧪 MODO SIMULAÇÃO: o bot não compra nada, só mostra no Log o que compraria. Confira e desligue em Config.</div>
      <div class="fberr" data-el="fberr" hidden></div>
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
        <p class="hint" data-el="capturedPrice"></p>
        <div data-el="newFilters"></div>
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

    function renderFutbinError() {
      const box = el('fberr');
      const c = deps.overlay && deps.overlay.counters();
      const msg = c && c.lastError;
      box.hidden = !msg;
      if (msg) box.textContent = '⚠️ FUTBIN não respondeu direito (as cartas mostram a média da EA quando disponível): ' + msg + ' (' + c.priced + ' preços ok, ' + c.failed + ' falhas)';
    }

    function renderStatus() {
      renderFutbinError();
      el('dry').hidden = !app.state.settings.dryRun;
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
            <input type="checkbox" data-f="enabled" ${t.enabled ? 'checked' : ''} ${t.needsReview || targetProblem(t) ? 'disabled' : ''}>
            <span class="name">${escapeHtml(t.name)}</span>
            <button data-f="remove">🗑</button>
          </div>
          <div class="kind kind-${escapeHtml(t.kind || 'none')}">${escapeHtml(describeTarget(t))}</div>
          ${t.needsReview || targetProblem(t) ? '<div class="warnbox">⚠️ ' + escapeHtml(t.needsReview
            ? 'Alvo criado numa versão antiga: confira o tipo e os filtros em ✎ Filtros e salve para poder ativar.'
            : 'Não pode rodar: ' + targetProblem(t) + '.') + '</div>' : ''}
          <button data-f="editFilters">✎ Filtros</button>
          <div class="fe-box" data-fe-for="${escapeHtml(t.id)}" hidden></div>
          ${t.kind === 'player' ? '<div class="fb">' + futbinLine(t) + '</div>' : ''}
          <div class="grid">
            <div><label>Compra até</label><input data-f="maxBuy" inputmode="numeric" value="${t.maxBuy}"></div>
            <div><label>Revende por</label><input data-f="sellPrice" inputmode="numeric" value="${t.sellPrice || ''}"></div>
          </div>
        </div>`).join('');
    }

    // Editor de filtros (usado no "Novo alvo" e em cada alvo). O tipo vem
    // primeiro e decide quais campos aparecem: consumível só tem o estilo.
    function filterEditorHtml(kind, c, t) {
      c = c || {};
      t = t || {};
      const opt = (value, label, current) =>
        '<option value="' + escapeHtml(value) + '"' + (String(current) === String(value) ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
      const styleOptions = (current) => Object.keys(chemStyles).map(Number).sort((a, b) => a - b)
        .map((id) => opt(id, chemStyles[id], current)).join('');
      const num = (v) => (v > 0 ? v : '');
      const hide = (k) => (kind === k ? '' : ' hidden');
      return '<div class="fe">' +
        '<label>Tipo do alvo (obrigatório)</label><select data-fe="kind">' +
        opt('', '— escolha —', kind || '') + KINDS.map((k) => opt(k[0], k[1], kind)).join('') + '</select>' +
        '<div data-kind="chemstyle"' + hide('chemstyle') + '>' +
        '<label>Qual estilo de química (a carta consumível)</label><select data-fe="consumableStyle">' +
        opt('0', '— escolha —', c.playStyle || 0) + styleOptions(c.playStyle) + '</select>' +
        '<p class="hint">Compra só a carta de consumível. Jogadores são sempre ignorados.</p></div>' +
        '<div data-kind="player"' + hide('player') + '>' +
        '<div class="grid">' +
        '<div><label>Posição</label><select data-fe="position">' + opt('any', 'Qualquer', c.position || 'any') +
        POSITIONS.map((p) => opt(p, p, c.position)).join('') + '</select></div>' +
        '<div><label>Química aplicada no jogador</label><select data-fe="playStyle">' + opt('0', 'Qualquer', c.playStyle || 0) +
        styleOptions(c.playStyle) + '</select></div>' +
        '<div><label>Nível</label><select data-fe="level">' + opt('any', 'Qualquer', c.level || 'any') +
        LEVELS.map((l) => opt(l[0], l[1], c.level)).join('') + '</select></div>' +
        '<div><label>Clube / time (ID)</label><input data-fe="club" inputmode="numeric" value="' + num(c.club) + '"></div>' +
        '<div><label>Liga (ID)</label><input data-fe="league" inputmode="numeric" value="' + num(c.league) + '"></div>' +
        '<div><label>País (ID)</label><input data-fe="nation" inputmode="numeric" value="' + num(c.nation) + '"></div>' +
        '<div><label>Nota mínima</label><input data-fe="minRating" inputmode="numeric" value="' + num(t.minRating) + '"></div>' +
        '<div><label>Nota máxima</label><input data-fe="maxRating" inputmode="numeric" value="' + num(t.maxRating) + '"></div>' +
        '</div>' +
        '<p class="hint">Compra só jogadores. Time, liga e país: escolha pelo nome na busca do Web App (Transferências → ' +
        'Pesquisar → Jogadores) que o ID vem preenchido. Antes de comprar, o bot confere posição, química, time, liga, ' +
        'país e nota; se não conseguir confirmar algum, não compra.</p></div>' +
        '<p class="hint">Estilos de química: ' + chemStylesSource + '.</p></div>';
    }

    function readFilterEditor(box) {
      const values = {};
      box.querySelectorAll('[data-fe]').forEach((input) => {
        const key = input.dataset.fe;
        values[key] = input.tagName === 'SELECT' ? input.value : parseCoins(input.value);
      });
      return values;
    }

    // Monta tipo + critérios a partir do editor. base = busca capturada ou alvo atual.
    function targetFromEditor(box, base) {
      const values = readFilterEditor(box);
      const kind = values.kind || null;
      const forKind = kind === 'chemstyle' ? Object.assign({}, values, { playStyle: values.consumableStyle }) : values;
      const player = kind === 'player';
      return {
        kind,
        criteria: kind ? criteriaForKind(kind, base, forKind) : Object.assign({}, base),
        minRating: player ? values.minRating || 0 : 0,
        maxRating: player ? values.maxRating || 0 : 0,
      };
    }

    function renderNewFilters() {
      el('newFilters').innerHTML = filterEditorHtml(kindFromCriteria(app.captured), app.captured, null);
    }

    function futbinLine(t) {
      if (!t.card) return '<small>FUTBIN: pesquise esse jogador no mercado (ou inicie o bot) para identificar a carta.</small>';
      const f = t.futbin;
      if (t.futbinError) return '<small>FUTBIN: ' + escapeHtml(t.futbinError) + '</small> <button data-f="futbin">↻</button>';
      if (!f || !f.price) return '<small>FUTBIN: —</small> <button data-f="futbin">↻ Buscar preço</button>';
      const mins = Math.max(0, Math.round((Date.now() - f.at) / 60000));
      const sug = suggestPrices(f.price, app.state.settings.futbinMargin);
      return '<small>FUTBIN: <b>' + fmt(f.price) + '</b> (há ' + mins + ' min) · sugestão: compra até ' +
        fmt(sug.maxBuy) + ', revende ' + fmt(sug.sellPrice) + '</small><br>' +
        '<button data-f="futbin">↻</button> <button data-f="applySuggestion">Usar sugestão</button>';
    }

    async function refreshTargetPrice(t, quiet) {
      if (!t.card) return;
      try {
        t.futbin = await futbin.price(t.card, app.state.settings.platform);
        t.futbinError = '';
      } catch (err) {
        t.futbinError = err.message;
        if (!quiet) log('FUTBIN (' + t.name + '): ' + err.message, 'warn');
      }
      save();
      renderTargets();
    }

    async function refreshStalePrices() {
      for (const t of app.state.targets) {
        if (t.card && (!t.futbin || Date.now() - t.futbin.at > FUTBIN_MAX_AGE)) await refreshTargetPrice(t, true);
      }
    }

    function renderSettings() {
      const platform = app.state.settings.platform;
      el('settings').innerHTML = '<label>Plataforma (preço do FUTBIN)</label><select data-setting="platform">' +
        '<option value="ps"' + (platform !== 'pc' ? ' selected' : '') + '>PlayStation / Xbox</option>' +
        '<option value="pc"' + (platform === 'pc' ? ' selected' : '') + '>PC</option></select>' +
        '<label style="color:#ffd24d"><input type="checkbox" data-setting="dryRun"' + (app.state.settings.dryRun ? ' checked' : '') +
        '> Modo simulação: procura mas NÃO compra (use para testar alvos novos)</label>' +
        '<label><input type="checkbox" data-setting="showCardPrices"' + (app.state.settings.showCardPrices ? ' checked' : '') +
        '> Mostrar preço em cada carta</label>' +
        '<label>Preço mostrado nas cartas</label><select data-setting="priceSource">' +
        '<option value="ea"' + (app.state.settings.priceSource !== 'futbin' ? ' selected' : '') + '>Média de mercado da EA (recomendado)</option>' +
        '<option value="futbin"' + (app.state.settings.priceSource === 'futbin' ? ' selected' : '') + '>FUTBIN (pode ser bloqueado)</option></select>' +
        SETTING_FIELDS.map(([key, label]) =>
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

    function onCaptured(criteria, card) {
      const kind = kindFromCriteria(criteria);
      if (kind !== 'player') card = null;
      app.captured = criteria;
      app.capturedCard = card || null;
      if (!card) renderNewFilters();
      const kindText = kind ? kindLabel(kind).toUpperCase() : 'TIPO NÃO RECONHECIDO (escolha abaixo)';
      const label = (card ? card.name + ' ' + (card.rating || '') + ' · ' : '') + describeCriteria(criteria);
      el('captured').innerHTML = 'Busca capturada: <b>' + escapeHtml(kindText) + '</b> · ' + escapeHtml(label);
      el('capturedPrice').textContent = card ? 'FUTBIN: buscando preço...' : '';
      if (!card) {
        if (!el('newName').value) {
          el('newName').value = kind === 'chemstyle' && criteria.playStyle > 0
            ? 'Consumível ' + chemStyleName(criteria.playStyle) : describeCriteria(criteria);
        }
        return;
      }
      el('newName').value = card.name + ' ' + (card.rating || '');
      futbin.price(card, app.state.settings.platform).then((f) => {
        if (app.capturedCard !== card) return;
        app.capturedFutbin = f;
        const sug = suggestPrices(f.price, app.state.settings.futbinMargin);
        el('capturedPrice').innerHTML = 'FUTBIN: <b>' + fmt(f.price) + '</b> · sugestão preenchida abaixo (compra ' +
          fmt(sug.maxBuy) + ', revenda ' + fmt(sug.sellPrice) + ').';
        if (!el('newMax').value) el('newMax').value = sug.maxBuy;
        if (!el('newSell').value) el('newSell').value = sug.sellPrice;
      }).catch((err) => {
        if (app.capturedCard !== card) return;
        el('capturedPrice').textContent = 'FUTBIN: ' + err.message;
      });
    }

    function addTarget() {
      const id = parseCoins(el('newId').value);
      const edited = targetFromEditor(el('newFilters'), id ? { type: 'player', maskedDefId: id } : (app.captured || {}));
      if (id && edited.kind !== 'player') return win.alert('O ID de jogador só vale para o tipo "Jogador".');
      const maxBuy = parseCoins(el('newMax').value);
      const draft = Object.assign({}, edited, { maxBuy });
      const problem = targetProblem(draft);
      if (problem) return win.alert('Não dá para adicionar: ' + problem + '.');
      const sellPrice = parseCoins(el('newSell').value);
      if (sellPrice && sellPrice <= maxBuy) {
        if (!win.confirm('O preço de revenda é menor ou igual ao de compra. Adicionar mesmo assim?')) return;
      }
      const card = id || edited.kind !== 'player' ? null : app.capturedCard;
      const summary = describeTarget(draft);
      if (!win.confirm('Confirme o alvo:\n\n' + summary + '\nCompra até ' + fmt(maxBuy) +
        (app.state.settings.dryRun ? '\n\n(Modo simulação ligado: nada será comprado.)' : '\n\nATENÇÃO: compras de verdade.'))) return;
      app.state.targets.push({
        id: Date.now().toString(36),
        name: el('newName').value.trim() || summary,
        kind: edited.kind,
        criteria: edited.criteria,
        minRating: edited.minRating,
        maxRating: edited.maxRating,
        maxBuy,
        sellPrice,
        enabled: true,
        card,
        futbin: card && app.capturedFutbin && app.capturedCard === card ? app.capturedFutbin : null,
      });
      save();
      ['newId', 'newName', 'newMax', 'newSell'].forEach((k) => { el(k).value = ''; });
      app.captured = null;
      app.capturedCard = null;
      el('captured').textContent = 'Nenhuma busca capturada ainda.';
      el('capturedPrice').textContent = '';
      renderNewFilters();
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
      if (!panel.hidden) { renderStatus(); renderTabs(); refreshStalePrices(); }
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
          const hooks = deps.overlay.installed();
          const bulk = deps.prices.bulkStatus();
          const rows = adapter.diagnose().concat([
            ['ponte FUTBIN (segundo script)', futbin.bridgeReady()],
            ['preço nas cartas: ' + (hooks.length ? hooks.join(', ') : 'nenhuma função de desenho encontrada'), hooks.length > 0],
            ['linha: ' + (deps.overlay.rowSample() || 'nenhuma lista vista ainda').slice(0, 400), true],
            ['campos de preço da EA: ' + (deps.overlay.eaSample() || 'nenhuma carta vista ainda'), /market/i.test(deps.overlay.eaSample())],
            (() => {
              const c = deps.overlay.counters();
              return ['cartas desenhadas: ' + c.calls + ', etiquetas: ' + c.badges + ', com preço: ' + c.priced +
                ', falhas: ' + c.failed + (c.lastError ? ' (último erro: ' + c.lastError + ')' : ''), c.failed === 0];
            })(),
            ['FUTBIN em lote: ' + (bulk === null ? 'ainda não testado' : bulk ? 'funcionando' : 'indisponível (' + deps.prices.bulkError() + '), usando carta a carta'), bulk !== false],
          ]);
          rows.unshift(['versão do script: ' + SCRIPT_VERSION, true]);
          el('diag').innerHTML = rows.map(([name, ok]) => (ok ? '✅ ' : '❌ ') + escapeHtml(name)).join('<br>');
        }
        if (a === 'clearHistory' && win.confirm('Apagar o histórico de compras?')) {
          app.state.history = [];
          save();
          renderHistory();
        }
        return;
      }
      const tg = e.target.closest('.tg');
      const tgt = tg && app.state.targets.find((t) => t.id === tg.dataset.id);
      if (tgt && e.target.dataset.f === 'editFilters') {
        const box = tg.querySelector('.fe-box');
        box.hidden = !box.hidden;
        if (!box.hidden) {
          box.innerHTML = filterEditorHtml(tgt.kind, tgt.criteria, tgt) +
            '<button data-f="saveFilters">Salvar filtros</button> ' +
            (app.captured ? '<button data-f="useCaptured">Usar a última busca do mercado</button>' : '');
        }
        return;
      }
      if (tgt && e.target.dataset.f === 'useCaptured' && app.captured) {
        // Só preenche o editor; nada muda até o usuário conferir e salvar.
        const box = tg.querySelector('.fe-box');
        box.dataset.base = JSON.stringify(app.captured);
        box.querySelector('.fe').outerHTML = filterEditorHtml(kindFromCriteria(app.captured), app.captured, tgt);
        log('Editor preenchido com a última busca. Confira o tipo e toque em Salvar filtros.', 'warn');
        return;
      }
      if (tgt && e.target.dataset.f === 'saveFilters') {
        const box = tg.querySelector('.fe-box');
        const base = box.dataset.base ? JSON.parse(box.dataset.base) : tgt.criteria;
        const edited = targetFromEditor(box, base);
        const draft = Object.assign({}, tgt, edited);
        const problem = targetProblem(draft);
        if (problem) return win.alert('Não dá para salvar: ' + problem + '.');
        if (!win.confirm('Confirme o alvo:\n\n' + describeTarget(draft) + '\nCompra até ' + fmt(tgt.maxBuy))) return;
        Object.assign(tgt, edited, { needsReview: false });
        if (tgt.kind !== 'player') { tgt.card = null; tgt.futbin = null; }
        save();
        renderTargets();
        log('Filtros de ' + tgt.name + ' salvos: ' + describeTarget(tgt) + '.', 'success');
        return;
      }
      if (tgt && e.target.dataset.f === 'futbin') {
        e.target.disabled = true;
        refreshTargetPrice(tgt, false);
        return;
      }
      if (tgt && e.target.dataset.f === 'applySuggestion' && tgt.futbin) {
        const sug = suggestPrices(tgt.futbin.price, app.state.settings.futbinMargin);
        tgt.maxBuy = sug.maxBuy;
        tgt.sellPrice = sug.sellPrice;
        save();
        renderTargets();
        log('Preços de ' + tgt.name + ' ajustados pelo FUTBIN.', 'success');
        return;
      }
      if (tg && e.target.dataset.f === 'remove') {
        if (!win.confirm('Remover este alvo?')) return;
        app.state.targets = app.state.targets.filter((t) => t.id !== tg.dataset.id);
        save();
        renderTargets();
      }
    });

    panel.addEventListener('change', (e) => {
      const key = e.target.dataset.setting;
      if (key === 'priceSource') {
        app.state.settings.priceSource = e.target.value === 'futbin' ? 'futbin' : 'ea';
        save();
        log('Preço nas cartas: ' + (app.state.settings.priceSource === 'ea' ? 'média da EA' : 'FUTBIN') + '. Troque de tela para atualizar.', 'success');
        return;
      }
      if (key === 'dryRun') {
        if (!e.target.checked && !win.confirm('Desligar a simulação? A partir daí o bot COMPRA de verdade.')) {
          e.target.checked = true;
          return;
        }
        app.state.settings.dryRun = e.target.checked;
        save();
        renderStatus();
        log(app.state.settings.dryRun ? 'Modo simulação ligado.' : 'Modo simulação desligado: compras de verdade.', 'warn');
        return;
      }
      if (key === 'showCardPrices') {
        app.state.settings.showCardPrices = e.target.checked;
        save();
        return;
      }
      if (key === 'platform') {
        app.state.settings.platform = e.target.value === 'pc' ? 'pc' : 'ps';
        app.state.targets.forEach((t) => { t.futbin = null; });
        save();
        refreshStalePrices();
        return;
      }
      if (key) {
        const v = parseFloat(String(e.target.value).replace(',', '.'));
        app.state.settings[key] = isFinite(v) && v >= 0 ? v : DEFAULT_SETTINGS[key];
        e.target.value = app.state.settings[key];
        save();
        if (key === 'futbinMargin') renderTargets();
        return;
      }
      if (e.target.dataset.fe === 'kind') {
        const fe = e.target.closest('.fe');
        fe.querySelectorAll('[data-kind]').forEach((sec) => { sec.hidden = sec.dataset.kind !== e.target.value; });
        return;
      }
      if (e.target.dataset.fe) return;
      const tg = e.target.closest('.tg');
      const f = e.target.dataset.f;
      if (!tg || !f) return;
      const target = app.state.targets.find((t) => t.id === tg.dataset.id);
      if (!target) return;
      if (f === 'enabled') {
        const problem = target.needsReview ? 'revise o alvo em ✎ Filtros e salve' : targetProblem(target);
        if (e.target.checked && problem) {
          e.target.checked = false;
          return win.alert('Não dá para ativar: ' + problem + '.');
        }
        target.enabled = e.target.checked;
      }
      if (f === 'maxBuy') target.maxBuy = parseCoins(e.target.value) || target.maxBuy;
      if (f === 'sellPrice') target.sellPrice = parseCoins(e.target.value);
      save();
    });

    renderTargets();
    renderNewFilters();
    renderSettings();
    renderStatus();
    renderTabs();

    return {
      log,
      onCaptured,
      refreshFilters() {
        renderNewFilters();
        renderTargets();
      },
      onTargetCard(t) {
        refreshTargetPrice(t, true);
      },
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
    const bridge = createBridgeRequest(win);
    const futbinRequest = withCircuitBreaker(bridge);
    const futbin = Object.assign(createFutbin(futbinRequest), { bridgeReady: bridge.isReady });
    const prices = createPriceService(futbinRequest, futbin);
    const overlay = createPriceOverlay(win, prices, () => app.state.settings, (msg) => {
      if (ui) ui.log('FUTBIN: ' + msg, 'error');
    });
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
      // Alvos criados por ID ainda não sabem qual é a carta; a primeira busca
      // do bot traz o nome, e aí dá para consultar o FUTBIN.
      onSearchResults: (target, items) => {
        const c = target.criteria || {};
        if (target.kind !== 'player' || target.card || !(c.maskedDefId || (Array.isArray(c.defId) && c.defId.length))) return;
        const card = cardFromItems(items);
        if (!card) return;
        target.card = card;
        store.save(app.state);
        ui.onTargetCard(target);
      },
    });
    ui = createUI(win, { app, store, engine, adapter, futbin, prices, overlay });
    ui.log('Painel carregado. Aguardando o Web App...');

    const timer = setInterval(() => {
      if (!adapter.ready()) return;
      clearInterval(timer);
      adapter.hookManualSearch((criteria, card) => ui.onCaptured(criteria, card));
      if (loadChemStyles(adapter.localize())) ui.refreshFilters();
      const hooks = overlay.install();
      ui.log('Web App detectado. Pronto para usar.', 'success');
      if (!hooks.length) ui.log('Não achei as funções que desenham as cartas; o preço do FUTBIN não vai aparecer nelas. Veja o Diagnóstico.', 'warn');
    }, 1000);
  }

  const api = {
    stepAt, roundDown, nextPrice, prevPrice, netAfterTax,
    serializeCriteria, cacheBusterValues, buildCriteria, describeCriteria,
    pickCandidate, classifyStatus, checkLimits, parseCoins,
    Autobuyer, createEaAdapter, createStore, DEFAULT_SETTINGS,
    baseDefId, parseShortPrice, pickFutbinHit, parseFutbinPrice, suggestPrices,
    createFutbin, createBridgeRequest, cardFromItems,
    formatShort, createPriceService, createPriceOverlay, lookupGlobal, errorCode,
    eaMarketAverage, priceFieldsOf, withCircuitBreaker,
    kindFromCriteria, criteriaForKind, hasPlayerFilter, targetProblem, mismatchReason, describeTarget,
    describeItem, itemKindOf, migrateTarget, loadChemStyles, chemStyleName,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined' && window.document) {
    if (window.__fcabLoaded) return;
    window.__fcabLoaded = true;
    boot(window);
  }
})();
