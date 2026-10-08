// ==UserScript==
// @name         FC27 Autobuyer
// @namespace    fc27-autobuyer
// @version      1.8.2
// @description  Autobuyer para o Web App do EA SPORTS FC 27 Ultimate Team (uso pessoal, por sua conta e risco)
// @match        https://www.ea.com/*ea-sports-fc/ultimate-team/web-app/*
// @match        https://www.futbin.com/*
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
  const SCRIPT_VERSION = '1.8.2';

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

  // Um degrau acima (dir 1) ou abaixo (dir -1) na escada de preços da EA.
  function stepPrice(price, dir) {
    if (!(price > 0)) return dir > 0 ? MIN_PRICE : 0;
    return dir > 0 ? nextPrice(price) : prevPrice(price);
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
    // Filtros que a EA guarda como getter no protótipo (ex.: o de PlayStyle+).
    let proto = Object.getPrototypeOf(criteria);
    for (let depth = 0; proto && proto !== Object.prototype && depth < 5; depth++, proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === 'constructor' || out[key] !== undefined || CONTROLLED_KEYS.includes(key)) continue;
        const desc = Object.getOwnPropertyDescriptor(proto, key);
        if (!desc || typeof desc.get !== 'function') continue;
        let value;
        try { value = plainValue(criteria[key]); } catch (e) { value = undefined; }
        if (value !== undefined) out[key] = value;
      }
    }
    return out;
  }

  // Descobre qual campo da busca é o filtro "PlayStyle: PlayStyle+" do Web App,
  // comparando uma busca capturada com os valores padrão da EA.
  function learnPsPlusField(captured, defaults) {
    if (!captured || !defaults) return null;
    const known = new Set(KNOWN_CRITERIA_KEYS.concat(CONTROLLED_KEYS));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const hits = Object.keys(captured).filter((key) => {
      const bare = key.replace(/^_+/, '');
      if (known.has(bare) || /^playstyle$/i.test(bare)) return false;
      if (!/play.?style|trait|plus|^ps/i.test(bare)) return false;
      return !same(captured[key], defaults[key]);
    });
    if (!hits.length) return null;
    // Prefere o nome sem "_" (getter) ao campo interno equivalente.
    const key = hits.find((k) => !k.startsWith('_')) || hits[0];
    const bare = key.replace(/^_+/, '');
    const internal = hits.find((k) => k !== key && k.replace(/^_+/, '') === bare) || null;
    return { key, internal, value: captured[key], off: defaults[key] === undefined ? null : defaults[key] };
  }

  function applyPsPlus(criteria, on, field) {
    const out = Object.assign({}, criteria);
    if (!field) return out;
    [field.key, field.internal, '_' + field.key.replace(/^_+/, ''), field.key.replace(/^_+/, '')].forEach((k) => { if (k) delete out[k]; });
    if (on) {
      out[field.key] = field.value;
      if (field.internal) out[field.internal] = field.value;
    }
    return out;
  }

  function hasPsPlusFilter(criteria, field) {
    return !!(field && criteria && JSON.stringify(criteria[field.key]) === JSON.stringify(field.value));
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

  // Com "Buscar a partir de": o preço mínimo da busca varia só alguns degraus
  // acima do valor escolhido (para não vir resultado repetido do cache).
  function minPriceValues(minPrice, maxBuy) {
    const top = roundDown(maxBuy);
    let p = roundDown(minPrice);
    const values = [];
    for (let i = 0; i < 4 && p < top; i++) {
      values.push(p);
      p = nextPrice(p);
    }
    return values.length ? values : [0];
  }

  function buildCriteria(target, busterIndex) {
    const values = target.minPrice > 0 && target.minPrice < target.maxBuy
      ? minPriceValues(target.minPrice, target.maxBuy)
      : cacheBusterValues(target.maxBuy);
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
  // Grupos de posição do filtro do Web App (Defenders / Midfielders / Attackers).
  const ZONES = [
    ['defense', 'Defensores', ['RB', 'LB', 'CB', 'RWB', 'LWB', 'SW', 'RCB', 'LCB'], 'defensor'],
    ['midfield', 'Meio-campistas', ['CDM', 'CM', 'CAM', 'RM', 'LM', 'RDM', 'LDM', 'RCM', 'LCM', 'RAM', 'LAM'], 'meio-campista'],
    ['attacker', 'Atacantes', ['ST', 'CF', 'RW', 'LW', 'RF', 'LF', 'RS', 'LS'], 'atacante'],
  ];

  // Aceita o valor que a EA usar para a zona ("defense", "defenders"...).
  function zoneInfo(value) {
    const v = String(value == null ? '' : value).toLowerCase();
    if (!v || v === 'any' || v === '-1') return null;
    return ZONES.find((z) => v === z[0] || v.startsWith(z[0].slice(0, 5))) || null;
  }

  // Posição da busca do Web App em qualquer formato (texto, número, lista,
  // outro nome de campo) → { position: 'CB' } ou { zone: 'defense' }.
  const POSITION_KEYS = ['position', 'zone', 'pos', 'positions', 'preferredPosition', 'posGroup', 'positionGroup', '_position', '_zone'];
  const ALL_POSITIONS = ['GK', 'RWB', 'LWB', 'RB', 'LB', 'CB', 'CDM', 'CM', 'CAM', 'RM', 'LM', 'RW', 'LW', 'RF', 'LF', 'CF', 'ST'];
  function readPositionFilter(c) {
    const out = { position: '', zone: '', key: '' };
    if (!c) return out;
    for (const key of POSITION_KEYS) {
      let v = c[key];
      if (Array.isArray(v)) v = v.length === 1 ? v[0] : null;
      if (v == null || v === '' || v === -1 || v === '-1') continue;
      // Número em campo de grupo (zone) é formato próprio da EA: não é posição.
      const groupKey = /zone|group/i.test(key);
      if (groupKey && (typeof v === 'number' || /^\d+$/.test(String(v)))) continue;
      if (typeof v === 'number') {
        const name = POSITION_IDS[v];
        if (name && ALL_POSITIONS.includes(name)) { out.position = name; out.key = key; return out; }
        continue;
      }
      const t = String(v).trim();
      if (!t || /^any$/i.test(t)) continue;
      if (/^\d+$/.test(t)) {
        const name = POSITION_IDS[parseInt(t, 10)];
        if (name && ALL_POSITIONS.includes(name)) { out.position = name; out.key = key; return out; }
        continue;
      }
      const up = t.toUpperCase();
      if (ALL_POSITIONS.includes(up)) { out.position = up; out.key = key; return out; }
      if (/^def/i.test(t)) { out.zone = 'defense'; out.key = key; return out; }
      if (/^mid/i.test(t)) { out.zone = 'midfield'; out.key = key; return out; }
      if (/^(att|fwd|forw|ata)/i.test(t)) { out.zone = 'attacker'; out.key = key; return out; }
    }
    return out;
  }

  function zoneLabel(value) {
    const z = zoneInfo(value);
    return z ? z[1] : 'Grupo de posição da busca';
  }
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

  // PlayStyles (traitId -> nome), na ordem das categorias do jogo. A carta
  // informa os seus via getPlayStyles(): [{ traitId, isIcon }], isIcon = "+".
  const PLAYSTYLES = {
    0: 'Finesse Shot', 1: 'Chip Shot', 2: 'Power Shot', 3: 'Dead Ball', 4: 'Precision Header', 5: 'Acrobatic',
    6: 'Low Driven Shot', 7: 'Gamechanger', 8: 'Incisive Pass', 9: 'Pinged Pass', 10: 'Long Ball Pass',
    11: 'Tiki Taka', 12: 'Whipped Pass', 13: 'Inventive', 14: 'Jockey', 15: 'Block', 16: 'Intercept',
    17: 'Anticipate', 18: 'Slide Tackle', 19: 'Aerial Fortress', 20: 'Technical', 21: 'Rapid', 22: 'First Touch',
    23: 'Trickster', 24: 'Press Proven', 25: 'Quick Step', 26: 'Relentless', 27: 'Long Throw', 28: 'Bruiser',
    29: 'Enforcer', 30: 'Far Throw', 31: 'Footwork', 32: 'Cross Claimer', 33: '1v1 Close Down', 34: 'Far Reach',
    35: 'Deflector',
  };
  const PLAYSTYLE_GROUPS = [
    ['Finalização', [0, 1, 2, 3, 4, 5, 6, 7]],
    ['Passe', [8, 9, 10, 11, 12, 13]],
    ['Defesa', [14, 15, 16, 17, 18, 19]],
    ['Controle de bola', [20, 21, 22, 23, 24]],
    ['Físico', [25, 26, 27, 28, 29]],
    ['Goleiro', [30, 31, 32, 33, 34, 35]],
  ];

  function playStyleName(id, plus) {
    return (PLAYSTYLES[id] || 'PlayStyle #' + id) + (plus ? '+' : '');
  }

  // Normaliza o que a EA devolve em getPlayStyles() para [{ id, plus }].
  function readPlayStyles(raw) {
    let list;
    try {
      list = typeof raw.getPlayStyles === 'function' ? raw.getPlayStyles() : undefined;
    } catch (e) {
      list = undefined;
    }
    if (!Array.isArray(list)) return undefined;
    return list
      .map((p) => ({
        id: typeof p === 'number' ? p : (p && (p.traitId != null ? p.traitId : p.id)),
        plus: !!(p && typeof p === 'object' && (p.isIcon || p.plus || p.isPlus)),
      }))
      .filter((p) => typeof p.id === 'number');
  }

  // Motivo para não comprar por causa dos PlayStyles exigidos, ou null.
  function playStyleMismatch(itemStyles, required) {
    if (!required || !required.length) return null;
    if (!Array.isArray(itemStyles)) return 'não deu para confirmar os PlayStyles';
    for (const req of required) {
      const has = itemStyles.find((p) => p.id === req.id);
      if (!has) return 'sem ' + playStyleName(req.id, req.plus);
      if (req.plus && !has.plus) return 'tem ' + playStyleName(req.id) + ' mas não o +';
    }
    return null;
  }

  // "Tem PlayStyle+": se a carta informa os PlayStyles, confere; se não
  // informa, só aceita quando o próprio filtro da EA foi usado na busca.
  function psPlusMismatch(it, target) {
    if (!target.psPlus) return null;
    if (Array.isArray(it.playStyles)) return it.playStyles.some((p) => p.plus) ? null : 'sem PlayStyle+';
    return target.psPlusServer ? null : 'não deu para confirmar PlayStyle+';
  }

  // Tipo do alvo: define o que a busca procura e o que o bot aceita comprar.
  const KINDS = [['player', 'Jogador'], ['manager', 'Técnico'], ['chemstyle', 'Consumível: estilo de química'], ['mgrleague', 'Consumível: liga de técnico']];

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
    // Consumables → Manager Leagues (liga do técnico).
    if (/manager/.test(category) && (type === 'training' || /league|modifier/.test(category))) return 'mgrleague';
    if (type === 'staff' || category === 'manager') return 'manager';
    if (/playstyle|chem/.test(category)) return 'chemstyle';
    if (type === 'training' && c.playStyle > 0) return 'chemstyle';
    return null;
  }

  const PLAYER_FILTER_KEYS = ['position', 'zone', 'playStyle', 'level', 'club', 'league', 'nation'];
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
    if (kind === 'mgrleague') {
      // Usa a busca do próprio Web App (ela sabe como a EA guarda a liga).
      const out = kindFromCriteria(base) === 'mgrleague'
        ? Object.assign({}, base)
        : { type: 'training', category: 'managerLeagueModifier' };
      ['position', 'zone', 'club', 'nation', 'playStyle', 'rarities', 'defId', 'maskedDefId'].forEach((k) => { delete out[k]; });
      const lg = parseInt(values.league, 10);
      if (lg > 0) out.league = lg;
      return out;
    }
    if (kind === 'manager') {
      // Técnicos (aba Managers do Web App): nome, nível, país e liga.
      const out = kindFromCriteria(base) === 'manager' ? Object.assign({}, base) : {};
      ['position', 'zone', 'club', 'playStyle', 'rarities', 'defId'].forEach((k) => { delete out[k]; });
      for (const key of ['level', 'league', 'nation']) {
        const v = values[key];
        if (isEmptyValue(v)) delete out[key];
        else out[key] = NUMERIC_KEYS.includes(key) ? parseInt(v, 10) : v;
      }
      out.type = 'staff';
      out.category = 'manager';
      return out;
    }
    if (kind === 'player') {
      const out = kindFromCriteria(base) === 'player' ? Object.assign({}, base) : {};
      delete out.category;
      // Se a posição escolhida é a mesma da busca do Web App, mantém o campo
      // original (do jeito que a EA espera); se mudou, troca pelo padrão.
      const basePos = readPositionFilter(out);
      const wantPos = isEmptyValue(values.position) ? '' : String(values.position).toUpperCase();
      const wantZone = isEmptyValue(values.zone) ? '' : (zoneInfo(values.zone) || [values.zone])[0];
      const baseZone = basePos.zone ? basePos.zone : (zoneInfo(out.zone) || [''])[0];
      if (basePos.key && wantPos === basePos.position && wantZone === baseZone) {
        values = Object.assign({}, values, { position: out.position, zone: out.zone });
      } else {
        POSITION_KEYS.filter((k) => k !== 'position' && k !== 'zone').forEach((k) => { delete out[k]; });
      }
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
      (target && (target.minRating > 0 || target.maxRating > 0 || target.psPlus || (target.playStyles || []).length > 0)));
  }

  // Quantidade por alvo: maxCount = quantas cartas comprar (0 = sem limite),
  // bought = quantas já foram compradas de verdade.
  function targetRemaining(t) {
    if (!(t.maxCount > 0)) return Infinity;
    return Math.max(0, t.maxCount - (t.bought || 0));
  }

  function targetDone(t) {
    return targetRemaining(t) === 0;
  }

  // Motivo para não aceitar o alvo, ou null se está tudo certo.
  function targetProblem(t) {
    if (!t || !KINDS.some((k) => k[0] === t.kind)) return 'escolha o tipo do alvo (jogador, técnico ou consumível)';
    const c = t.criteria || {};
    if (t.kind === 'chemstyle') {
      if (!(c.playStyle > 0)) return 'escolha qual estilo de química (consumível) comprar';
      if (kindFromCriteria(c) !== 'chemstyle') return 'a busca não é de consumível';
    }
    if (t.kind === 'player') {
      if (kindFromCriteria(c) !== 'player') return 'a busca não é de jogador';
      if (!hasPlayerFilter(c, t)) return 'escolha um jogador ou pelo menos um filtro';
    }
    if (t.kind === 'mgrleague') {
      if (kindFromCriteria(c) !== 'mgrleague') return 'a busca não é de liga de técnico (use Consumables → Manager Leagues no Web App)';
      if (!(c.league > 0)) return 'escolha a liga (no Web App: Consumables → Manager Leagues → liga, e abra o ⚡)';
    }
    if (t.kind === 'manager') {
      if (kindFromCriteria(c) !== 'manager') return 'a busca não é de técnico';
      if (!(c.maskedDefId > 0) && ['level', 'league', 'nation'].every((k) => isEmptyValue(c[k]))) {
        return 'escolha um técnico ou pelo menos um filtro (nível, país ou liga)';
      }
    }
    if (!(t.maxBuy >= 200)) return 'preço máximo de compra precisa ser pelo menos 200';
    if (t.minPrice > 0 && t.minPrice >= t.maxBuy) return '"Buscar a partir de" precisa ser menor que o "Compra até"';
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
    if (target.kind === 'mgrleague') {
      if (it.kind !== 'training') return 'não é consumível';
      if (it.playStyle != null && it.playStyle > 0) return 'é estilo de química, não liga de técnico';
      if (c.league > 0) {
        if (it.leagueId == null) return 'não deu para confirmar a liga do consumível';
        if (it.leagueId !== c.league) return 'liga diferente';
      }
      return null;
    }
    if (target.kind === 'chemstyle') {
      if (it.kind !== 'training') return 'não é consumível';
      if (it.playStyle != null && it.playStyle > 0) return it.playStyle === c.playStyle ? null : 'estilo de química diferente';
      return isChemStyleName(it.name, c.playStyle) ? null : 'não deu para confirmar o estilo do consumível';
    }
    if (target.kind === 'manager') {
      if (it.kind !== 'manager') return 'não é técnico';
      if (c.maskedDefId > 0 && it.definitionId > 0 && baseDefId(it.definitionId) !== baseDefId(c.maskedDefId)) return 'outro técnico';
      const needM = (want, got, article, noun) => {
        if (isEmptyValue(want)) return null;
        if (got == null) return 'não deu para confirmar ' + article + ' ' + noun;
        return got === want ? null : noun + ' diferente';
      };
      return needM(c.league, it.leagueId, 'a', 'liga') || needM(c.nation, it.nationId, 'o', 'país');
    }
    if (target.kind === 'player') {
      if (it.kind !== 'player') return 'não é jogador';
      if (target.definitionId > 0 && it.definitionId !== target.definitionId) return 'outra versão da carta';
      if (target.noSpecial && it.special === true) return 'carta especial';
      const need = (want, got, article, noun) => {
        if (isEmptyValue(want)) return null;
        if (got == null) return 'não deu para confirmar ' + article + ' ' + noun;
        return got === want ? null : noun + ' diferente';
      };
      const pf = readPositionFilter(c);
      if (pf.position) {
        const pos = positionsOf(it);
        if (!pos.length) return 'não deu para confirmar a posição';
        if (!pos.includes(pf.position)) return 'posição diferente';
      }
      // Grupo de posição: confere quando sabemos quais posições entram nele;
      // se o valor for outro formato da EA, vale o filtro da própria busca.
      const zone = pf.zone ? zoneInfo(pf.zone) : (isEmptyValue(c.zone) ? null : zoneInfo(c.zone));
      if (zone) {
        const pos = positionsOf(it);
        if (!pos.length) return 'não deu para confirmar a posição';
        if (!pos.some((p) => zone[2].includes(p))) return 'não é ' + zone[3];
      }
      return need(c.playStyle, it.playStyle, 'a', 'química') ||
        need(c.club, it.teamId, 'o', 'time') ||
        need(c.league, it.leagueId, 'a', 'liga') ||
        need(c.nation, it.nationId, 'o', 'país') ||
        (target.minRating > 0 && !(it.rating >= target.minRating) ? 'nota abaixo do mínimo' : null) ||
        (target.maxRating > 0 && !(it.rating <= target.maxRating) ? 'nota acima do máximo' : null) ||
        psPlusMismatch(it, target) ||
        playStyleMismatch(it.playStyles, target.playStyles);
    }
    return 'alvo sem tipo definido';
  }

  // Nomes de time/liga/país/jogador: primeiro os guardados no alvo, depois o
  // serviço de nomes do Web App; só em último caso o número.
  function nameFor(kind, id, labels, names) {
    if (!(id > 0)) return '';
    if (labels && labels[kind]) return labels[kind];
    const fn = names && names[kind];
    const n = typeof fn === 'function' ? fn(id) : null;
    if (n) return n;
    return { club: 'time', league: 'liga', nation: 'país', player: 'jogador' }[kind] + ' #' + id;
  }

  // Partes legíveis do alvo, na ordem em que aparecem no cartão.
  function targetParts(t, names) {
    const c = t.criteria || {};
    const labels = t.labels || {};
    if (t.kind === 'chemstyle') return [c.playStyle > 0 ? 'Estilo ' + chemStyleName(c.playStyle) : 'Estilo ?'];
    if (t.kind === 'mgrleague') return ['Liga de técnico: ' + (c.league > 0 ? nameFor('league', c.league, labels, names) : '?')];
    const parts = [];
    if (c.maskedDefId) parts.push(t.kind === 'manager' ? (labels.player || 'técnico #' + c.maskedDefId) : nameFor('player', c.maskedDefId, labels, names));
    const pf = readPositionFilter(c);
    if (pf.position) parts.push(pf.position);
    else if (pf.zone) parts.push(zoneLabel(pf.zone));
    else if (!isEmptyValue(c.zone)) parts.push(zoneLabel(c.zone));
    if (c.playStyle > 0) parts.push('Química ' + chemStyleName(c.playStyle));
    if (c.club > 0) parts.push(nameFor('club', c.club, labels, names));
    if (c.league > 0) parts.push(nameFor('league', c.league, labels, names));
    if (c.nation > 0) parts.push(nameFor('nation', c.nation, labels, names));
    if (c.level && c.level !== 'any') parts.push((LEVELS.find((l) => l[0] === c.level) || [])[1] || c.level);
    if (t.psPlus) parts.push('Com PlayStyle+');
    (t.playStyles || []).forEach((p) => parts.push(playStyleName(p.id, p.plus)));
    if (t.minRating > 0 && !(t.maxRating > 0)) parts.push('Nota ' + t.minRating + '+');
    else if (t.maxRating > 0 && !(t.minRating > 0)) parts.push('Nota até ' + t.maxRating);
    else if (t.minRating > 0) parts.push('Nota ' + (t.minRating === t.maxRating ? t.minRating : t.minRating + '–' + t.maxRating));
    if (t.minPrice > 0) parts.push('Busca a partir de ' + fmt(t.minPrice));
    return parts;
  }

  function countLabel(t) {
    if (!(t.maxCount > 0)) return (t.bought || 0) + ' comprado(s) · sem limite';
    return (t.bought || 0) + ' de ' + t.maxCount + ' comprado(s)';
  }

  function describeTarget(t, names) {
    if (t.kind === 'chemstyle' || t.kind === 'mgrleague') return 'CONSUMÍVEL · ' + targetParts(t, names).join(' · ');
    const parts = targetParts(t, names);
    const head = t.kind === 'player' ? 'JOGADOR · ' : t.kind === 'manager' ? 'TÉCNICO · ' : 'TIPO NÃO DEFINIDO · ';
    return head + (parts.join(' · ') || 'sem filtros');
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
    (it.playStyles || []).filter((p) => p.plus).forEach((p) => extra.push(playStyleName(p.id, true)));
    const pos = positionsOf(it)[0];
    if (pos) extra.push(pos);
    return it.name + (it.rating ? ' ' + it.rating : '') + (extra.length ? ' (' + extra.join(', ') + ')' : '');
  }

  // ---------------------------------------------------------------------------
  // Nomes de times, ligas, países e jogadores
  // ---------------------------------------------------------------------------

  // O Web App traz as traduções dos nomes; as chaves seguem o padrão
  // global.teamFull.<ano>.team<id>, global.leagueFull.<ano>.league<id> e
  // search.nationName.nation<id>. O ano é descoberto testando times conhecidos.
  const NAME_KEYS = {
    club: (y, id) => 'global.teamFull.' + y + '.team' + id,
    league: (y, id) => 'global.leagueFull.' + y + '.league' + id,
    nation: (y, id) => 'search.nationName.nation' + id,
  };
  const NAME_SCAN = { nation: 300, league: 2500, club: 135000 };
  const PROBE = { club: [243, 241, 11, 1, 5], league: [13, 53, 16, 19, 31], nation: [54, 14, 18, 21, 52] };

  function validName(name, key) {
    return typeof name === 'string' && name.trim() !== '' && name !== key && !/^(global|search)\./.test(name) && !/\.(team|league|nation)\d+$/.test(name);
  }

  function createNameService(getLocalize, opts) {
    opts = opts || {};
    const yearsToTry = opts.years || [2027, 2026, 2028, 2025, 2024];
    let year = null;
    const cache = { club: new Map(), league: new Map(), nation: new Map() };
    const lists = {};
    const loading = {};

    function localize() {
      const fn = getLocalize();
      return typeof fn === 'function' ? fn : null;
    }

    function lookup(kind, id, y) {
      const loc = localize();
      if (!loc) return null;
      const key = NAME_KEYS[kind](y, id);
      let name;
      try { name = loc(key); } catch (e) { name = null; }
      return validName(name, key) ? name : null;
    }

    function detectYear() {
      if (year) return year;
      for (const y of yearsToTry) {
        if (PROBE.club.some((id) => lookup('club', id, y))) { year = y; return y; }
      }
      return null;
    }

    function name(kind, id) {
      if (!(id > 0)) return null;
      if (cache[kind].has(id)) return cache[kind].get(id);
      const y = kind === 'nation' ? 0 : detectYear();
      if (kind !== 'nation' && !y) return null;
      const n = lookup(kind, id, y);
      if (n) cache[kind].set(id, n);
      return n;
    }

    // Lista completa (id, nome), montada aos poucos para não travar a tela.
    function list(kind) {
      if (lists[kind]) return Promise.resolve(lists[kind]);
      if (loading[kind]) return loading[kind];
      loading[kind] = new Promise((resolve) => {
        if (!localize() || (kind !== 'nation' && !detectYear())) {
          loading[kind] = null;
          return resolve([]);
        }
        const out = [];
        const max = (opts.scan && opts.scan[kind]) || NAME_SCAN[kind];
        const step = opts.chunk || 4000;
        let id = 1;
        const tick = () => {
          const end = Math.min(max, id + step);
          for (; id <= end; id++) {
            const n = name(kind, id);
            if (n) out.push({ id, name: n });
          }
          if (id <= max) return setTimeout(tick, 0);
          out.sort((a, b) => a.name.localeCompare(b.name));
          lists[kind] = out;
          resolve(out);
        };
        tick();
      });
      return loading[kind];
    }

    return {
      available: () => !!localize() && (!!detectYear() || PROBE.nation.some((id) => lookup('nation', id, 0))),
      club: (id) => name('club', id),
      league: (id) => name('league', id),
      nation: (id) => name('nation', id),
      list,
      year: () => year,
    };
  }

  function searchByName(list, query, limit) {
    const q = normalizeName(query);
    if (!q) return [];
    const starts = [];
    const contains = [];
    for (const item of list) {
      const n = normalizeName(item.name);
      if (n.startsWith(q)) starts.push(item);
      else if (n.includes(q)) contains.push(item);
      if (starts.length >= (limit || 12)) break;
    }
    return starts.concat(contains).slice(0, limit || 12);
  }

  // Lista de jogadores que o próprio Web App baixa para a busca por nome
  // (players.json: { Players: [{ id, f, l, c, r }], LegendsPlayers: [...] }).
  function parsePlayersDb(json) {
    const out = [];
    const seen = new Set();
    for (const group of [json && json.Players, json && json.LegendsPlayers]) {
      for (const p of group || []) {
        if (!p || !(p.id > 0) || seen.has(p.id)) continue;
        seen.add(p.id);
        const full = [p.f, p.l].filter(Boolean).join(' ');
        out.push({ id: p.id, name: p.c || full || String(p.id), full, rating: p.r || 0 });
      }
    }
    return out;
  }

  function searchPlayers(db, query, limit) {
    const q = normalizeName(query);
    if (q.length < 2) return [];
    const hits = db.filter((p) => normalizeName(p.name).includes(q) || normalizeName(p.full).includes(q));
    hits.sort((a, b) => {
      const as = normalizeName(a.name).startsWith(q) ? 0 : 1;
      const bs = normalizeName(b.name).startsWith(q) ? 0 : 1;
      return as - bs || b.rating - a.rating;
    });
    return hits.slice(0, limit || 12);
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

  function createPriceOverlay(win, prices, getSettings, onError, registry, market) {
    // Cartas desenhadas na tela (para o botão de preço atual).
    const shown = new Map();

    // Título da tela atual do Web App (ex.: "Transfer List"), para saber em
    // qual lista cada carta apareceu.
    function screenTitle() {
      try {
        const h = win.document.querySelector('.ut-navigation-bar-view h1, .ut-navigation-bar-view .title, header h1, h1');
        return h ? h.textContent.trim() : '';
      } catch (e) {
        return '';
      }
    }

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
      const item = itemFromView(view, args);
      if (registry && item && item.id > 0) {
        registry.set(item.id, item);
        if (registry.screens) registry.screens.set(item.id, screenTitle());
      }
      const settings = getSettings();
      if (!settings.showCardPrices) return;
      counters.calls++;
      const root = rootFromView(view);
      if (!root || !root.querySelector || !isPlayerItem(item)) return;
      const card = { name: itemNameOf(item), definitionId: item.definitionId, rating: item.rating };
      shown.set(root, { view, args, kind, card });
      const now = market && market.get(card.definitionId);
      if (settings.priceSource !== 'futbin' && !now) {
        const old = badges.get(root);
        if (old) { old.remove(); badges.delete(root); }
        return;
      }
      const badge = badgeFor(root, kind, card.name);
      const tag = card.definitionId + ':' + settings.platform;
      badge.dataset.tag = tag;
      if (!eaSample) eaSample = priceFieldsOf(item) || '(nenhum campo de preço no item)';
      const bin = item._auction && item._auction.buyNowPrice;
      const setPrice = (label, price, title) => {
        badge.textContent = label + ' ' + (price < 100000 ? fmt(price) : formatShort(price));
        badge.classList.toggle('fcab-good', bin > 0 && bin < price);
        badge.title = title;
      };
      // Preço atual do mercado (botão 💲): vale mais que qualquer outro.
      if (now) {
        badge.classList.remove('fcab-good');
        if (now.state === 'checking') { badge.textContent = 'Agora …'; badge.title = 'Consultando o mercado'; return; }
        if (!(now.price > 0)) { badge.textContent = 'Agora: sem anúncio'; badge.title = 'Nenhum anúncio de compre já encontrado'; return; }
        counters.priced++;
        const mins = Math.max(0, Math.round((Date.now() - now.at) / 60000));
        return setPrice('Agora', now.price, 'Menor compre já no mercado da EA (há ' + mins + ' min): ' + fmt(now.price));
      }
      const showEa = (why) => {
        badge.classList.remove('fcab-good');
        badge.textContent = 'FUTBIN ? ' + errorCode(why);
        badge.title = why || '';
      };
      if (prices.blocked()) return showEa('bloqueado');
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
      // Cartas na tela agora (sem repetir a mesma carta).
      visibleCards() {
        const out = new Map();
        shown.forEach((v, root) => {
          if (!root.isConnected) { shown.delete(root); return; }
          if (!out.has(v.card.definitionId)) out.set(v.card.definitionId, v.card);
        });
        return Array.from(out.values());
      },
      // Redesenha as etiquetas de uma carta (depois de consultar o preço).
      refresh(definitionId) {
        shown.forEach((v, root) => {
          if (v.card.definitionId === definitionId && root.isConnected) {
            try { show(v.view, v.args, v.kind); } catch (e) { /* ignora */ }
          }
        });
      },
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

  // Busca de jogadores por nome usando a lista que o Web App já baixou.
  function createPlayersDb(adapter, win) {
    let db = null;
    let loading = null;
    function load() {
      if (db) return Promise.resolve(db);
      if (loading) return loading;
      const url = adapter.playersDbUrl();
      if (!url || typeof win.fetch !== 'function') return Promise.resolve(null);
      loading = win.fetch(url, { credentials: 'same-origin' })
        .then((r) => r.json())
        .then((json) => { db = parsePlayersDb(json); return db; })
        .catch(() => null)
        .then((result) => { loading = null; return result; });
      return loading;
    }
    return {
      search(query) {
        return load().then((d) => (d && d.length ? { ok: true, list: searchPlayers(d, query, 15) } : { ok: false, list: [] }));
      },
      name(id) {
        const p = db && db.find((x) => x.id === id);
        return p ? p.name : null;
      },
    };
  }

  function cardFromItems(items) {
    const it = (items || []).find((x) => x.kind == null || x.kind === 'player');
    if (!it || !it.definitionId) return null;
    return { name: it.name, definitionId: it.definitionId, rating: it.rating };
  }

  // ---------------------------------------------------------------------------
  // Registro de compras e lucro
  // ---------------------------------------------------------------------------

  // Cada carta comprada vira uma entrada, indexada pelo ID do item na conta.
  // Custo vem do bot (preço pago) ou do "Item bought for" do Web App
  // (lastSalePrice). Venda vem da lista de transferências (anúncio fechado).
  function ledgerKey(itemId) {
    return 'i' + itemId;
  }

  function recordBuy(ledger, e) {
    if (!e || !(e.itemId > 0)) return null;
    const key = ledgerKey(e.itemId);
    const cur = ledger[key] || {};
    ledger[key] = Object.assign({}, cur, {
      itemId: e.itemId,
      name: e.name || cur.name || 'carta',
      rating: e.rating || cur.rating || 0,
      definitionId: e.definitionId || cur.definitionId || 0,
      cost: e.price > 0 ? e.price : cur.cost || 0,
      source: e.source || cur.source || 'bot',
      boughtAt: e.at || cur.boughtAt || Date.now(),
      status: cur.status || 'comprada',
      targetId: e.targetId || cur.targetId || undefined,
      // Compra (do bot ou lance ganho) sempre conta no lucro.
      origin: e.source || cur.source || 'bot',
      ignored: false,
      autoIgnored: false,
    });
    return ledger[key];
  }

  const SALE_STATES = { closed: 'vendida', active: 'à venda', expired: 'expirada' };

  // Atualiza o registro com os itens da lista de transferências (ou de outra
  // pilha). Itens desconhecidos entram com o custo do "Item bought for".
  // pile: de onde vieram as cartas ('transfer' ou 'unassigned'). Carta que o
  // bot não comprou e apareceu primeiro na lista de transferências veio do
  // seu clube/elenco: fica registrada, mas não conta no lucro.
  // bids: lances dados pelo bot ({ 'i'+itemId: { amount } }); carta ganha
  // num desses lances é compra, mesmo indo direto para a lista.
  function syncLedger(ledger, items, now, pile, bids) {
    now = now || Date.now();
    const changes = { added: 0, sold: [] };
    for (const it of items || []) {
      if (!(it.id > 0)) continue;
      const key = ledgerKey(it.id);
      let e = ledger[key];
      const bid = bids && bids[key];
      if (!e && bid) {
        e = ledger[key] = {
          itemId: it.id,
          name: it.name,
          rating: it.rating || 0,
          definitionId: it.definitionId || 0,
          cost: it.lastSalePrice > 0 ? it.lastSalePrice : bid.amount || 0,
          source: 'lance',
          boughtAt: bid.at || now,
          status: 'comprada',
          origin: 'lance',
          targetId: bid.targetId || undefined,
        };
        changes.added++;
      } else if (bid && e && e.autoIgnored) {
        e.ignored = false;
        e.autoIgnored = false;
        e.source = 'lance';
        e.origin = 'lance';
        if (!(e.cost > 0)) e.cost = bid.amount || 0;
      }
      if (!e) {
        e = ledger[key] = {
          itemId: it.id,
          name: it.name,
          rating: it.rating || 0,
          definitionId: it.definitionId || 0,
          cost: it.lastSalePrice > 0 ? it.lastSalePrice : 0,
          source: 'web app',
          boughtAt: now,
          status: 'comprada',
          origin: pile === 'unassigned' ? 'não atribuídos' : 'clube',
          ignored: pile !== 'unassigned',
          autoIgnored: pile !== 'unassigned',
        };
        changes.added++;
      } else if (!(e.cost > 0) && it.lastSalePrice > 0) {
        e.cost = it.lastSalePrice;
      }
      // Apareceu em Não atribuídos: foi comprada, então conta.
      if (pile === 'unassigned' && e.autoIgnored) {
        e.ignored = false;
        e.autoIgnored = false;
        e.origin = 'não atribuídos';
      }
      // Troca o nome provisório ("Carta 85 #50") pelo nome real quando aparecer.
      if (it.name && /^Carta /.test(e.name || '') && !/^Carta /.test(it.name)) e.name = it.name;
      const state = SALE_STATES[it.tradeState] || (it.tradeState ? it.tradeState : 'na lista');
      if (e.status === 'vendida') continue;
      e.status = state;
      if (it.tradeState === 'active' || it.tradeState === 'expired') e.listedFor = it.buyNow || e.listedFor || 0;
      if (it.tradeState === 'closed') {
        e.soldFor = it.currentBid > 0 ? it.currentBid : it.buyNow;
        e.soldAt = now;
        changes.sold.push(e);
      }
    }
    return changes;
  }

  // Registros antigos: cartas que o bot não comprou entravam no lucro (ex.:
  // jogador do elenco mandado para venda). Agora ficam fora, até você marcar.
  function migrateLedger(ledger) {
    for (const e of Object.values(ledger || {})) {
      if (!e) continue;
      // Lances ganhos (botão "Conferir lances") também são compras: contam.
      if (e.source === 'bot' || e.source === 'lance') {
        if (e.autoIgnored) { e.ignored = false; e.autoIgnored = false; }
        e.origin = e.origin && e.origin !== 'clube' ? e.origin : e.source;
        continue;
      }
      if (e.origin) continue;
      e.origin = 'clube';
      e.ignored = true;
      e.autoIgnored = true;
    }
    return ledger;
  }

  // Lista de observação: cartas ganhas em leilão entram como compra.
  function recordWonBids(ledger, items) {
    let n = 0;
    for (const it of items || []) {
      if (!(it.id > 0) || watchStatus(it) !== 'ganhou') continue;
      const cur = ledger[ledgerKey(it.id)];
      if (cur && (cur.source === 'lance' || cur.source === 'bot') && !cur.ignored) continue;
      recordBuy(ledger, { itemId: it.id, name: it.name, rating: it.rating, definitionId: it.definitionId,
        price: it.currentBid, source: 'lance', at: cur && cur.boughtAt });
      n++;
    }
    return n;
  }

  // Resultado das compras de um alvo: as registradas com o alvo e, das mais
  // antigas (sem alvo anotado), as da mesma carta do alvo.
  function targetLedgerStats(t, ledger) {
    const c = (t && t.criteria) || {};
    const out = { sold: 0, profit: 0, open: 0, openCost: 0, unknown: 0 };
    const sameCard = (e) => t.kind === 'player' && c.maskedDefId > 0 && e.definitionId > 0 &&
      baseDefId(e.definitionId) === baseDefId(c.maskedDefId) &&
      (!(t.definitionId > 0) || e.definitionId === t.definitionId) &&
      (!(t.minRating > 0) || !(e.rating > 0) || e.rating >= t.minRating) &&
      (!(t.maxRating > 0) || !(e.rating > 0) || e.rating <= t.maxRating);
    for (const e of Object.values(ledger || {})) {
      if (e.status === 'removida' || e.ignored) continue;
      if (e.targetId ? e.targetId !== t.id : !sameCard(e)) continue;
      if (e.status === 'vendida') {
        const p = entryProfit(e);
        if (p == null) { out.unknown++; continue; }
        out.sold++;
        out.profit += p;
      } else {
        out.open++;
        out.openCost += e.cost > 0 ? e.cost : 0;
      }
    }
    return out;
  }

  function entryProfit(e) {
    if (!(e.soldFor > 0) || !(e.cost > 0)) return null;
    return netAfterTax(e.soldFor) - e.cost;
  }

  // Período { from, to } em milissegundos (inclusive). Sem período = tudo.
  function inPeriod(ts, period) {
    if (!period) return true;
    if (!(ts > 0)) return false;
    return (!(period.from > 0) || ts >= period.from) && (!(period.to > 0) || ts <= period.to);
  }

  // Dia local (AAAA-MM-DD) de um instante.
  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Início e fim (locais) de um dia "AAAA-MM-DD".
  function dayRange(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!m) return null;
    const start = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    return { from: start, to: new Date(+m[1], +m[2] - 1, +m[3] + 1).getTime() - 1 };
  }

  // Períodos prontos: hoje, 7 dias, 30 dias, este mês, mês passado, tudo.
  function presetPeriod(name, now) {
    const d = new Date(now || Date.now());
    const today = dayRange(dayKey(d.getTime()));
    const back = (n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
    if (name === 'today') return today;
    if (name === '7d') return { from: back(6), to: today.to };
    if (name === '30d') return { from: back(29), to: today.to };
    if (name === 'month') return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: today.to };
    if (name === 'lastMonth') {
      return { from: new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(), to: new Date(d.getFullYear(), d.getMonth(), 1).getTime() - 1 };
    }
    return null;
  }

  // Lucro e vendas por dia dentro do período (mais recente primeiro).
  function dailyProfit(ledger, period) {
    const days = new Map();
    for (const e of Object.values(ledger || {})) {
      if (e.ignored || e.status !== 'vendida' || !inPeriod(e.soldAt, period)) continue;
      const p = entryProfit(e);
      if (p == null) continue;
      const k = dayKey(e.soldAt);
      const d = days.get(k) || { day: k, count: 0, profit: 0 };
      d.count++;
      d.profit += p;
      days.set(k, d);
    }
    return Array.from(days.values()).sort((a, b) => (a.day < b.day ? 1 : -1));
  }

  // Resumo: vendas e compras entram pelo período; o estoque é sempre o atual.
  function ledgerSummary(ledger, period) {
    const out = { soldCount: 0, revenue: 0, soldCost: 0, profit: 0, openCount: 0, openCost: 0, unknownCost: 0, boughtCount: 0, boughtCost: 0 };
    for (const e of Object.values(ledger || {})) {
      if (e.ignored) continue;
      if (period && inPeriod(e.boughtAt, period)) {
        out.boughtCount++;
        out.boughtCost += e.cost > 0 ? e.cost : 0;
      }
      if (e.status === 'vendida') {
        if (!inPeriod(e.soldAt, period)) continue;
        const p = entryProfit(e);
        if (p == null) { out.unknownCost++; continue; }
        out.soldCount++;
        out.revenue += netAfterTax(e.soldFor);
        out.soldCost += e.cost;
        out.profit += p;
      } else if (e.status !== 'removida') {
        out.openCount++;
        out.openCost += e.cost > 0 ? e.cost : 0;
        if (!(e.cost > 0)) out.unknownCost++;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Lances em massa
  // ---------------------------------------------------------------------------

  // Próximo lance aceito pela EA: o lance inicial, se ninguém deu lance, ou
  // um degrau acima do lance atual.
  function nextBidAmount(it) {
    if (it.currentBid > 0) return nextPrice(it.currentBid);
    return Math.max(MIN_PRICE, roundDown(it.startingBid || MIN_PRICE));
  }

  // Valor do lance: o menor aceito pela EA, mas nunca abaixo do "lance
  // mínimo" escolhido (mínimo = máximo → sempre aquele valor exato).
  function bidAmountFor(it, plan) {
    const need = nextBidAmount(it);
    const min = plan && plan.minBid > 0 ? roundDown(plan.minBid) : 0;
    return Math.max(need, min);
  }

  // Motivo para NÃO dar lance nesta carta, ou null.
  function bidProblem(it, plan, ctx) {
    ctx = ctx || {};
    if (it.tradeOwner) return 'anúncio seu';
    if (it.bidState === 'highest') return 'você já é o maior lance';
    if (!(it.expires > 0)) return 'leilão encerrado';
    if (plan.maxExpires > 0 && it.expires > plan.maxExpires) return 'termina tarde demais';
    const amount = bidAmountFor(it, plan);
    if (amount > plan.maxBid) return 'lance necessário ' + fmt(amount) + ' passa do máximo';
    if (it.buyNow > 0 && amount >= it.buyNow) return 'lance chegaria no preço de compra imediata';
    if (ctx.coins != null && amount > ctx.coins) return 'moedas insuficientes';
    const reason = plan.target ? mismatchReason(it, plan.target) : null;
    if (reason) return reason;
    return null;
  }

  // Escolhe em quais cartas dar lance: as que terminam primeiro, até o limite
  // de lances e de moedas (cada lance prende as moedas até ser superado).
  function planBids(items, plan, ctx) {
    ctx = ctx || {};
    let coins = ctx.coins == null ? Infinity : ctx.coins;
    let left = plan.maxBids > 0 ? plan.maxBids : Infinity;
    const out = [];
    const sorted = items.slice().sort((a, b) => (a.expires || 0) - (b.expires || 0));
    for (const it of sorted) {
      if (left <= 0) break;
      if (ctx.seen && ctx.seen.has(it.tradeId)) continue;
      const why = bidProblem(it, plan, { coins });
      if (why) { if (ctx.onSkip) ctx.onSkip(it, why); continue; }
      const amount = bidAmountFor(it, plan);
      out.push({ item: it, amount });
      coins -= amount;
      left--;
    }
    return out;
  }

  // Situação de um lance na lista de observação.
  function watchStatus(it) {
    if (it.tradeState === 'closed') return it.bidState === 'highest' ? 'ganhou' : 'perdeu';
    if (it.tradeState === 'expired') return 'perdeu';
    return it.bidState === 'highest' ? 'ganhando' : it.bidState === 'outbid' ? 'superado' : 'acompanhando';
  }

  // ---------------------------------------------------------------------------
  // Venda em massa
  // ---------------------------------------------------------------------------

  // Agrupa cartas iguais que podem ser anunciadas (não anunciadas ou expiradas).
  function groupSellable(items, ledger) {
    const groups = new Map();
    for (const it of items || []) {
      if (it.untradeable) continue;
      if (it.tradeState === 'active' || it.tradeState === 'closed') continue;
      const key = (it.definitionId || it.name) + ':' + (it.rating || 0);
      if (!groups.has(key)) {
        groups.set(key, { key, name: it.name, rating: it.rating || 0, definitionId: it.definitionId,
          kind: it.kind, items: [], costs: [], marketAverage: null, minPrice: 0, maxPrice: 0 });
      }
      const g = groups.get(key);
      g.items.push(it);
      const e = ledger && ledger[ledgerKey(it.id)];
      const cost = e && e.cost > 0 ? e.cost : it.lastSalePrice > 0 ? it.lastSalePrice : 0;
      if (cost) g.costs.push(cost);
      if (it.marketAverage > 0) g.marketAverage = it.marketAverage;
      if (it.minPrice > 0) g.minPrice = it.minPrice;
      if (it.maxPrice > 0) g.maxPrice = it.maxPrice;
    }
    return Array.from(groups.values()).map((g) => Object.assign(g, {
      count: g.items.length,
      avgCost: g.costs.length ? Math.round(g.costs.reduce((a, b) => a + b, 0) / g.costs.length) : 0,
    })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  // Conta por que cada carta lida entra ou não na venda (mostrado na tela).
  function sellableStats(items) {
    const st = { total: 0, ready: 0, listed: 0, sold: 0, untradeable: 0 };
    for (const it of items || []) {
      st.total++;
      if (it.untradeable) st.untradeable++;
      else if (it.tradeState === 'active') st.listed++;
      else if (it.tradeState === 'closed') st.sold++;
      else st.ready++;
    }
    return st;
  }

  // Confere e ajusta o preço de venda: degraus da EA, faixa permitida pela EA
  // e lance inicial abaixo do "compre já".
  function sellPrices(group, bin, start) {
    let b = roundDown(bin);
    const notes = [];
    if (group.maxPrice > 0 && b > group.maxPrice) { b = roundDown(group.maxPrice); notes.push('limitado ao máximo da EA'); }
    if (group.minPrice > 0 && b < group.minPrice) return { error: 'abaixo do mínimo permitido pela EA (' + fmt(group.minPrice) + ')' };
    if (b < 200) return { error: 'preço mínimo de compra imediata é 200' };
    let st = start > 0 ? roundDown(start) : prevPrice(b);
    if (st >= b) st = prevPrice(b);
    const perCard = netAfterTax(b) - (group.avgCost || 0);
    return { bin: b, start: st, notes, profitPerCard: group.avgCost ? perCard : null };
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
      this.onTargetsChanged = opts.onTargetsChanged || function () {};
      this.simCount = new Map();
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
      this.simCount = new Map();
      this.completedNow = 0;
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
        if (!t.enabled || targetDone(t)) return false;
        if (s.dryRun && (this.simCount.get(t.id) || 0) >= targetRemaining(t)) return false;
        const problem = targetProblem(t);
        if (problem && !this.warned.has(t.id)) {
          this.warned.add(t.id);
          this.log('Alvo "' + t.name + '" ignorado: ' + problem + '.', 'error');
        }
        return !problem;
      });
      if (!active.length) {
        const reached = this.completedNow > 0 || state.targets.some((t) => t.enabled && t.maxCount > 0 &&
          (targetDone(t) || (s.dryRun && (this.simCount.get(t.id) || 0) >= targetRemaining(t))));
        return this.stop(reached ? 'quantidade de compras dos alvos atingida' : 'nenhum alvo válido e ativo');
      }
      const target = active[this.targetIndex++ % active.length];
      target.lastTriedAt = Date.now();

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
        const n = (this.simCount.get(target.id) || 0) + 1;
        this.simCount.set(target.id, n);
        const of = target.maxCount > 0 ? ' [' + ((target.bought || 0) + n) + ' de ' + target.maxCount + ']' : '';
        this.log('SIMULAÇÃO: compraria ' + describeItem(item) + ' por ' + fmt(item.buyNow) +
          ' (' + target.name + ')' + of + '. Nada foi comprado.', 'success');
        if (target.maxCount > 0 && n >= targetRemaining(target)) {
          this.log('SIMULAÇÃO: alvo "' + target.name + '" chegaria à quantidade pedida; parei de procurar por ele.', 'warn');
        }
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
        itemId: item.id,
        rating: item.rating,
        definitionId: item.definitionId,
        name: item.name,
        price: item.buyNow,
        target: target.name,
        targetId: target.id,
        sellPrice: target.sellPrice > 0 ? roundDown(target.sellPrice) : 0,
        listed: false,
      };
      this.log('Comprei ' + item.name + ' por ' + fmt(item.buyNow) + '!', 'success');
      target.bought = (target.bought || 0) + 1;
      if (targetDone(target)) {
        target.enabled = false;
        this.completedNow++;
        this.log('Alvo "' + target.name + '" concluído: ' + countLabel(target) + '. Desliguei o alvo.', 'success');
      }
      this.onTargetsChanged();

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
        this.log(FATAL_MESSAGES[kind] + ' (código ' + status + ' na ' + what + ')', 'error');
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
  // Leitura das pilhas (lista de transferências, não atribuídos, observação)
  // ---------------------------------------------------------------------------

  // O nome da função muda entre versões do Web App; procura pelo padrão.
  const PILE_METHODS = {
    transfer: { names: ['requestTransferItems', 'getTransferItems', 'requestTradePile'], re: /(transfer|trade).*(item|pile|list)/i, not: /market|search|move|send|clear|relist|list$/i },
    unassigned: { names: ['requestUnassignedItems', 'getUnassignedItems', 'requestPurchasedItems'], re: /unassigned|purchased/i, not: /move|send|clear|discard/i },
    watch: { names: ['requestWatchedItems', 'getWatchedItems', 'requestWatchList'], re: /watch/i, not: /un|remove|clear|add|target/i },
  };

  function methodNames(obj) {
    const out = new Set();
    let o = obj;
    for (let depth = 0; o && o !== Object.prototype && depth < 5; depth++, o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) {
        if (k === 'constructor') continue;
        let v;
        try { v = obj[k]; } catch (e) { v = null; }
        if (typeof v === 'function') out.add(k);
      }
    }
    return Array.from(out);
  }

  function findPileMethod(obj, which) {
    const spec = PILE_METHODS[which];
    if (!obj || !spec) return null;
    const names = methodNames(obj);
    const exact = spec.names.find((n) => names.includes(n));
    if (exact) return exact;
    return names.find((n) => spec.re.test(n) && !spec.not.test(n) && /^(request|get|load|fetch|refresh)/i.test(n)) || null;
  }

  // Parece uma carta? (objeto da EA ou JSON cru com itemData)
  function looksLikeItem(x) {
    if (!x || typeof x !== 'object') return false;
    if (x.itemData && typeof x.itemData === 'object') return true;
    const has = (k) => { try { return x[k] != null || x['_' + k] != null; } catch (e) { return false; } };
    return has('id') && (has('definitionId') || has('resourceId') || has('rating') || has('_auction'));
  }

  function toArray(v) {
    if (Array.isArray(v)) return v;
    try {
      if (v && typeof v.values === 'function' && !(typeof v === 'string')) {
        const arr = Array.from(v.values());
        if (arr.length && arr.every((x) => x && typeof x === 'object')) return arr;
      }
    } catch (e) { /* ignora */ }
    return null;
  }

  // Procura, em qualquer lugar da resposta, uma lista de cartas.
  function findItemArray(obj, depth, seen) {
    depth = depth || 0;
    seen = seen || new Set();
    if (!obj || typeof obj !== 'object' || depth > 5 || seen.has(obj)) return null;
    seen.add(obj);
    const arr = toArray(obj);
    if (arr) {
      if (arr.length && arr.filter(looksLikeItem).length >= Math.ceil(arr.length * 0.8)) return arr.filter(looksLikeItem);
      if (Array.isArray(obj)) return null;
    }
    let keys = [];
    try { keys = Object.keys(obj); } catch (e) { keys = []; }
    for (const k of keys) {
      let v;
      try { v = obj[k]; } catch (e) { continue; }
      const r = findItemArray(v, depth + 1, seen);
      if (r) return r;
    }
    return null;
  }

  // Resumo da forma da resposta (para o Log, quando nada é encontrado).
  function shapeOf(obj, depth) {
    depth = depth || 0;
    if (obj == null) return String(obj);
    if (Array.isArray(obj)) return '[' + obj.length + (obj.length ? ' × ' + shapeOf(obj[0], depth + 1) : '') + ']';
    if (typeof obj !== 'object') return typeof obj;
    if (depth > 2) return '{…}';
    let keys = [];
    try { keys = Object.keys(obj).slice(0, 8); } catch (e) { keys = []; }
    return '{' + keys.map((k) => { let v; try { v = obj[k]; } catch (e) { v = '?'; } return k + ':' + shapeOf(v, depth + 1); }).join(', ') + '}';
  }

  function pileFromUrl(url) {
    const u = String(url || '');
    if (/\/tradepile(\?|$|\/)/i.test(u)) return 'transfer';
    if (/\/purchased\/items(\?|$)/i.test(u)) return 'unassigned';
    if (/\/watchlist(\?|$)/i.test(u)) return 'watch';
    return null;
  }

  // Converte a resposta crua da EA (auctionInfo / itemData) no formato do bot.
  function itemFromJson(entry, lookup) {
    const ai = entry && entry.itemData ? entry : { itemData: entry };
    const d = ai.itemData || {};
    if (!(d.id > 0)) return null;
    lookup = lookup || {};
    const entity = lookup.entity ? lookup.entity(d.id) : null;
    const type = String(d.itemType || '').toLowerCase();
    return {
      raw: entity || null,
      id: d.id,
      tradeId: ai.tradeId,
      definitionId: d.resourceId || d.assetId || 0,
      rating: d.rating || 0,
      name: (entity && lookup.entityName && lookup.entityName(entity)) || (lookup.playerName && lookup.playerName(d.assetId)) ||
        'Carta ' + (d.rating || '') + (d.assetId ? ' #' + d.assetId : ''),
      kind: type === 'player' ? 'player' : type || null,
      lastSalePrice: d.lastSalePrice || 0,
      untradeable: !!d.untradeable,
      rarity: typeof d.rareflag === 'number' ? d.rareflag : null,
      special: typeof d.rareflag === 'number' ? d.rareflag > 1 : null,
      marketAverage: d.marketAverage > 0 ? d.marketAverage : null,
      minPrice: d.marketDataMinPrice || 0,
      maxPrice: d.marketDataMaxPrice || 0,
      tradeState: ai.tradeState || null,
      currentBid: ai.currentBid || 0,
      startingBid: ai.startingBid || 0,
      buyNow: ai.buyNowPrice || 0,
      bidState: ai.bidState || null,
      tradeOwner: !!ai.tradeOwner,
      expires: ai.expires,
    };
  }

  function itemsFromPileJson(json, lookup) {
    const list = (json && (json.auctionInfo || json.itemData || json.items)) || [];
    return list.map((x) => itemFromJson(x, lookup)).filter(Boolean);
  }

  // Lê as respostas que o próprio Web App recebe (XHR e fetch) quando abre a
  // lista de transferências, não atribuídos ou observação. Não faz pedidos.
  function installPileCapture(win, onPile) {
    if (win.__fcabPileCapture) return;
    win.__fcabPileCapture = true;
    const handle = (url, text) => {
      const which = pileFromUrl(url);
      if (!which || !text) return;
      try { onPile(which, JSON.parse(text)); } catch (e) { /* não era JSON */ }
    };
    const XHR = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
    if (XHR && XHR.open) {
      const open = XHR.open;
      XHR.open = function (method, url) {
        try {
          if (pileFromUrl(url)) {
            this.addEventListener('load', () => {
              try { if (this.status >= 200 && this.status < 300) handle(url, this.responseText); } catch (e) { /* ignora */ }
            });
          }
        } catch (e) { /* ignora */ }
        return open.apply(this, arguments);
      };
    }
    if (typeof win.fetch === 'function') {
      const f = win.fetch;
      win.fetch = function (input) {
        const url = typeof input === 'string' ? input : input && input.url;
        const p = f.apply(this, arguments);
        if (pileFromUrl(url)) {
          p.then((r) => { if (r && r.ok) r.clone().text().then((t) => handle(url, t)).catch(() => {}); }).catch(() => {});
        }
        return p;
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Módulos de lances e de venda
  // ---------------------------------------------------------------------------

  function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  // Lances em massa: busca (as que terminam primeiro vêm antes), dá lances nas
  // que cabem no plano e repete até atingir o número de lances ou o limite de
  // buscas. Para sozinho em captcha, sessão expirada ou bloqueio.
  async function runBulkBids(o) {
    const { adapter, plan, settings: s, log } = o;
    const random = o.random || Math.random;
    const wait = o.wait || sleepMs;
    const stopped = o.isStopped || (() => false);
    // trace: andamento detalhado (aba Lances), além do Log normal.
    const trace = o.trace || (() => {});
    const seen = new Set();
    const res = { searches: 0, bids: 0, simulated: 0, missed: 0, coinsCommitted: 0, stopReason: '' };
    const maxRounds = plan.maxSearches > 0 ? plan.maxSearches : 30;
    const criteria = Object.assign({}, plan.target.criteria);
    delete criteria.minBuy;
    delete criteria.maxBuy;
    let busterIndex = 0;
    while (!stopped()) {
      if (plan.maxBids > 0 && res.bids + res.simulated >= plan.maxBids) { res.stopReason = 'número de lances atingido'; break; }
      if (res.searches >= maxRounds) { res.stopReason = 'limite de buscas atingido'; break; }
      const search = await adapter.search(Object.assign({}, criteria, {
        maxBid: roundDown(plan.maxBid),
        minBuy: cacheBusterValues(plan.maxBid)[busterIndex++ % cacheBusterValues(plan.maxBid).length],
      }));
      res.searches++;
      if (!search.success) {
        const kind = classifyStatus(search.status);
        res.stopReason = FATAL_MESSAGES[kind] ? STOP_REASONS[kind] + ' (código ' + search.status + ' na busca)' : 'erro ' + search.status + ' na busca';
        log((FATAL_MESSAGES[kind] || 'Erro na busca de lances.') + ' (código ' + search.status + ')', 'error');
        trace('Busca ' + res.searches + ': a EA recusou a busca (código ' + search.status + '). ' + (FATAL_MESSAGES[kind] || ''), 'error');
        break;
      }
      const left = plan.maxBids > 0 ? plan.maxBids - res.bids - res.simulated : 0;
      const skips = new Map();
      const picks = planBids(search.items, Object.assign({}, plan, { maxBids: left }), {
        coins: adapter.getCoins(),
        seen,
        onSkip: (it, why) => skips.set(why, (skips.get(why) || 0) + 1),
      });
      const skipText = Array.from(skips.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([why, n]) => n + ' ' + why).join(', ');
      trace('Busca ' + res.searches + ' de ' + maxRounds + ': ' + search.items.length + ' leilão(ões) achados, ' +
        picks.length + ' escolhido(s)' + (skipText ? ' · ignorados: ' + skipText : '') + '.', picks.length ? 'info' : 'muted');
      if (picks.length) await wait(randomBetween(900, 1800, random));
      for (const pick of picks) {
        if (stopped()) break;
        seen.add(pick.item.tradeId);
        const what = describeItem(pick.item) + ' (termina em ' + Math.max(1, Math.round(pick.item.expires / 60)) + ' min)';
        const now = pick.item.currentBid > 0 ? 'lance atual ' + fmt(pick.item.currentBid) : 'sem lances, inicial ' + fmt(pick.item.startingBid || MIN_PRICE);
        trace('→ ' + describeItem(pick.item) + ': ' + now + ' · tentando ' + fmt(pick.amount) + ' · termina em ' +
          Math.max(1, Math.round(pick.item.expires / 60)) + ' min', 'info');
        if (s.dryRun) {
          res.simulated++;
          log('SIMULAÇÃO: daria lance de ' + fmt(pick.amount) + ' em ' + what + '.', 'success');
          trace('   simulação: lance de ' + fmt(pick.amount) + ' não foi dado de verdade.', 'success');
          continue;
        }
        const bid = await adapter.buy(pick.item.raw, pick.amount);
        if (bid.success) {
          res.bids++;
          res.coinsCommitted += pick.amount;
          log('Lance de ' + fmt(pick.amount) + ' em ' + what + '.', 'success');
          if (o.onBid) o.onBid(pick.item, pick.amount);
          trace('   ✅ lance de ' + fmt(pick.amount) + ' aceito.', 'success');
        } else {
          const kind = classifyStatus(bid.status);
          if (FATAL_MESSAGES[kind]) {
            res.stopReason = STOP_REASONS[kind] + ' (código ' + bid.status + ' no lance)';
            log(FATAL_MESSAGES[kind] + ' (código ' + bid.status + ' no lance)', 'error');
            trace('   ❌ a EA recusou o lance (código ' + bid.status + '). ' + FATAL_MESSAGES[kind], 'error');
            trace('Fim: ' + res.stopReason + '.', 'warn');
            return res;
          }
          res.missed++;
          log('Lance não aceito em ' + describeItem(pick.item) + ' (alguém deu lance antes ou o leilão acabou).', 'warn');
          trace('   ❌ não aceito (alguém deu lance antes ou o leilão acabou).', 'warn');
        }
        await wait(randomBetween(800, 1600, random));
      }
      // Entre uma busca e outra: conferir/anunciar os leilões que já acabaram.
      if (o.between && !stopped()) await o.between();
      const pause = randomBetween(s.delayMin * 1000, s.delayMax * 1000, random);
      if (!stopped()) trace('Próxima busca em ' + Math.round(pause / 1000) + ' s… (' + (res.bids + res.simulated) + ' lance(s) até agora)', 'muted');
      await wait(pause);
    }
    if (!res.stopReason) res.stopReason = 'parado por você';
    trace('Fim: ' + res.stopReason + '.', 'warn');
    return res;
  }

  // Preços atuais consultados no mercado, guardados por 10 minutos.
  function createMarketCache(opts) {
    opts = opts || {};
    const now = opts.now || Date.now;
    const maxAge = opts.maxAge || 10 * 60 * 1000;
    const map = new Map();
    return {
      get(defId) {
        const v = map.get(defId);
        if (!v) return null;
        if (v.state !== 'checking' && now() - v.at > maxAge) { map.delete(defId); return null; }
        return v;
      },
      set(defId, v) { map.set(defId, Object.assign({ at: now() }, v)); },
      delete(defId) { map.delete(defId); },
      size: () => map.size,
    };
  }

  // Menor preço de "compre já" de uma carta no mercado da EA, agora.
  // A busca devolve até ~20 anúncios (não ordenados por preço); então busca de
  // novo com "compre já" máximo logo abaixo do menor achado, até não sobrar
  // nenhum mais barato ou a página vir incompleta (aí já vimos todos).
  async function lowestBin(o) {
    const { adapter, card } = o;
    const maxRounds = o.maxRounds || 5;
    const wait = o.wait || sleepMs;
    const random = o.random || Math.random;
    const pageSize = o.pageSize || 20;
    let max = 0;
    let best = null;
    let searches = 0;
    for (let round = 0; round < maxRounds; round++) {
      const criteria = { type: 'player', maskedDefId: baseDefId(card.definitionId) };
      if (max) criteria.maxBuy = max;
      criteria.minBuy = round % 2 ? 0 : 150 + 50 * (searches % 3); // varia a busca para não vir do cache
      if (criteria.minBuy && max && criteria.minBuy >= max) criteria.minBuy = 0;
      const res = await adapter.search(criteria);
      searches++;
      if (!res.success) {
        const kind = classifyStatus(res.status);
        const err = new Error(FATAL_MESSAGES[kind] || 'erro ' + res.status + ' na busca');
        err.fatal = !!FATAL_MESSAGES[kind];
        err.stop = STOP_REASONS[kind];
        throw err;
      }
      const bins = res.items.filter((it) => it.definitionId === card.definitionId && it.buyNow > 0).map((it) => it.buyNow);
      if (!bins.length) break;
      const m = Math.min.apply(null, bins);
      best = best == null ? m : Math.min(best, m);
      if (res.items.length < pageSize) break;
      const next = prevPrice(best);
      if (next >= best || next < 200) break;
      max = next;
      await wait(randomBetween(400, 800, random));
    }
    return { price: best, searches };
  }

  // Confere a lista de observação: cartas ganhas vão para a lista de
  // transferências e entram no registro com o valor do lance.
  // o.sell (opcional): { bin, duration, onlyIds } anuncia as ganhas por "bin";
  // onlyIds = só as cartas dos lances desta sessão.
  async function collectWonBids(o) {
    const { adapter, ledger, log, settings: s } = o;
    const wait = o.wait || sleepMs;
    const trace = o.trace || (() => {});
    const sell = o.sell && o.sell.bin > 0 ? o.sell : null;
    const pile = await adapter.pile('watch');
    if (!pile.success) return { error: pile.missing ? 'o Web App não ofereceu a lista de observação' : 'erro ' + pile.status };
    const counts = { ganhou: 0, ganhando: 0, superado: 0, perdeu: 0, acompanhando: 0, moved: 0, listed: 0, simulated: 0, failed: 0 };
    for (const it of pile.items) {
      const st = watchStatus(it);
      counts[st]++;
      if (st !== 'ganhou') continue;
      recordBuy(ledger, { itemId: it.id, name: it.name, rating: it.rating, definitionId: it.definitionId, price: it.currentBid, source: 'lance' });
      const toSell = sell && (!sell.onlyIds || sell.onlyIds.has(ledgerKey(it.id)));
      if (s.dryRun) {
        if (toSell) {
          counts.simulated++;
          trace('Simulação: anunciaria ' + describeItem(it) + ' (ganha por ' + fmt(it.currentBid) + ') por ' + fmt(sell.bin) + '.', 'success');
        }
        continue;
      }
      if (!it.raw) {
        counts.failed++;
        trace('❌ ' + describeItem(it) + ': abra "Transfer Targets" no Web App e toque em Conferir lances de novo.', 'warn');
        continue;
      }
      let moved;
      try { moved = await adapter.moveToTransferList(it.raw); } catch (e) { moved = { success: false, status: e.message }; }
      if (moved.success) counts.moved++;
      else {
        log('Não consegui mover ' + it.name + ' para a lista de transferências (erro ' + moved.status + ').', 'warn');
        trace('❌ ' + describeItem(it) + ': não consegui mover para a lista (erro ' + moved.status + ').', 'warn');
        await wait(400);
        continue;
      }
      await wait(randomBetween(500, 1000, Math.random));
      if (toSell) {
        const bin = roundDown(sell.bin);
        let listed;
        try { listed = await adapter.list(it.raw, prevPrice(bin), bin, sell.duration || 3600); } catch (e) { listed = { success: false, status: e.message }; }
        if (listed.success) {
          counts.listed++;
          const e = ledger[ledgerKey(it.id)];
          if (e) { e.status = 'à venda'; e.listedFor = bin; }
          const profit = netAfterTax(bin) - (it.currentBid || 0);
          log('Anunciei ' + describeItem(it) + ' por ' + fmt(bin) + ' (lucro estimado ' + fmt(profit) + ').', 'success');
          trace('✅ ' + describeItem(it) + ': ganha por ' + fmt(it.currentBid) + ', anunciada por ' + fmt(bin) + ' (lucro ' + fmt(profit) + ').', 'success');
        } else {
          counts.failed++;
          trace('❌ ' + describeItem(it) + ': não consegui anunciar (erro ' + listed.status + '). Ficou na lista de transferências.', 'warn');
          const kind = classifyStatus(listed.status);
          if (FATAL_MESSAGES[kind]) { log(FATAL_MESSAGES[kind], 'error'); break; }
        }
        await wait(randomBetween(800, 1500, Math.random));
      }
    }
    return counts;
  }

  // Venda em massa: anuncia a quantidade escolhida de cada grupo.
  async function runBulkSell(o) {
    const { adapter, orders, ledger, settings: s, log } = o;
    const random = o.random || Math.random;
    const wait = o.wait || sleepMs;
    const stopped = o.isStopped || (() => false);
    const res = { listed: 0, simulated: 0, failed: 0, stopReason: '' };
    for (const order of orders) {
      const items = order.group.items.slice().sort((a, b) => (b.raw ? 1 : 0) - (a.raw ? 1 : 0)).slice(0, order.qty);
      for (const it of items) {
        if (stopped()) { res.stopReason = 'parado por você'; return res; }
        if (!it.raw) {
          res.failed++;
          log('Não consegui anunciar ' + describeItem(it) + ': abra a lista de transferências no Web App (role até ver a carta) e tente de novo.', 'warn');
          continue;
        }
        if (s.dryRun) {
          res.simulated++;
          log('SIMULAÇÃO: anunciaria ' + describeItem(it) + ' por ' + fmt(order.bin) + ' (lance inicial ' + fmt(order.start) + ').', 'success');
          continue;
        }
        const r = await adapter.list(it.raw, order.start, order.bin, order.duration);
        if (r.success) {
          res.listed++;
          const e = ledger && ledger[ledgerKey(it.id)];
          if (e) { e.status = 'à venda'; e.listedFor = order.bin; }
          log('Anunciei ' + describeItem(it) + ' por ' + fmt(order.bin) + '.', 'success');
        } else {
          const kind = classifyStatus(r.status);
          if (FATAL_MESSAGES[kind]) {
            res.stopReason = STOP_REASONS[kind];
            log(FATAL_MESSAGES[kind], 'error');
            return res;
          }
          res.failed++;
          log('Não consegui anunciar ' + describeItem(it) + ' (erro ' + r.status + ').', 'warn');
        }
        await wait(randomBetween(1000, 2000, random));
      }
    }
    res.stopReason = 'concluído';
    return res;
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
    ItemPile: () => (typeof ItemPile !== 'undefined' ? ItemPile : undefined),
    repositories: () => (typeof repositories !== 'undefined' ? repositories : undefined),
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
  // Lê um sinal da carta que pode ser campo, campo com "_" ou função
  // (ex.: untradeable, isUntradeable()). Função nunca vira "verdadeiro" sem ser chamada.
  function readFlag(raw, names) {
    for (const name of names) {
      for (const key of [name, '_' + name]) {
        let v;
        try { v = raw[key]; } catch (e) { v = undefined; }
        if (typeof v === 'function') {
          try { v = v.call(raw); } catch (e) { v = undefined; }
        }
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v !== 0;
      }
    }
    return false;
  }

  function auctionOf(raw) {
    if (raw._auction && typeof raw._auction === 'object') return raw._auction;
    try {
      if (typeof raw.getAuctionData === 'function') return raw.getAuctionData() || {};
    } catch (e) { /* ignora */ }
    return raw.auctionInfo || {};
  }

  // Tipo do item que veio na busca: 'player', 'training' (consumível) ou outro.
  // Sem confirmação, devolve null, e o bot não compra.
  function itemKindOf(raw) {
    if (!raw) return null;
    const type = String(raw.type != null ? raw.type : (raw._type != null ? raw._type : '')).toLowerCase();
    let isPlayer = null;
    try { if (typeof raw.isPlayer === 'function') isPlayer = !!raw.isPlayer(); } catch (e) { isPlayer = null; }
    if (isPlayer === true) return 'player';
    if (type === 'player') return isPlayer === false ? null : 'player';
    if (type === 'staff' || type === 'manager') {
      let isManager = null;
      try { if (typeof raw.isManager === 'function') isManager = !!raw.isManager(); } catch (e) { isManager = null; }
      const cat = String(raw.category != null ? raw.category : '').toLowerCase();
      if (isManager === false || (cat && !/manager/.test(cat))) return 'staff';
      return 'manager';
    }
    if (type === 'training') return 'training';
    try { if (typeof raw.isTraining === 'function' && raw.isTraining()) return 'training'; } catch (e) { /* ignora */ }
    return type || null;
  }

  function createEaAdapter(win) {
    let internalCall = false;
    const G = (name) => lookupGlobal(win, name);

    // Espera a resposta do Web App, com prazo: nada fica esperando para sempre.
    function observe(observable, timeoutMs) {
      return new Promise((resolve) => {
        const scope = {};
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          resolve({ success: false, status: 'sem resposta', timeout: true });
        }, timeoutMs || 20000);
        try {
          observable.observe(scope, function (sender, response) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try {
              if (sender && typeof sender.unobserve === 'function') sender.unobserve(scope);
            } catch (e) { /* ignora */ }
            resolve(response || {});
          });
        } catch (e) {
          done = true;
          clearTimeout(timer);
          resolve({ success: false, status: 'erro ' + e.message });
        }
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

    function convert(lookup) {
      return (x) => (x && x.itemData ? itemFromJson(x, lookup) : toItem(x));
    }

    function toItem(raw) {
      const a = auctionOf(raw);
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
        playStyles: readPlayStyles(raw),
        id: numberOf(raw, 'id'),
        lastSalePrice: numberOf(raw, 'lastSalePrice') || 0,
        tradeState: a.tradeState || null,
        currentBid: a.currentBid || 0,
        startingBid: a.startingBid || 0,
        bidState: a.bidState || null,
        tradeOwner: !!a.tradeOwner,
        untradeable: readFlag(raw, ['untradeable', 'isUntradeable']),
        rarity: rarityOf(raw),
        special: isSpecialItem(raw),
        score: itemScoreOf(raw),
        marketAverage: eaMarketAverage(raw),
        minPrice: priceLimit(raw, 'min'),
        maxPrice: priceLimit(raw, 'max'),
        pile: numberOf(raw, 'pile'),
      };
    }

    // Raridade da EA: 0 comum, 1 rara, 2+ especial (TOTW, promo, herói...).
    function rarityOf(raw) {
      for (const k of ['rareflag', 'rarityId', 'rareFlag']) {
        const v = numberOf(raw, k);
        if (typeof v === 'number' && v >= 0) return v;
      }
      return null;
    }

    function isSpecialItem(raw) {
      for (const k of ['isSpecial', 'isSpecialItem']) {
        const v = readFlag(raw, [k]);
        if (v === true) return true;
      }
      const r = rarityOf(raw);
      return r == null ? null : r > 1;
    }

    // Pontos (Item Score) informados pelo próprio Web App, se houver.
    function itemScoreOf(raw) {
      for (const k of ['itemScore', 'sbcScore', 'galleryScore', 'score', 'getItemScore', 'getScore']) {
        const v = numberOf(raw, k);
        if (typeof v === 'number' && v > 0) return v;
      }
      return 0;
    }

    // Faixa de preço permitida pela EA para anunciar a carta.
    function priceLimit(raw, which) {
      const direct = field(raw, which === 'min' ? 'marketDataMinPrice' : 'marketDataMaxPrice');
      if (direct > 0) return direct;
      const lim = raw._itemPriceLimits || raw.itemPriceLimits;
      const v = lim && (which === 'min' ? lim.minimum : lim.maximum);
      return typeof v === 'number' && v > 0 ? v : 0;
    }

    function field(raw, name) {
      const v = raw[name] != null ? raw[name] : raw['_' + name];
      return typeof v === 'number' ? v : undefined;
    }

    // Número que pode vir como texto (ex.: ID grande da carta).
    function numberOf(raw, name) {
      let v = raw[name] != null ? raw[name] : raw['_' + name];
      if (typeof v === 'function') {
        try { v = v.call(raw); } catch (e) { v = undefined; }
      }
      const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
      return typeof n === 'number' && isFinite(n) ? n : undefined;
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

      // Endereço do players.json que o próprio Web App já baixou.
      playersDbUrl() {
        try {
          const entries = win.performance.getEntriesByType('resource');
          const hit = entries.map((e) => e.name).filter((n) => /players[^/]*\.json/i.test(n)).pop();
          return hit || null;
        } catch (e) {
          return null;
        }
      },

      criteriaDefaults() {
        try {
          const DTO = G('UTSearchCriteriaDTO');
          return DTO ? serializeCriteria(new DTO()) : null;
        } catch (e) {
          return null;
        }
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

      // Filtros escolhidos agora na tela de busca do Web App (mesmo sem tocar
      // em Search): procura o controlador da tela que guarda os critérios.
      screenCriteria() {
        try {
          const main = G('getAppMain');
          if (typeof main !== 'function') return null;
          const queue = [main().getRootViewController()];
          const seen = new Set();
          while (queue.length && seen.size < 60) {
            const c = queue.shift();
            if (!c || typeof c !== 'object' || seen.has(c)) continue;
            seen.add(c);
            const vm = c._viewmodel || c.viewmodel || c._viewModel;
            if (vm && vm.searchCriteria) return serializeCriteria(vm.searchCriteria);
            if (c.searchCriteria && typeof c.searchCriteria === 'object') return serializeCriteria(c.searchCriteria);
            for (const fn of ['getPresentedViewController', 'getCurrentViewController', 'getCurrentController']) {
              try { if (typeof c[fn] === 'function') queue.push(c[fn]()); } catch (e) { /* ignora */ }
            }
            for (const k of ['childViewControllers', '_childViewControllers', 'currentController', '_currentController']) {
              const v = c[k];
              if (Array.isArray(v)) v.forEach((x) => queue.push(x));
              else if (v && typeof v === 'object') queue.push(v);
            }
          }
        } catch (e) { /* tela sem busca */ }
        return null;
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
        for (const key of Object.keys(criteria)) {
          try { dto[key] = criteria[key]; } catch (e) { /* campo só de leitura */ }
        }
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

      async list(raw, startBid, buyNow, duration) {
        return result(await observe(G('services').Item.list(raw, startBid, buyNow, duration || 3600)));
      },

      // Quais destas cartas (definitionId) já estão no clube.
      async clubOwned(defIds, lookup) {
        const svc = G('services') && G('services').Club;
        const DTO = G('UTSearchCriteriaDTO');
        if (!svc || typeof svc.search !== 'function' || !DTO) return { success: false, missing: true, owned: new Set() };
        const dto = new DTO();
        try { dto.type = 'player'; } catch (e) { /* só leitura */ }
        try { dto.defId = defIds.slice(); } catch (e) { /* só leitura */ }
        try { dto.count = 100; } catch (e) { /* só leitura */ }
        let observable;
        try { observable = svc.search(dto); } catch (e) { return { success: false, status: 'erro ' + e.message, owned: new Set() }; }
        if (!observable || typeof observable.observe !== 'function') return { success: false, status: 'resposta inesperada', owned: new Set() };
        const response = await observe(observable, 15000);
        const list = findItemArray(response) || [];
        const want = new Set(defIds);
        const conv = list.map(convert(lookup)).filter(Boolean).filter((it) => want.has(it.definitionId));
        const owned = new Set(conv.map((it) => it.definitionId));
        const items = new Map();
        conv.forEach((it) => { if (!items.has(it.definitionId)) items.set(it.definitionId, it.raw); });
        return Object.assign(result(response), { success: !!response.success || list.length > 0, owned, items });
      },

      // Jogadores ouro do clube, página por página (o clube pode ser grande).
      async clubGoldPlayers(lookup, maxPages) {
        const svc = G('services') && G('services').Club;
        const DTO = G('UTSearchCriteriaDTO');
        if (!svc || typeof svc.search !== 'function' || !DTO) return { success: false, missing: true, items: [] };
        const all = [];
        const seen = new Set();
        for (let page = 0; page < (maxPages || 25); page++) {
          const dto = new DTO();
          try { dto.type = 'player'; } catch (e) { /* só leitura */ }
          try { dto.level = 'gold'; } catch (e) { /* só leitura */ }
          try { dto.count = 91; } catch (e) { /* só leitura */ }
          try { dto.offset = page * 90; } catch (e) { /* só leitura */ }
          let observable;
          try { observable = svc.search(dto); } catch (e) { return { success: all.length > 0, status: 'erro ' + e.message, items: all }; }
          if (!observable || typeof observable.observe !== 'function') break;
          const response = await observe(observable, 15000);
          const list = findItemArray(response) || [];
          let added = 0;
          for (const it of list.map(convert(lookup)).filter(Boolean)) {
            if (!(it.id > 0) || seen.has(it.id)) continue;
            seen.add(it.id);
            all.push(it);
            added++;
          }
          if (list.length < 90 || !added) break;
          await sleepMs(500);
        }
        return { success: true, items: all };
      },

      // IDs das cartas do time ativo (para não usar no SBC).
      async activeSquadIds() {
        const ids = new Set();
        const tried = [];
        const take = (x, depth) => {
          if (!x || typeof x !== 'object' || depth > 3) return;
          const arr = findItemArray(x) || [];
          arr.forEach((it) => { const id = numberOf(it, 'id') || (it.itemData && it.itemData.id); if (id > 0) ids.add(id); });
          for (const fn of ['getPlayers', 'getFieldPlayers', 'getSubstitutes', 'getReserves']) {
            try {
              if (typeof x[fn] === 'function') {
                (x[fn]() || []).forEach((sl) => {
                  const it = sl && (sl.item || sl._item || (typeof sl.getItem === 'function' ? sl.getItem() : sl));
                  const id = it && numberOf(it, 'id');
                  if (id > 0) ids.add(id);
                });
              }
            } catch (e) { /* ignora */ }
          }
          for (const k of ['squad', '_squad', 'activeSquad', '_activeSquad', 'data']) if (x[k] && x[k] !== x) take(x[k], depth + 1);
        };
        const sources = [['services', 'Squad'], ['services', 'Squads'], ['repositories', 'Squad'], ['repositories', 'Squads']];
        for (const [root, name] of sources) {
          const svc = G(root) && G(root)[name];
          if (!svc) continue;
          // Propriedades já carregadas (time ativo em memória).
          for (const k of Object.keys(svc)) {
            if (/active/i.test(k)) { tried.push(root + '.' + name + '.' + k); take(svc[k], 0); }
          }
          for (const fn of methodNames(svc).filter((n) => /active/i.test(n) && /^(get|request|load|fetch)/i.test(n))) {
            tried.push(root + '.' + name + '.' + fn + '()');
            try {
              let res = svc[fn]();
              if (res && typeof res.observe === 'function') res = await observe(res, 15000);
              take(res, 0);
            } catch (e) { /* tenta a próxima */ }
          }
          if (ids.size >= 11) return { success: true, ids, method: tried[tried.length - 1] };
        }
        return { success: ids.size > 0, ids, why: tried.length ? 'tentei ' + tried.slice(0, 6).join(', ') : 'não achei o serviço de elencos', tried };
      },

      // Marcas na própria carta de que ela está no time ativo.
      inActiveSquad(raw) {
        for (const k of ['isInActiveSquad', 'inActiveSquad', 'isInSquad', 'inSquad', 'isActiveSquadMember']) {
          try {
            const v = raw[k];
            const val = typeof v === 'function' ? v.call(raw) : v;
            if (val === true) return true;
          } catch (e) { /* ignora */ }
        }
        return false;
      },

      // O que o desafio aberto tem por dentro (para ajustar a montagem).
      sbcDescribe(found) {
        const out = [];
        const nums = (obj, prefix) => {
          if (!obj || typeof obj !== 'object') return;
          for (const k of Object.keys(obj)) {
            let v;
            try { v = obj[k]; } catch (e) { continue; }
            if (typeof v === 'number' && /score|point|target|progress|goal|value|req/i.test(k)) out.push(prefix + k + '=' + v);
          }
        };
        if (found.key) out.push('achado em: ' + found.key);
        nums(found.challenge, 'desafio.');
        if (found.squad) nums(found.squad, 'elenco.');
        out.push('campos do desafio: ' + Object.keys(found.challenge || {}).slice(0, 30).join(', '));
        out.push('métodos do desafio: ' + methodNames(found.challenge).slice(0, 25).join(', '));
        if (found.squad) out.push('métodos do elenco: ' + methodNames(found.squad).filter((n) => /item|player|slot|add|set|remove|score/i.test(n)).slice(0, 25).join(', '));
        else out.push('o desafio não tem "squad" (SBC por pontos usa outra estrutura)');
        const ctl = found.controller;
        if (ctl) out.push('métodos da tela: ' + methodNames(ctl).filter((n) => /item|add|select|auto|submit|save|work|score|club|storage/i.test(n)).slice(0, 30).join(', '));
        const sbc = G('services') && G('services').SBC;
        if (sbc) out.push('services.SBC: ' + methodNames(sbc).slice(0, 25).join(', '));
        return out;
      },

      async moveToClub(raw) {
        const Pile = G('ItemPile');
        const svc = G('services').Item;
        if (!Pile || typeof svc.move !== 'function') return { success: false, status: 0 };
        try { return result(await observe(svc.move(raw, Pile.CLUB))); } catch (e) { return { success: false, status: e.message }; }
      },

      // Desafio de SBC aberto agora no Web App (tela do elenco do desafio).
      sbcChallenge() {
        const diag = { classes: [], keys: [] };
        try {
          const main = G('getAppMain');
          if (typeof main !== 'function') return { error: 'Web App não encontrado', diag };
          const queue = [main().getRootViewController()];
          const seen = new Set();
          const isCtl = (v) => v && typeof v === 'object' && !v.nodeType && !Array.isArray(v) &&
            /Controller|ViewModel|Presenter|Navigation/i.test((v.constructor && v.constructor.name) || '');
          const looksChallenge = (v) => v && typeof v === 'object' && !v.nodeType &&
            ['squad', 'eligibilityRequirements', 'requirements', 'id', 'challengeId'].some((k) => { try { return v[k] != null; } catch (e) { return false; } });
          while (queue.length && seen.size < 400) {
            const c = queue.shift();
            if (!c || typeof c !== 'object' || seen.has(c)) continue;
            seen.add(c);
            const cls = (c.constructor && c.constructor.name) || '?';
            if (diag.classes.length < 40 && !diag.classes.includes(cls)) diag.classes.push(cls);
            let keys = [];
            try { keys = Object.keys(c); } catch (e) { keys = []; }
            for (const k of keys) {
              let v;
              try { v = c[k]; } catch (e) { continue; }
              if (/challenge|sbc|workarea|work_area|submission/i.test(k) && diag.keys.length < 40) diag.keys.push(cls + '.' + k);
              if (/challenge/i.test(k) && looksChallenge(v)) {
                return { challenge: v, squad: v.squad && typeof v.squad === 'object' ? v.squad : null, controller: c, key: cls + '.' + k, diag };
              }
              if (isCtl(v)) queue.push(v);
              else if (Array.isArray(v) && v.length && v.length < 30 && v.some(isCtl)) v.forEach((x) => { if (isCtl(x)) queue.push(x); });
            }
            const vm = c._viewmodel || c.viewmodel || c._viewModel;
            if (vm && typeof vm === 'object') {
              for (const k of Object.keys(vm)) {
                if (/challenge/i.test(k) && looksChallenge(vm[k])) return { challenge: vm[k], squad: vm[k].squad || null, controller: c, key: cls + '.viewmodel.' + k, diag };
              }
              queue.push(vm);
            }
            for (const fn of ['getPresentedViewController', 'getCurrentViewController', 'getCurrentController', 'getRootViewController']) {
              try { if (typeof c[fn] === 'function') queue.push(c[fn]()); } catch (e) { /* ignora */ }
            }
            for (const k of ['childViewControllers', '_childViewControllers', 'currentController', '_currentController']) {
              const v = c[k];
              if (Array.isArray(v)) v.forEach((x) => queue.push(x));
              else if (v && typeof v === 'object') queue.push(v);
            }
          }
        } catch (e) { return { error: 'erro ' + e.message, diag }; }
        return { error: 'abra o desafio (a tela do SBC) no Web App', diag };
      },

      // Vagas do elenco do desafio: [{ index, position, item }].
      sbcSlots(squad, max) {
        let list = [];
        for (const fn of ['getFieldPlayers', 'getPlayers', 'getSlots']) {
          try { if (typeof squad[fn] === 'function') { list = squad[fn]() || []; if (list.length) break; } } catch (e) { /* ignora */ }
        }
        if (!list.length) list = squad._players || squad.players || [];
        return Array.from(list).slice(0, max || 11).map((slot, index) => {
          let pos = null;
          try {
            const p = slot && (typeof slot.getPosition === 'function' ? slot.getPosition() : slot.position || slot._position);
            pos = p && (p.typeName || p.name || (typeof p.id === 'number' ? POSITION_IDS[p.id] : null) || (typeof p === 'string' ? p : null));
            if (!pos && typeof p === 'number') pos = POSITION_IDS[p];
          } catch (e) { pos = null; }
          const item = slot && (slot.item || slot._item || (typeof slot.getItem === 'function' ? slot.getItem() : null));
          return { index, position: pos ? String(pos).toUpperCase() : '', item: item || null };
        });
      },

      // Coloca as cartas nas vagas e salva o desafio (não envia).
      async sbcPlace(found, picks) {
        const squad = found.squad;
        let method = '';
        try {
          if (typeof squad.addItemToSlot === 'function') {
            picks.forEach((p) => squad.addItemToSlot(p.index, p.raw));
            method = 'addItemToSlot';
          } else if (typeof squad.setPlayers === 'function') {
            const cur = this.sbcSlots(squad, found.maxSlots || 11).map((sl) => sl.item);
            while (cur.length < (found.maxSlots || 11)) cur.push(null);
            picks.forEach((p) => { cur[p.index] = p.raw; });
            squad.setPlayers(cur, true);
            method = 'setPlayers';
          } else {
            return { success: false, status: 'não achei a função do Web App que coloca jogadores no elenco' };
          }
        } catch (e) {
          return { success: false, status: 'erro ao colocar: ' + e.message, method };
        }
        const sbc = G('services') && G('services').SBC;
        if (sbc && typeof sbc.saveChallenge === 'function') {
          try {
            const r = await observe(sbc.saveChallenge(found.challenge), 15000);
            return Object.assign(result(r), { method, saved: true });
          } catch (e) {
            return { success: false, status: 'erro ao salvar: ' + e.message, method };
          }
        }
        return { success: true, method, saved: false };
      },

      // Pilhas da conta: lista de transferências, não atribuídos e lances.
      async pile(which, lookup) {
        const svc = G('services') && G('services').Item;
        const fn = findPileMethod(svc, which);
        if (!fn) return { success: false, status: 0, items: [], missing: true };
        let observable;
        try { observable = svc[fn](); } catch (e) { return { success: false, status: 'erro ' + e.message, items: [] }; }
        if (!observable || typeof observable.observe !== 'function') return { success: false, status: 'resposta inesperada', items: [], method: fn };
        const response = await observe(observable, 15000);
        const list = findItemArray(response) || [];
        const items = list.map(convert(lookup)).filter(Boolean);
        const ok = !!response.success || (!response.timeout && list.length > 0);
        return Object.assign(result(response), { success: ok, items, method: fn, timeout: !!response.timeout,
          shape: items.length ? '' : shapeOf(response) });
      },

      // Cartas que o Web App guarda no "depósito" interno (repositories.Item).
      repositoryPile(which, lookup) {
        const repo = G('repositories') && G('repositories').Item;
        if (!repo) return null;
        const re = { transfer: /transfer|trade/i, unassigned: /unassigned|purchased/i, watch: /watch/i }[which];
        const candidates = [];
        for (const name of methodNames(repo)) {
          if (re.test(name) && /^get/i.test(name) && !/count|size|limit|max/i.test(name)) candidates.push(() => repo[name]());
        }
        let keys = [];
        try { keys = Object.keys(repo); } catch (e) { keys = []; }
        keys.filter((k) => re.test(k)).forEach((k) => candidates.push(() => repo[k]));
        for (const get of candidates) {
          let v;
          try { v = get(); } catch (e) { continue; }
          const list = findItemArray(v);
          if (list && list.length) return list.map(convert(lookup)).filter(Boolean);
        }
        return null;
      },

      // Número da pilha "lista de transferências" (para filtrar cartas da tela).
      pileId(which) {
        const Pile = G('ItemPile');
        const key = { transfer: 'TRANSFER', unassigned: 'PURCHASED', watch: 'INBOX' }[which];
        return Pile && Pile[key] != null ? Pile[key] : { transfer: 5, unassigned: 7 }[which];
      },

      toItem,

      // Nomes das funções do Web App ligadas às pilhas (para o Diagnóstico).
      pileMethods() {
        const svc = G('services') && G('services').Item;
        if (!svc) return 'services.Item não encontrado';
        return ['transfer', 'unassigned', 'watch'].map((w) => w + ': ' + (findPileMethod(svc, w) || '—')).join(', ') +
          ' | outras: ' + methodNames(svc).filter((n) => /transfer|trade|unassigned|purchas|watch|pile|relist/i.test(n)).slice(0, 15).join(', ');
      },

      async moveToTransferList(raw) {
        const Pile = G('ItemPile');
        const svc = G('services').Item;
        if (!Pile || typeof svc.move !== 'function') return { success: false, status: 0 };
        return result(await observe(svc.move(raw, Pile.TRANSFER)));
      },

      // Sempre que o Web App carregar a lista de transferências, o registro de
      // lucro é atualizado (inclusive antes de "Limpar vendidos").
      hookTransferList(callback) {
        const svc = G('services') && G('services').Item;
        if (!svc || typeof svc.requestTransferItems !== 'function' || svc.requestTransferItems.__fcabHooked) return false;
        const original = svc.requestTransferItems;
        const wrapped = function () {
          const observable = original.apply(this, arguments);
          if (observable && typeof observable.observe === 'function') {
            observe(observable).then((response) => {
              const items = ((response.data && response.data.items) || []).map(toItem);
              try { callback(items); } catch (e) { /* ignora */ }
            }).catch(() => {});
          }
          return observable;
        };
        wrapped.__fcabHooked = true;
        svc.requestTransferItems = wrapped;
        return true;
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
    maxSearches: 600,
    maxBuys: 0,
    budget: 0,
    platform: 'ps',
    futbinMargin: 15,
    showCardPrices: true,
    priceSource: 'market',
    dryRun: true,
  };

  // Alvos criados antes da versão 0.6 não tinham tipo confirmado (foi assim que
  // uma busca de consumível virou compra de jogador). Ficam desligados até o
  // usuário revisar e salvar.
  function migrateTarget(t) {
    if (!t || t.kind) return t;
    return Object.assign({}, t, { kind: kindFromCriteria(t.criteria), enabled: false, needsReview: true });
  }

  // Lances dados pelo bot, guardados por 14 dias para reconhecer as cartas ganhas.
  function pruneBids(bids) {
    const out = {};
    const limit = Date.now() - 14 * 24 * 3600 * 1000;
    for (const [k, v] of Object.entries(bids && typeof bids === 'object' ? bids : {})) {
      if (v && v.at > limit) out[k] = v;
    }
    return out;
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
        const settings = Object.assign({}, DEFAULT_SETTINGS, saved.settings);
        // v2: sem limite de compras por sessão (vale a quantidade de cada alvo)
        // e 600 buscas por sessão em vez de 300.
        if (!(settings.v >= 2)) {
          if (settings.maxSearches === 300) settings.maxSearches = 600;
          settings.maxBuys = 0;
          settings.v = 2;
        }
        return {
          settings,
          targets: (Array.isArray(saved.targets) ? saved.targets : []).map(migrateTarget),
          history: Array.isArray(saved.history) ? saved.history : [],
          ledger: migrateLedger(saved.ledger && typeof saved.ledger === 'object' ? saved.ledger : {}),
          sbc: saved.sbc && Array.isArray(saved.sbc.players) ? saved.sbc : null,
          bids: pruneBids(saved.bids),
          pts: saved.pts && Array.isArray(saved.pts.lines) ? saved.pts : null,
          ptsProtected: Array.isArray(saved.ptsProtected) ? saved.ptsProtected : [],
          bidSession: saved.bidSession && Array.isArray(saved.bidSession.ids) ? saved.bidSession : null,
        };
      },
      save(state) {
        try {
          storage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) { /* armazenamento indisponível */ }
      },
    };
  }

  // Mantém os botões flutuantes inteiros dentro da tela.
  function clampDock(pos, size, view) {
    const m = 4;
    const x = Math.min(Math.max(m, pos.x), Math.max(m, view.w - size.w - m));
    const y = Math.min(Math.max(m, pos.y), Math.max(m, view.h - size.h - m));
    return { x: Math.round(x), y: Math.round(y) };
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
#fcab-dock{position:fixed;right:12px;bottom:96px;z-index:2147483646;display:flex;flex-direction:column;align-items:center;gap:10px;touch-action:none;-webkit-user-select:none;user-select:none}
#fcab-dock.dragging{opacity:.75}
#fcab-dock.dragging button{transform:scale(1.08)}
#fcab-price{touch-action:none;min-width:44px;height:44px;border-radius:22px;border:0;padding:0 10px;background:#1f6feb;color:#fff;font:700 16px -apple-system,system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4)}
#fcab-price.busy{background:#9a6700;font-size:13px}
#fcab-toggle{touch-action:none;width:48px;height:48px;border-radius:50%;border:0;background:#1db954;color:#fff;font-size:22px;box-shadow:0 2px 8px rgba(0,0,0,.4)}
#fcab-panel{position:fixed;right:8px;bottom:8px;z-index:2147483647;width:min(380px,calc(100vw - 16px));max-height:78vh;overflow:auto;background:#15171c;color:#e8e8e8;border:1px solid #333;border-radius:12px;font:14px/1.4 -apple-system,system-ui,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.6)}
#fcab-panel[hidden]{display:none}
#fcab-panel *{box-sizing:border-box}
#fcab-panel .h{display:flex;gap:6px;align-items:center;padding:10px;border-bottom:1px solid #2a2d33;position:sticky;top:0;background:#15171c;z-index:10}
#fcab-panel .st{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#fcab-panel .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:#777}
#fcab-panel button{font:inherit;border:0;border-radius:8px;padding:8px 10px;background:#2a2d33;color:#e8e8e8}
#fcab-panel button:disabled{opacity:.4}
#fcab-panel button.go{background:#1db954;color:#fff}
#fcab-panel button.no{background:#c0392b;color:#fff}
#fcab-panel .pts-row{display:grid;grid-template-columns:56px auto 56px 1fr 30px;gap:6px;align-items:center;margin-top:8px}
#fcab-panel .pts-row span{font-size:13px;color:#9aa0a6}
#fcab-panel .pts-row button{padding:6px 0}
#fcab-panel .pts-pick{display:flex;gap:8px;align-items:center;padding:4px 0;font-size:13px;border-top:1px solid #2a2d33}
#fcab-panel .sbc-row{display:grid;grid-template-columns:26px 1fr 86px;gap:8px;align-items:center;padding:7px 0;border-top:1px solid #2a2d33}
#fcab-panel .sbc-row input[type=checkbox]{width:22px;height:22px}
#fcab-panel .sbc-head{font-size:11px;color:#9aa0a6;border-top:0;padding-bottom:0}
#fcab-panel textarea{width:100%;box-sizing:border-box;font-size:16px;padding:7px;border-radius:6px;border:1px solid #3b3f47;background:#0e0f12;color:#fff;margin-top:8px}
#fcab-panel .fberr{margin:0 10px 8px;padding:8px;border-radius:8px;background:#3a1d1d;color:#ffb4b4;font-size:12px;word-break:break-word}
#fcab-panel .fberr[hidden]{display:none}
#fcab-panel .stats{padding:8px 10px;font-size:12px;color:#aaa;display:grid;grid-template-columns:repeat(3,1fr);gap:4px}
#fcab-panel .stats b{color:#fff;display:block;font-size:14px}
#fcab-panel .tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:0 10px 8px}
#fcab-panel .tabs button{padding:7px 4px;font-size:13px}
#fcab-panel .kpis{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0}
#fcab-panel .kpi{background:#12151a;border-radius:10px;padding:8px}
#fcab-panel .kpi span{display:block;font-size:11px;color:#9aa3b2}
#fcab-panel .kpi b{font-size:17px}
#fcab-panel .pos{color:#4cd97b}
#fcab-panel .neg{color:#ff6b6b}
#fcab-panel .rows{font-size:12px}
#fcab-panel .rows .r{display:flex;gap:6px;justify-content:space-between;border-bottom:1px solid #22262d;padding:5px 0}
#fcab-panel .rows .r div:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#fcab-panel .sg-top{display:flex;justify-content:space-between;align-items:center;gap:6px}
#fcab-panel .sg-count{font-size:13px;background:#12344d;color:#6fc3ff;border-radius:999px;padding:2px 8px;white-space:nowrap}
#fcab-panel .r.ignored{opacity:.6}
#fcab-panel .bidlog{margin-top:8px;max-height:260px;overflow:auto;background:#0e0f12;border:1px solid #2a2d33;border-radius:8px;padding:6px 8px;font-size:12px;line-height:1.45}
#fcab-panel .bidlog .success{color:#4ade80}
#fcab-panel .bidlog .warn{color:#fbbf24}
#fcab-panel .bidlog .error{color:#f87171}
#fcab-panel .bidlog .muted{color:#8b919c}
#fcab-panel .tg-result{font-size:13px;margin-top:3px}
#fcab-panel .tg-result span{color:#9aa0a6;font-size:12px}
#fcab-panel .profit-line{margin-top:6px}
#fcab-panel .profit-line span{color:#9aa0a6;font-size:12px}
#fcab-panel .stepper{display:flex;gap:4px;align-items:stretch}
#fcab-panel .stepper input{min-width:0;flex:1;text-align:center}
#fcab-panel .stepper button{flex:none;width:36px;padding:0;font-size:20px;font-weight:700}
#fcab-panel .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}
#fcab-panel .result{background:#12151a;border-radius:8px;padding:8px;font-size:12px;margin-top:8px}
#fcab-panel .result[hidden]{display:none}
#fcab-panel .tabs button.on{background:#3b3f47}
#fcab-panel section{padding:0 10px 12px}
#fcab-panel section[hidden]{display:none}
#fcab-panel label{display:block;margin:8px 0 2px;font-size:12px;color:#aaa}
#fcab-panel input[type=text],#fcab-panel input:not([type]){width:100%;font-size:16px;padding:7px;border-radius:6px;border:1px solid #3b3f47;background:#0e0f12;color:#fff}
#fcab-panel select{width:100%;font-size:16px;padding:7px;border-radius:6px;border:1px solid #3b3f47;background:#0e0f12;color:#fff}
#fcab-panel .fb{margin-top:4px}
#fcab-panel .card{background:#1b1e24;border:1px solid #2a2d33;border-radius:12px;padding:10px;margin:8px 0}
#fcab-panel .card.on{border-color:#1db954}
#fcab-panel .card-h{font-weight:700;font-size:15px;margin-bottom:4px}
#fcab-panel .newcard{border-style:dashed}
#fcab-panel .captured{font-size:12px;color:#cfd3da;background:#12151a;border-radius:8px;padding:6px 8px;margin:6px 0}
#fcab-panel .tg-top{display:flex;align-items:center;gap:8px}
#fcab-panel .tg-title{flex:1;min-width:0}
#fcab-panel .tg-title .name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#fcab-panel button.icon{padding:6px 9px;background:#262a31}
#fcab-panel .pill{display:inline-block;font-size:11px;font-weight:700;border-radius:999px;padding:1px 8px;margin-top:2px}
#fcab-panel .pill-player{background:#12344d;color:#6fc3ff}
#fcab-panel .pill-chem{background:#2e2048;color:#c7a6ff}
#fcab-panel .pill-none{background:#4a1d1d;color:#ff8f8f}
#fcab-panel .pill-done{background:#1d4d33;color:#7ff0a6}
#fcab-panel .count b{font-size:13px}
#fcab-panel .count button{padding:3px 8px;font-size:12px;margin-left:4px}
#fcab-panel .tags{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0 4px}
#fcab-panel .tag{background:#262a31;color:#dfe3ea;border-radius:6px;padding:2px 7px;font-size:12px}
#fcab-panel .sw{position:relative;display:inline-block;width:40px;height:24px;flex:none}
#fcab-panel .sw input{opacity:0;width:0;height:0}
#fcab-panel .sw span{position:absolute;inset:0;background:#3b3f47;border-radius:999px;transition:.2s}
#fcab-panel .sw span:before{content:"";position:absolute;width:18px;height:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
#fcab-panel .sw input:checked+span{background:#1db954}
#fcab-panel .sw input:checked+span:before{transform:translateX(16px)}
#fcab-panel .sw input:disabled+span{opacity:.35}
#fcab-panel .ed-sec{margin:10px 0}
#fcab-panel .ed-h{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#9aa3b2;margin-bottom:6px}
#fcab-panel .chips{display:flex;flex-wrap:wrap;gap:6px}
#fcab-panel .seg{display:flex;gap:6px}
#fcab-panel .seg .chip{flex:1}
#fcab-panel .chip{padding:7px 10px;border-radius:999px;background:#262a31;border:1px solid #333842;font-size:13px}
#fcab-panel .chip.on{background:#1d4d33;border-color:#1db954;color:#fff}
#fcab-panel .chip.plus{background:#4d3d12;border-color:#ffd24d;color:#ffe9a6}
#fcab-panel .ps-group{margin:6px 0}
#fcab-panel .ps-g{font-size:11px;color:#8a93a3;margin:4px 0}
#fcab-panel details summary{cursor:pointer;color:#6fc3ff;font-size:13px;margin-bottom:4px}
#fcab-panel .sel{display:flex;align-items:center;gap:8px;background:#1d4d33;border:1px solid #1db954;border-radius:999px;padding:4px 4px 4px 12px}
#fcab-panel .sel span{flex:1;font-weight:600}
#fcab-panel .sel button{padding:4px 9px;border-radius:999px}
#fcab-panel .results{display:flex;flex-direction:column;gap:2px;margin-top:4px;max-height:200px;overflow:auto}
#fcab-panel .results button{text-align:left;background:#12151a;border-radius:6px;padding:8px}
#fcab-panel .results small{color:#9aa3b2;margin-left:6px}
#fcab-panel .ed-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
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
#fcab-panel button.price{background:#1f6feb;color:#fff}
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
    ['budget', 'Orçamento máximo por sessão em moedas (0 = sem limite)'],
    ['futbinMargin', 'Margem abaixo do FUTBIN para sugerir a compra (%)'],
  ];

  function createUI(win, deps) {
    const doc = win.document;
    const { app, store, engine, adapter, futbin } = deps;
    const names = deps.names || {};
    const players = deps.players || { search: () => Promise.resolve({ ok: false, list: [] }) };
    const logs = [];
    let tab = 'targets';

    const style = doc.createElement('style');
    style.textContent = CSS;
    doc.head.appendChild(style);

    const toggle = doc.createElement('button');
    toggle.id = 'fcab-toggle';
    toggle.textContent = '⚡';
    toggle.title = 'FC27 Autobuyer';

    const priceBtn = doc.createElement('button');
    priceBtn.id = 'fcab-price';
    priceBtn.textContent = '💲';
    priceBtn.title = 'Preço atual no mercado das cartas da tela';

    // ⚡ e 💲 ficam juntos e dá para arrastá-los para qualquer canto da tela.
    const dock = doc.createElement('div');
    dock.id = 'fcab-dock';
    dock.appendChild(priceBtn);
    dock.appendChild(toggle);

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
      <div class="dry" data-el="dry" hidden>🧪 MODO SIMULAÇÃO: nada é comprado, anunciado nem recebe lance; o Log mostra o que seria feito. Confira e desligue em Config.</div>
      <div class="fberr" data-el="fberr" hidden></div>
      <div class="tabs">
        <button data-tab="targets">🎯 Sniper</button>
        <button data-tab="sbc">🧩 SBC</button>
        <button data-tab="bids">🔨 Lances</button>
        <button data-tab="sell">🏷️ Vender</button>
        <button data-tab="profit">💰 Lucro</button>
        <button data-tab="settings">⚙️ Config</button>
        <button data-tab="log">📜 Log</button>
      </div>
      <section data-pane="targets">
        <div class="ed-actions" data-el="targetsClean">
          <button data-act="cleanDone">🧹 Limpar concluídos e desligados</button>
          <button class="no" data-act="cleanAll">🗑 Apagar todos</button>
        </div>
        <div data-el="targets"></div>
        <div class="card newcard">
          <div class="card-h">＋ Novo alvo</div>
          <p class="hint">Monte os filtros abaixo, ou faça uma busca em <b>Transferências → Pesquisar no mercado</b> do Web App: ela aparece aqui já preenchida.</p>
          <div class="captured" data-el="captured">Nenhuma busca capturada ainda.</div>
          <p class="hint" data-el="capturedPrice"></p>
          <div data-el="newFilters"></div>
          <div class="ed-sec">
            <div class="ed-h">Nome e preços</div>
            <label>Nome (só pra você identificar)</label>
            <input data-el="newName" placeholder="Ex.: Zagueiro Shadow">
            <div class="grid">
              <div><label>Compra até</label><div class="stepper"><button type="button" data-step="-" aria-label="Diminuir">−</button><input data-el="newMax" inputmode="numeric" placeholder="Ex.: 5000"><button type="button" data-step="+" aria-label="Aumentar">+</button></div></div>
              <div><label>Revende por (opcional)</label><div class="stepper"><button type="button" data-step="-" aria-label="Diminuir">−</button><input data-el="newSell" inputmode="numeric" placeholder="vazio = não revende"><button type="button" data-step="+" data-from="[data-el=newMax]" aria-label="Aumentar">+</button></div></div>
            </div>
            <label>Buscar a partir de (opcional)</label>
            <div class="stepper"><button type="button" data-step="-" aria-label="Diminuir">−</button><input data-el="newMinPrice" inputmode="numeric" placeholder="vazio = qualquer preço"><button type="button" data-step="+" aria-label="Aumentar">+</button></div>
            <p class="hint">Preço mínimo da busca. Deixa de fora as cartas baratas: útil com "Nota mínima" (ex.: Ouro, nota 85+, de 1.800 a 2.400).</p>
            <label>Quantas cartas comprar</label>
            <input data-el="newCount" inputmode="numeric" placeholder="vazio = sem limite">
            <p class="hint">Quando chegar nesse número, o alvo é desligado e o bot para de procurar essa carta.</p>
          </div>
          <button class="go full" data-act="add">Adicionar alvo</button>
        </div>
      </section>
      <section data-pane="settings" hidden>
        <div data-el="settings"></div>
        <p class="hint">Os botões ⚡ e 💲 podem ser arrastados para qualquer lugar da tela: toque, segure e arraste.</p>
        <button class="full" data-act="dockReset">Voltar os botões ⚡ 💲 para o lugar padrão</button>
        <button class="full" data-act="diagnose">Diagnóstico do Web App</button>
        <div class="hint" data-el="diag"></div>
      </section>
      <section data-pane="log" hidden><div class="log" data-el="log"></div></section>
      <section data-pane="bids" hidden>
        <div class="card">
          <div class="card-h">🔨 Lances em massa</div>
          <p class="hint">O bot busca leilões que terminam logo e dá lances até o seu limite. As moedas de cada lance ficam presas até alguém cobrir.</p>
          <label>Quais cartas</label>
          <select data-el="bidTarget"></select>
          <div class="grid">
            <div><label>Lance mínimo por carta</label><div class="stepper"><button type="button" data-step="-" aria-label="Diminuir">−</button><input data-el="bidMin" inputmode="numeric" placeholder="automático"><button type="button" data-step="+" aria-label="Aumentar">+</button></div></div>
            <div><label>Lance máximo por carta</label><div class="stepper"><button type="button" data-step="-" aria-label="Diminuir">−</button><input data-el="bidMax" inputmode="numeric" placeholder="Ex.: 1500"><button type="button" data-step="+" aria-label="Aumentar">+</button></div></div>
            <div><label>Quantos lances</label><input data-el="bidCount" inputmode="numeric" value="10"></div>
            <div><label>Só leilões que terminam em até (min)</label><input data-el="bidMinutes" inputmode="numeric" value="5"></div>
            <div><label>Máximo de buscas</label><input data-el="bidSearches" inputmode="numeric" value="20"></div>
          </div>
          <p class="hint">Lance mínimo vazio: o bot dá o menor lance aceito pela EA. Com mínimo, dá pelo menos esse valor. Mínimo igual ao máximo = sempre aquele lance exato.</p>
          <label>Revender as cartas ganhas por</label>
          <div class="stepper"><button type="button" data-step="-" aria-label="Diminuir">−</button><input data-el="bidSell" inputmode="numeric" placeholder="vazio = não anuncia"><button type="button" data-step="+" data-from="[data-el=bidMax]" aria-label="Aumentar">+</button></div>
          <div class="hint" data-el="bidSellProfit"></div>
          <label><input type="checkbox" data-el="bidOnlySession" checked> Anunciar só as ganhas nos lances desta sessão</label>
          <label><input type="checkbox" data-el="bidAutoCollect" checked> Conferir/anunciar sozinho: a cada leilão que termina (enquanto dá lances) e, no fim, esperar os que faltam</label>
          <div class="ed-actions">
            <button class="go" data-act="bidStart">Dar lances</button>
            <button class="no" data-act="modStop">Parar</button>
            <button data-act="bidCollect">Conferir lances</button>
          </div>
          <button class="full price" data-act="bidStopList">⏹ Parar lances e anunciar as ganhas agora</button>
          <div class="result" data-el="bidResult" hidden></div>
          <div class="bidlog" data-el="bidLog" hidden></div>
          <p class="hint">"Conferir lances" olha a sua lista de observação: as cartas ganhas vão para a lista de transferências, entram no Lucro com o valor do lance e, se você preencheu "Revender as cartas ganhas por", são anunciadas por esse preço (1 hora).</p>
        </div>
      </section>
      <section data-pane="sell" hidden>
        <div class="card">
          <div class="card-h">🏷️ Venda em massa</div>
          <p class="hint">Carrega as cartas não anunciadas (ou expiradas) e agrupa as iguais. Escolha quantas vender e o preço.</p>
          <label><input type="checkbox" data-el="sellUnassigned"> Incluir "Não atribuídos"</label>
          <button class="full" data-act="sellLoad">Carregar minhas cartas</button>
          <button class="full price" data-act="sellPrices" data-el="sellPrices" hidden>💲 Buscar preço atual de todas</button>
          <p class="hint">O preço atual é o menor "compre já" anunciado agora no mercado da EA (até 20 cartas por toque; as buscas contam no limite da EA).</p>
          <div data-el="sellGroups"></div>
          <div class="ed-actions" data-el="sellActions" hidden>
            <button class="go" data-act="sellStart">Anunciar selecionadas</button>
            <button class="no" data-act="modStop">Parar</button>
          </div>
          <div class="result" data-el="sellResult" hidden></div>
        </div>
      </section>
      <section data-pane="sbc" hidden>
        <div class="card">
          <div class="card-h">📊 SBC por pontos</div>
          <p class="hint">Para os SBCs de pontos (Item Score). Informe a meta e a solução (ex.: 14 × ouro 87 + 2 × ouro 86). O bot confere os pontos,
            usa as cartas do seu clube dessas notas (fora do time e sem especiais), compra o que faltar pelo preço que você escolher e monta a entrega. O envio é seu.</p>
          <label>Meta de pontos</label>
          <input data-el="ptsTarget" inputmode="numeric" placeholder="Ex.: 85000">
          <div data-el="ptsLines"></div>
          <button class="full" data-act="ptsAddLine">+ Adicionar nota</button>
          <div class="result" data-el="ptsCheck"></div>
          <button class="full" data-act="ptsRead">📖 Ler o SBC aberto no Web App</button>
          <button class="full" data-act="ptsClub">🏠 Procurar no meu clube</button>
          <div data-el="ptsPlan"></div>
          <p class="hint">Carta desmarcada fica protegida: não entra nas próximas buscas. <button type="button" data-act="ptsUnprotect">Desproteger todas</button></p>
          <div class="ed-actions">
            <button class="go" data-act="ptsBuy">🛒 Comprar o que falta</button>
            <button class="no" data-act="sbcStop">Parar</button>
          </div>
          <div class="result" data-el="ptsStatus" hidden></div>
          <button class="full price" data-act="ptsAssemble">🧩 Montar entrega no SBC</button>
          <div class="bidlog" data-el="ptsLog" hidden></div>
        </div>
        <div class="card">
          <div class="card-h">🧩 SBC pela solução do FUTBIN</div>
          <p class="hint">1) No Safari, abra no FUTBIN a solução mais barata do SBC e toque no selo verde até aparecerem os preços (são de console).
            2) Toque em <b>🧩 Enviar ao bot</b>. 3) Volte aqui e toque em <b>Colar solução</b>. 4) Confira quanto pagar por cada um e toque em <b>Comprar os marcados</b> (as compras acontecem aqui mesmo, sem mexer no Sniper). 5) Abra o desafio no Web App e toque em <b>Montar elenco</b>.</p>
          <button class="full price" data-act="sbcPaste">📋 Colar solução do FUTBIN</button>
          <textarea data-el="sbcCode" rows="2" placeholder="Se não colar sozinho: toque e segure aqui → Colar"></textarea>
          <button class="full" data-act="sbcImport">Importar código colado</button>
          <div data-el="sbcList"></div>
          <div data-el="sbcActions" hidden>
            <p class="hint" data-el="sbcTotal"></p>
            <button class="full" data-act="sbcClub">🏠 Conferir no clube</button>
            <button class="full price" data-act="sbcPrices">💲 Preço atual dos marcados</button>
            <button class="full" data-act="sbcUseNow">Usar o preço atual como "pagar até"</button>
            <div class="ed-actions">
              <button class="go" data-act="sbcBuy">🛒 Comprar os marcados</button>
              <button class="no" data-act="sbcStop">Parar</button>
            </div>
            <div class="result" data-el="sbcStatusBox" hidden></div>
            <button class="full price" data-act="sbcAssemble">🧩 Montar elenco no SBC</button>
            <p class="hint">Montar elenco: abra o desafio no Web App (a tela do elenco do SBC) e toque aqui. O bot coloca as cartas compradas e as que você já tem nas vagas e salva. Confira e envie você mesmo.</p>
            <div class="bidlog" data-el="sbcLog" hidden></div>
          </div>
          <button class="full" data-act="sbcLegacy" data-el="sbcLegacy" hidden>Tirar do Sniper os alvos de SBC antigos</button>
          <button class="full" data-act="sbcResume" data-el="sbcResume" hidden>Reativar meus alvos pausados</button>
        </div>
      </section>
      <section data-pane="profit" hidden>
        <div class="card">
          <div class="card-h">💰 Lucro</div>
          <div class="ed-h">Período</div>
          <div class="chips" data-el="periodChips"></div>
          <div class="grid" data-el="periodCustom" hidden>
            <div><label>De</label><input type="date" data-el="periodFrom"></div>
            <div><label>Até</label><input type="date" data-el="periodTo"></div>
          </div>
          <div data-el="profitKpis"></div>
          <div data-el="profitDays"></div>
          <div class="ed-actions">
            <button class="go" data-act="profitSync">Atualizar com a lista de transferências</button>
            <button data-act="profitClear">Limpar registro</button>
          </div>
          <p class="hint">Compras do bot entram sozinhas. Compras antigas entram pelo "Item bought for" quando a carta está na lista de transferências ou em Não atribuídos. Sempre que você abre a lista de transferências no Web App, o registro é atualizado, inclusive as vendidas, antes de "Limpar vendidos". Lucro = venda − 5% da EA − preço pago.</p>
          <div class="rows" data-el="profitRows"></div>
        </div>
      </section>
    `;

    doc.body.appendChild(dock);
    doc.body.appendChild(panel);

    function placeDock(pos) {
      if (!pos) {
        dock.style.left = dock.style.top = dock.style.right = dock.style.bottom = '';
        return;
      }
      const r = dock.getBoundingClientRect();
      const p = clampDock(pos, { w: r.width, h: r.height }, { w: win.innerWidth, h: win.innerHeight });
      dock.style.left = p.x + 'px';
      dock.style.top = p.y + 'px';
      dock.style.right = dock.style.bottom = 'auto';
    }

    // Toque rápido = botão normal; arrastar mais de 8 px = mover os botões.
    let drag = null;
    let ignoreClickUntil = 0;
    dock.addEventListener('pointerdown', (e) => {
      const r = dock.getBoundingClientRect();
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: r.left, y: r.top, moved: false };
    });
    dock.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        drag.moved = true;
        dock.classList.add('dragging');
        try { dock.setPointerCapture(e.pointerId); } catch (err) { /* sem captura */ }
      }
      e.preventDefault();
      placeDock({ x: drag.x + dx, y: drag.y + dy });
    });
    function endDrag() {
      if (!drag) return;
      if (drag.moved) {
        const r = dock.getBoundingClientRect();
        app.state.settings.dock = { x: Math.round(r.left), y: Math.round(r.top) };
        save();
        dock.classList.remove('dragging');
        ignoreClickUntil = Date.now() + 400;
      }
      drag = null;
    }
    dock.addEventListener('pointerup', endDrag);
    dock.addEventListener('pointercancel', endDrag);
    dock.addEventListener('click', (e) => {
      if (Date.now() < ignoreClickUntil) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    win.addEventListener('resize', () => placeDock(app.state.settings.dock));
    placeDock(app.state.settings.dock);

    const el = (name) => panel.querySelector('[data-el="' + name + '"]');

    function save() {
      store.save(app.state);
    }

    function renderTabs() {
      panel.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
      panel.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
      if (tab === 'log') renderLog();
      if (tab === 'profit') renderProfit();
      if (tab === 'bids') renderBidTargets();
      if (tab === 'sbc') { renderSbc(); renderPts(); }
    }

    function renderFutbinError() {
      const box = el('fberr');
      const c = deps.overlay && deps.overlay.counters();
      const msg = c && c.lastError;
      // O aviso vermelho saiu: o FUTBIN bloqueia quase sempre e o erro já fica no Log.
      box.hidden = true;
      if (msg && futbinOn()) box.textContent = '⚠️ FUTBIN não respondeu direito (use o botão 💲 para ver o preço atual): ' + msg + ' (' + c.priced + ' preços ok, ' + c.failed + ' falhas)';
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

    // Na tela, os alvos tentados (ou criados) mais recentemente vêm primeiro.
    // A ordem em que o bot reveza entre eles não muda.
    function targetsByRecent(list) {
      const key = (t) => Math.max(t.lastTriedAt || 0, t.createdAt || 0);
      return list.slice().sort((a, b) => key(b) - key(a));
    }

    let lastTouch = 0;
    ['touchstart', 'touchmove', 'scroll', 'keydown', 'mousedown'].forEach((ev) =>
      panel.addEventListener(ev, () => { lastTouch = Date.now(); }, { passive: true, capture: true }));

    // Limpeza da lista: só desligados/concluídos, ou todos.
    function cleanTargets(all) {
      if (engine.running) return win.alert('Pare o bot antes de limpar a lista.');
      const list = app.state.targets;
      const gone = all ? list.slice() : list.filter((t) => !t.enabled || targetDone(t));
      if (!gone.length) return win.alert(all ? 'A lista já está vazia.' : 'Nenhum alvo desligado ou concluído para limpar.');
      const msg = all
        ? 'Apagar TODOS os ' + gone.length + ' alvo(s) do Sniper? Não dá para desfazer.'
        : 'Apagar ' + gone.length + ' alvo(s) desligado(s) ou concluído(s)?\n\n' + gone.slice(0, 12).map((t) => '• ' + t.name).join('\n') +
          (gone.length > 12 ? '\n… e mais ' + (gone.length - 12) : '') + '\n\nOs ligados continuam.';
      if (!win.confirm(msg)) return;
      app.state.targets = all ? [] : list.filter((t) => !gone.includes(t));
      save();
      renderTargets();
      log(gone.length + ' alvo(s) apagado(s) da lista.', 'success');
    }

    function renderTargets() {
      const box = el('targets');
      const clean = el('targetsClean');
      if (clean) clean.style.display = app.state.targets.length ? '' : 'none';
      editors.forEach((ed, id) => { if (!app.state.targets.some((t) => t.id === id)) editors.delete(id); });
      if (!app.state.targets.length) {
        box.innerHTML = '<p class="hint">Nenhum alvo ainda. Crie um abaixo.</p>';
        return;
      }
      box.innerHTML = targetsByRecent(app.state.targets).map((t) => {
        const problem = t.needsReview
          ? 'Alvo criado numa versão antiga: confira o tipo e os filtros em ✎ e salve para poder ativar.'
          : targetProblem(t) ? 'Não pode rodar: ' + targetProblem(t) + '.' : '';
        const done = targetDone(t);
        const kindPill = t.kind === 'chemstyle' || t.kind === 'mgrleague' ? '<span class="pill pill-chem">Consumível</span>'
          : t.kind === 'player' ? '<span class="pill pill-player">Jogador</span>'
          : t.kind === 'manager' ? '<span class="pill pill-player">Técnico</span>'
          : '<span class="pill pill-none">Sem tipo</span>';
        const tags = targetParts(t, names).map((x) => '<span class="tag">' + escapeHtml(x) + '</span>').join('');
        return `
        <div class="tg card${t.enabled ? ' on' : ''}" data-id="${escapeHtml(t.id)}">
          <div class="tg-top">
            <label class="sw"><input type="checkbox" data-f="enabled" ${t.enabled ? 'checked' : ''} ${problem ? 'disabled' : ''}><span></span></label>
            <div class="tg-title"><div class="name">${escapeHtml(t.name)}</div>${kindPill}${done ? ' <span class="pill pill-done">Concluído</span>' : ''}${targetResultHtml(t)}</div>
            <button class="icon" data-f="editFilters" title="Editar filtros">✎</button>
            <button class="icon" data-f="remove" title="Excluir">🗑</button>
          </div>
          <div class="tags">${tags || '<span class="tag">sem filtros</span>'}</div>
          ${problem ? '<div class="warnbox">⚠️ ' + escapeHtml(problem) + '</div>' : ''}
          <div class="fe-box" hidden></div>
          ${t.kind === 'player' && futbinOn() ? '<div class="fb">' + futbinLine(t) + '</div>' : ''}
          <div class="grid">
            <div><label>Compra até</label><div class="stepper"><button type="button" data-step="-" aria-label="Diminuir">−</button><input data-f="maxBuy" inputmode="numeric" value="${t.maxBuy}"><button type="button" data-step="+" aria-label="Aumentar">+</button></div></div>
            <div><label>Revende por</label><div class="stepper"><button type="button" data-step="-" aria-label="Diminuir">−</button><input data-f="sellPrice" inputmode="numeric" value="${t.sellPrice || ''}"><button type="button" data-step="+" data-from="[data-f=maxBuy]" aria-label="Aumentar">+</button></div></div>
            <div><label>Buscar a partir de</label><div class="stepper"><button type="button" data-step="-" aria-label="Diminuir">−</button><input data-f="minPrice" inputmode="numeric" placeholder="qualquer" value="${t.minPrice > 0 ? t.minPrice : ''}"><button type="button" data-step="+" aria-label="Aumentar">+</button></div></div>
            <div><label>Quantidade</label><input data-f="maxCount" inputmode="numeric" placeholder="sem limite" value="${t.maxCount > 0 ? t.maxCount : ''}"></div>
            <div class="count"><label>Progresso</label><div><b>${escapeHtml(countLabel(t))}</b>${t.bought ? ' <button data-f="resetCount">Zerar</button>' : ''}</div></div>
          </div>
          <div class="hint profit-line" data-el-profit>${targetProfitHtml(t.maxBuy, t.sellPrice)}</div>
        </div>`;
      }).join('');
    }

    // Editor de filtros (usado no "Novo alvo" e em cada alvo). Tudo por nome:
    // botões para tipo, posição, nível, química e PlayStyles; busca por nome
    // para jogador, time, liga e país.
    const PICKERS = [['player', 'Jogador', 'Buscar jogador pelo nome…'], ['club', 'Time', 'Buscar time…'],
      ['league', 'Liga', 'Buscar liga…'], ['nation', 'País', 'Buscar país…']];

    function createEditor(host) {
      let st = null;

      function load(kind, c, t, labels) {
        c = c || {};
        t = t || {};
        const style = c.playStyle > 0 ? c.playStyle : 0;
        st = {
          kind: kind || null,
          base: Object.assign({}, c),
          player: c.maskedDefId || 0,
          position: readPositionFilter(c).position,
          zone: readPositionFilter(c).position ? '' : (readPositionFilter(c).zone || (isEmptyValue(c.zone) ? '' : c.zone)),
          chem: kind === 'chemstyle' ? 0 : style,
          consumable: kind === 'player' ? 0 : style,
          level: c.level && c.level !== 'any' ? c.level : '',
          club: c.club > 0 ? c.club : 0,
          league: c.league > 0 ? c.league : 0,
          nation: c.nation > 0 ? c.nation : 0,
          labels: Object.assign({}, t.labels || {}, labels || {}),
          minRating: t.minRating || 0,
          maxRating: t.maxRating || 0,
          playStyles: (t.playStyles || []).map((p) => ({ id: p.id, plus: !!p.plus })),
          psPlus: !!t.psPlus || hasPsPlusFilter(c, psField()),
          query: {},
        };
        render();
      }

      function label(kind) {
        return nameFor(kind, st[kind], st.labels, names);
      }

      function chip(attr, value, text, on, extra) {
        return '<button type="button" class="chip' + (on ? ' on' : '') + (extra ? ' ' + extra : '') + '" ' +
          attr + '="' + escapeHtml(value) + '">' + escapeHtml(text) + '</button>';
      }

      function section(title, body, hint) {
        return '<div class="ed-sec"><div class="ed-h">' + escapeHtml(title) + '</div>' + body +
          (hint ? '<p class="hint">' + hint + '</p>' : '') + '</div>';
      }

      function styleChips(attr, current, withAny) {
        const ids = Object.keys(chemStyles).map(Number).sort((a, b) => a - b);
        return '<div class="chips">' + (withAny ? chip(attr, '0', 'Qualquer', !current) : '') +
          ids.map((id) => chip(attr, id, chemStyles[id], current === id)).join('') + '</div>';
      }

      function picker(kind, title, placeholder) {
        if (st[kind]) {
          return section(title, '<div class="sel"><span>' + escapeHtml(label(kind)) + '</span>' +
            '<button type="button" data-ed-clear="' + kind + '">✕</button></div>');
        }
        return section(title, '<input data-ed-q="' + kind + '" placeholder="' + escapeHtml(placeholder) + '" value="' +
          escapeHtml(st.query[kind] || '') + '" autocomplete="off"><div class="results" data-ed-res="' + kind + '"></div>');
      }

      function render() {
        const short = { player: '👤 Jogador', manager: '👔 Técnico', chemstyle: '🧪 Consumível de química', mgrleague: '🏆 Liga de técnico' };
        const kindSeg = '<div class="seg">' + KINDS.map((k) => chip('data-ed-kind', k[0], short[k[0]], st.kind === k[0])).join('') + '</div>';
        let html = section('O que comprar', kindSeg);
        if (st.kind === 'chemstyle') {
          html += section('Qual estilo de química', styleChips('data-ed-cons', st.consumable, false),
            'Compra só a carta consumível. Jogadores são sempre ignorados.');
        } else if (st.kind === 'player') {
          html += PICKERS.slice(0, 1).map((p) => picker(p[0], p[1], p[2])).join('');
          const zoneOn = (z) => !st.position && zoneInfo(st.zone) === z;
          const unknownZone = st.zone && !zoneInfo(st.zone);
          html += section('Posição', '<div class="chips">' + chip('data-ed-pos', '', 'Qualquer', !st.position && !st.zone) +
            ZONES.map((z) => chip('data-ed-zone', z[0], z[1], zoneOn(z))).join('') +
            (unknownZone ? chip('data-ed-zone', st.zone, zoneLabel(st.zone), true) : '') +
            '</div><div class="chips" style="margin-top:6px">' +
            POSITIONS.map((p) => chip('data-ed-pos', p, p, st.position === p)).join('') + '</div>',
            'Grupos iguais ao filtro do Web App: Defensores, Meio-campistas e Atacantes. Ou escolha uma posição exata.');
          html += section('Química aplicada no jogador', styleChips('data-ed-chem', st.chem, true));
          html += PICKERS.slice(1).map((p) => picker(p[0], p[1], p[2])).join('');
          html += section('Nível', '<div class="chips">' + chip('data-ed-level', '', 'Qualquer', !st.level) +
            LEVELS.map((l) => chip('data-ed-level', l[0], l[1], st.level === l[0])).join('') + '</div>');
          const field = psField();
          html += section('PlayStyle', '<div class="chips">' + chip('data-ed-psplus', '0', 'Qualquer', !st.psPlus) +
            chip('data-ed-psplus', '1', 'Tem PlayStyle+', st.psPlus, st.psPlus ? 'plus' : '') + '</div>',
            field ? 'Igual ao filtro "PlayStyle" do Web App: a própria EA traz só jogadores com PlayStyle+.'
              : 'Para usar o filtro da própria EA, faça uma vez no Web App uma busca com <b>PlayStyle: PlayStyle+</b> ' +
                '(o script aprende). Até lá o bot confere carta a carta e, se não conseguir confirmar, não compra.');
          if (st.playStyles.length) {
            html += section('PlayStyles específicos (versão anterior)', '<div class="tags">' +
              st.playStyles.map((p) => '<span class="tag">' + escapeHtml(playStyleName(p.id, p.plus)) + '</span>').join('') +
              '</div><button type="button" data-ed-clearps="1">Remover estes</button>');
          }
          html += section('Nota', '<div class="grid"><div><label>Mínima</label><input data-ed-num="minRating" inputmode="numeric" value="' +
            (st.minRating || '') + '"></div><div><label>Máxima</label><input data-ed-num="maxRating" inputmode="numeric" value="' +
            (st.maxRating || '') + '"></div></div>');
        } else if (st.kind === 'mgrleague') {
          html += picker('league', 'Liga do técnico', 'Buscar liga…');
          html += '<p class="hint">Compra só o consumível de liga de técnico. Jeito mais seguro: no Web App vá em Transferências → ' +
            'Consumables → <b>Manager Leagues</b>, escolha a liga e abra o ⚡ (os filtros da tela vêm sozinhos). ' +
            'O bot confere a liga de cada carta e, se não conseguir confirmar, não compra.</p>';
        } else if (st.kind === 'manager') {
          html += section('Técnico', st.player
            ? '<div class="sel"><span>' + escapeHtml(st.labels.player || 'técnico #' + st.player) + '</span>' +
              '<button type="button" data-ed-clear="player">✕</button></div>'
            : '<p class="hint">Qualquer técnico. Para um técnico específico: no Web App vá em Transferências → Managers, ' +
              'digite o nome, faça a busca e depois toque em <b>Usar última busca</b>.</p>');
          html += section('Nível', '<div class="chips">' + chip('data-ed-level', '', 'Qualquer', !st.level) +
            LEVELS.filter((l) => l[0] !== 'SP').map((l) => chip('data-ed-level', l[0], l[1], st.level === l[0])).join('') + '</div>');
          html += PICKERS.filter((p) => p[0] === 'nation' || p[0] === 'league').map((p) => picker(p[0], p[1], p[2])).join('');
          html += '<p class="hint">Compra só técnicos. Jogadores e consumíveis são sempre ignorados.</p>';
        } else {
          html += '<p class="hint">Escolha acima se o alvo é um jogador, um técnico ou um consumível.</p>';
        }
        host.innerHTML = '<div class="ed">' + html + '</div>';
        PICKERS.forEach((p) => { if (st.query[p[0]]) updateResults(p[0]); });
      }

      function updateResults(kind) {
        const box = host.querySelector('[data-ed-res="' + kind + '"]');
        if (!box) return;
        const q = st.query[kind] || '';
        if (normalizeName(q).length < 2) { box.innerHTML = ''; return; }
        const show = (list, emptyMsg) => {
          if (st.query[kind] !== q) return;
          box.innerHTML = list.length
            ? list.map((x) => '<button type="button" data-ed-pick="' + kind + '" data-id="' + x.id + '" data-name="' +
              escapeHtml(x.name) + '">' + escapeHtml(x.name) + (x.rating ? ' <small>' + x.rating + '</small>' : '') + '</button>').join('')
            : '<div class="hint">' + emptyMsg + '</div>';
        };
        box.innerHTML = '<div class="hint">Procurando…</div>';
        const unavailable = kind === 'player'
          ? 'Lista de jogadores do Web App indisponível. Pesquise o jogador no mercado do Web App que ele aparece aqui.'
          : 'Nomes indisponíveis. Escolha pelo nome na busca do Web App que ele aparece aqui.';
        const source = kind === 'player' ? players.search(q) : names.list(kind).then((list) => ({ ok: list.length > 0, list: searchByName(list, q, 15) }));
        source.then((r) => show(r.ok ? r.list : [], r.ok ? 'Nada encontrado.' : unavailable))
          .catch(() => show([], unavailable));
      }

      host.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b || !st) return;
        const d = b.dataset;
        if (d.edKind) { st.kind = d.edKind; }
        else if (d.edPos != null) { st.position = d.edPos; st.zone = ''; }
        else if (d.edZone != null) { st.zone = d.edZone; st.position = ''; }
        else if (d.edLevel != null) { st.level = d.edLevel; }
        else if (d.edChem != null) { st.chem = parseInt(d.edChem, 10) || 0; }
        else if (d.edCons != null) { st.consumable = parseInt(d.edCons, 10) || 0; }
        else if (d.edPs != null) {
          const id = parseInt(d.edPs, 10);
          const cur = st.playStyles.find((p) => p.id === id);
          if (!cur) st.playStyles.push({ id, plus: false });
          else if (!cur.plus) cur.plus = true;
          else st.playStyles = st.playStyles.filter((p) => p.id !== id);
        }
        else if (d.edPsplus != null) { st.psPlus = d.edPsplus === '1'; }
        else if (d.edClearps) { st.playStyles = []; }
        else if (d.edClear) { st[d.edClear] = 0; delete st.labels[d.edClear]; }
        else if (d.edPick) {
          st[d.edPick] = parseInt(d.id, 10);
          st.labels[d.edPick] = d.name;
          st.query[d.edPick] = '';
        }
        else return;
        e.preventDefault();
        render();
      });

      host.addEventListener('input', (e) => {
        if (!st) return;
        const q = e.target.dataset.edQ;
        if (q) { st.query[q] = e.target.value; updateResults(q); return; }
        const n = e.target.dataset.edNum;
        if (n) st[n] = parseCoins(e.target.value);
      });

      return {
        load,
        setLabel(kind, text) { if (st && text) { st.labels[kind] = text; render(); } },
        value() {
          const kind = st.kind;
          const values = kind === 'chemstyle' ? { playStyle: st.consumable }
            : kind === 'mgrleague' ? { league: st.league }
            : kind === 'manager' ? { level: st.level || 'any', league: st.league, nation: st.nation }
            : { position: st.position || 'any', zone: st.position ? 'any' : (st.zone || 'any'), playStyle: st.chem || 0, level: st.level || 'any', club: st.club, league: st.league, nation: st.nation };
          let criteria = kind ? criteriaForKind(kind, st.base, values) : Object.assign({}, st.base);
          const field = psField();
          criteria = applyPsPlus(criteria, kind === 'player' && st.psPlus, field);
          const labels = {};
          if (kind === 'player') {
            if (st.player) criteria.maskedDefId = st.player;
            else delete criteria.maskedDefId;
            if (st.player !== (st.base.maskedDefId || 0)) delete criteria.defId;
            ['player', 'club', 'league', 'nation'].forEach((k) => { if (st[k] && st.labels[k]) labels[k] = st.labels[k]; });
          }
          if (kind === 'mgrleague') {
            if (st.league) criteria.league = st.league;
            else delete criteria.league;
            if (st.league && st.labels.league) labels.league = st.labels.league;
          }
          if (kind === 'manager') {
            if (st.player) criteria.maskedDefId = st.player;
            else delete criteria.maskedDefId;
            ['player', 'league', 'nation'].forEach((k) => { if (st[k] && st.labels[k]) labels[k] = st.labels[k]; });
          }
          return {
            kind,
            criteria,
            labels,
            minRating: kind === 'player' ? st.minRating || 0 : 0,
            maxRating: kind === 'player' ? st.maxRating || 0 : 0,
            playStyles: kind === 'player' ? st.playStyles.map((p) => ({ id: p.id, plus: p.plus })) : [],
            psPlus: kind === 'player' && st.psPlus,
            psPlusServer: kind === 'player' && st.psPlus && hasPsPlusFilter(criteria, field),
          };
        },
      };
    }

    function psField() {
      return app.state.settings.psPlusField || null;
    }

    const editors = new Map();
    const newEditor = createEditor(el('newFilters'));

    function renderNewFilters() {
      newEditor.load(kindFromCriteria(app.captured), app.captured, null, app.capturedLabels);
    }

    // Lucro já obtido com as cartas deste alvo (registro da aba Lucro).
    function targetResultHtml(t) {
      const r = targetLedgerStats(t, app.state.ledger);
      if (!r.sold && !r.open && !r.unknown) return '';
      const parts = [];
      if (r.sold) parts.push(r.sold + ' vendida(s)');
      if (r.open) parts.push(r.open + ' aguardando venda');
      if (r.unknown) parts.push(r.unknown + ' sem preço pago');
      return '<div class="tg-result">Lucro: ' + money(r.profit) + ' <span>· ' + parts.join(' · ') + '</span></div>';
    }

    // Lucro por carta se comprar pelo "Compra até" e vender pelo "Revende por".
    function targetProfitHtml(buy, sell) {
      if (!(sell > 0)) return 'Lucro: preencha "Revende por" para ver.';
      if (!(buy > 0)) return '';
      const profit = netAfterTax(sell) - buy;
      return 'Lucro por carta: ' + money(profit) + ' <span>(vende ' + fmt(sell) + ' − 5% EA = ' + fmt(netAfterTax(sell)) + ' − compra ' + fmt(buy) + ')</span>';
    }

    function updateTargetProfit(card) {
      const box = card && card.querySelector('[data-el-profit]');
      if (!box) return;
      const buy = parseCoins(card.querySelector('[data-f=maxBuy]').value);
      const sell = parseCoins(card.querySelector('[data-f=sellPrice]').value);
      box.innerHTML = targetProfitHtml(buy, sell);
    }

    function futbinOn() {
      return app.state.settings.priceSource === 'futbin';
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
      if (!futbinOn()) return;
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
        '<option value="market"' + (app.state.settings.priceSource !== 'futbin' ? ' selected' : '') + '>Preço atual do mercado (botão 💲)</option>' +
        '<option value="futbin"' + (app.state.settings.priceSource === 'futbin' ? ' selected' : '') + '>FUTBIN (costuma ser bloqueado)</option></select>' +
        SETTING_FIELDS.map(([key, label]) =>
        '<label>' + label + '</label><input data-setting="' + key + '" inputmode="decimal" value="' + app.state.settings[key] + '">'
      ).join('');
    }

    function renderLog() {
      el('log').innerHTML = logs.slice(0, 80).map((l) =>
        '<div class="' + l.level + '">' + l.time + ' ' + escapeHtml(l.msg) + '</div>'
      ).join('') || '<div>Nada ainda.</div>';
    }

    // ---------- Módulos: lucro, lances e venda ----------
    let modBusy = '';
    let modStop = false;
    let sellGroups = [];

    function ledger() {
      if (!app.state.ledger) app.state.ledger = {};
      return app.state.ledger;
    }

    // Botão 💲: consulta, uma a uma, o menor "compre já" das cartas na tela
    // (ou das informadas) e vai mostrando o preço em cada carta.
    const PRICE_CHECK_LIMIT = 20;
    // opts.onUpdate(card) é chamado sempre que o preço de uma carta muda;
    // opts.progress(texto) mostra o andamento em outro botão.
    async function checkPrices(cards, opts) {
      opts = opts || {};
      const onUpdate = opts.onUpdate || (() => {});
      const progress = opts.progress || (() => {});
      if (engine.running || modBusy) { win.alert('Pare o bot/módulo antes de consultar preços.'); return; }
      const market = deps.market;
      const list = (cards || deps.overlay.visibleCards()).filter((c) => c && c.definitionId > 0 && !(market.get(c.definitionId) || {}).price);
      if (!list.length) {
        if (!opts.quiet) win.alert(cards ? 'Preço já consultado há pouco.' : 'Nenhuma carta de jogador na tela (ou os preços já foram consultados há pouco).');
        return;
      }
      const todo = list.slice(0, PRICE_CHECK_LIMIT);
      modBusy = 'preços';
      modStop = false;
      priceBtn.classList.add('busy');
      log('Consultando o preço atual de ' + todo.length + ' carta(s)' + (list.length > todo.length ? ' (máximo ' + PRICE_CHECK_LIMIT + ' por vez)' : '') + '…');
      let done = 0;
      try {
        for (const card of todo) {
          if (modStop) break;
          priceBtn.textContent = (done + 1) + '/' + todo.length;
          progress((done + 1) + '/' + todo.length);
          market.set(card.definitionId, { state: 'checking' });
          deps.overlay.refresh(card.definitionId);
          onUpdate(card);
          try {
            const r = await lowestBin({ adapter, card });
            market.set(card.definitionId, { price: r.price || 0 });
            log((card.name || 'Carta') + ' ' + (card.rating || '') + ': ' + (r.price ? 'menor compre já agora ' + fmt(r.price) : 'nenhum anúncio de compre já') +
              ' (' + r.searches + ' busca(s)).', r.price ? 'success' : 'warn');
          } catch (err) {
            market.delete(card.definitionId);
            deps.overlay.refresh(card.definitionId);
            log('Consulta de preço parada: ' + err.message, 'error');
            if (err.fatal) break;
          }
          deps.overlay.refresh(card.definitionId);
          onUpdate(card);
          done++;
          if (done < todo.length && !modStop) await sleepMs(randomBetween(800, 1600, Math.random));
        }
      } finally {
        modBusy = '';
        priceBtn.classList.remove('busy');
        priceBtn.textContent = '💲';
        progress('');
      }
    }

    priceBtn.addEventListener('click', () => {
      if (modBusy === 'preços') { modStop = true; log('Parando a consulta de preços…', 'warn'); return; }
      checkPrices(null);
    });

    function money(n) {
      return '<b class="' + (n > 0 ? 'pos' : n < 0 ? 'neg' : '') + '">' + (n > 0 ? '+' : '') + fmt(n) + '</b>';
    }

    const PERIODS = [['today', 'Hoje'], ['7d', '7 dias'], ['30d', '30 dias'], ['month', 'Este mês'], ['lastMonth', 'Mês passado'],
      ['all', 'Tudo'], ['custom', 'Escolher datas']];
    let periodName = 'all';

    function currentPeriod() {
      if (periodName !== 'custom') return presetPeriod(periodName);
      const from = dayRange(el('periodFrom').value);
      const to = dayRange(el('periodTo').value);
      if (!from && !to) return null;
      return { from: from ? from.from : 0, to: to ? to.to : 0 };
    }

    function periodLabel(period) {
      if (!period) return 'todo o período';
      const f = (ts) => new Date(ts).toLocaleDateString('pt-BR');
      return (period.from ? f(period.from) : 'início') + ' a ' + (period.to ? f(period.to) : 'hoje');
    }

    function renderProfit() {
      el('periodChips').innerHTML = PERIODS.map((p) =>
        '<button type="button" class="chip' + (periodName === p[0] ? ' on' : '') + '" data-period="' + p[0] + '">' + p[1] + '</button>').join('');
      el('periodCustom').hidden = periodName !== 'custom';
      const period = currentPeriod();
      const sum = ledgerSummary(ledger(), period);
      el('profitKpis').innerHTML = '<p class="captured">Período: <b>' + escapeHtml(periodLabel(period)) + '</b></p><div class="kpis">' +
        '<div class="kpi"><span>Lucro no período</span>' + money(sum.profit) + '</div>' +
        '<div class="kpi"><span>Cartas vendidas</span><b>' + fmt(sum.soldCount) + '</b></div>' +
        '<div class="kpi"><span>Recebido (sem os 5%)</span><b>' + fmt(sum.revenue) + '</b></div>' +
        '<div class="kpi"><span>Custo das vendidas</span><b>' + fmt(sum.soldCost) + '</b></div>' +
        (period ? '<div class="kpi"><span>Compradas no período</span><b>' + fmt(sum.boughtCount) + '</b></div>' +
          '<div class="kpi"><span>Gasto em compras</span><b>' + fmt(sum.boughtCost) + '</b></div>' : '') +
        '<div class="kpi"><span>Em estoque agora</span><b>' + fmt(sum.openCount) + '</b></div>' +
        '<div class="kpi"><span>Investido no estoque</span><b>' + fmt(sum.openCost) + '</b></div>' +
        '</div>' + (sum.unknownCost ? '<p class="hint">' + sum.unknownCost + ' carta(s) sem preço de compra conhecido não entram no cálculo.</p>' : '') +
        '<p class="hint">A data da venda é quando o script viu a carta como vendida (ao abrir a lista de transferências).</p>';
      const days = dailyProfit(ledger(), period);
      el('profitDays').innerHTML = days.length > 1
        ? '<div class="ed-h">Por dia</div><div class="rows">' + days.map((d) => {
          const r = dayRange(d.day);
          return '<div class="r"><div>' + new Date(r.from).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }) +
            ' · ' + d.count + ' venda(s)</div><div>' + money(d.profit) + '</div></div>';
        }).join('') + '</div>'
        : '';
      const entries = Object.values(ledger())
        .filter((e) => !period || inPeriod(e.status === 'vendida' ? e.soldAt : e.boughtAt, period))
        .sort((a, b) => (b.soldAt || b.boughtAt || 0) - (a.soldAt || a.boughtAt || 0)).slice(0, 80);
      el('profitRows').innerHTML = entries.map((e) => {
        const p = entryProfit(e);
        const detail = e.status === 'vendida'
          ? 'pago ' + (e.cost ? fmt(e.cost) : '?') + ' → vendida ' + fmt(e.soldFor)
          : 'pago ' + (e.cost ? fmt(e.cost) : '?') + ' · ' + e.status + (e.listedFor ? ' (' + fmt(e.listedFor) + ')' : '');
        const key = ledgerKey(e.itemId);
        const toggle = e.source === 'bot' ? ''
          : '<br><button type="button" data-ledger-toggle="' + escapeHtml(key) + '">' + (e.ignored ? 'Contar no lucro' : 'Não contar') + '</button>';
        return '<div class="r' + (e.ignored ? ' ignored' : '') + '"><div>' + escapeHtml((e.name || 'carta') + (e.rating ? ' ' + e.rating : '')) +
          '<br><small style="color:#9aa3b2">' + escapeHtml(detail + ' · ' + new Date(e.status === 'vendida' ? e.soldAt : e.boughtAt).toLocaleDateString('pt-BR')) +
          (e.ignored ? ' · não conta: veio do seu clube' : '') + '</small>' + toggle + '</div><div>' + (p == null || e.ignored ? '' : money(p)) + '</div></div>';
      }).join('') || '<p class="hint">Nada registrado ' + (period ? 'neste período' : 'ainda') + '.</p>';
    }

    // Lê uma pilha: primeiro pela função do Web App; se não der, usa o que o
    // Web App carregou quando você abriu a tela. Liga cada carta ao objeto
    // que o Web App desenhou (necessário para anunciar).
    let lastPileMethod = '';

    // Fontes, na ordem: função do Web App, depósito interno, dados que o Web
    // App recebeu ao abrir a tela, e cartas que já apareceram na tela.
    async function readPile(which) {
      const r = await adapter.pile(which, deps.lookup);
      const cap = deps.piles && deps.piles[which];
      let items = null;
      let source = null;
      if (r.success && r.items.length) { items = r.items; source = 'função ' + r.method; }
      if (!items) {
        const repo = adapter.repositoryPile(which, deps.lookup);
        if (repo && repo.length) { items = repo; source = 'depósito do Web App'; }
      }
      if (!items && cap && cap.items.length) { items = cap.items; source = 'captura'; }
      if (!items && deps.entities && deps.entities.size) {
        const pileId = adapter.pileId(which);
        const seen = Array.from(deps.entities.values()).map(adapter.toItem).filter((it) => it.id > 0 && it.pile === pileId);
        if (seen.length) { items = seen; source = 'cartas vistas na tela'; }
      }
      if (!items && deps.entities && deps.entities.screens) {
        const re = { transfer: /transfer list|lista de transfer/i, unassigned: /unassigned|não atribu|nao atribu/i, watch: /transfer targets|observa|alvos/i }[which];
        const seen = Array.from(deps.entities.entries())
          .filter(([id]) => re.test(deps.entities.screens.get(id) || ''))
          .map(([, e]) => adapter.toItem(e)).filter((it) => it.id > 0);
        if (seen.length) { items = seen; source = 'cartas vistas na tela "' + deps.entities.screens.get(seen[0].id) + '"'; }
      }
      if (!items && r.success) {
        log('Diagnóstico da lista: a função ' + r.method + ' respondeu sem cartas reconhecíveis. Forma da resposta: ' + (r.shape || '?'), 'warn');
        items = [];
        source = 'função ' + r.method;
      }
      lastPileMethod = source || '';
      if (!items) {
        const why = r.missing ? 'função não encontrada' : r.timeout ? 'o Web App não respondeu' : 'erro ' + r.status;
        return { ok: false, why };
      }
      items = items.map((it) => {
        if (it.raw || !deps.entities) return it;
        const entity = deps.entities.get(it.id) || null;
        if (!entity) return it;
        const better = deps.lookup && deps.lookup.entityName ? deps.lookup.entityName(entity) : null;
        return Object.assign({}, it, { raw: entity, name: better && !/^\d+$/.test(better) ? better : it.name });
      });
      return { ok: true, items, source, at: cap && source === 'captura' ? cap.at : Date.now() };
    }

    const PILE_NAMES = { transfer: 'Lista de transferências', unassigned: 'Não atribuídos', watch: 'Lista de observação' };

    function pileHelp(which) {
      return 'Abra no Web App: <b>Transferências → ' + PILE_NAMES[which] + '</b>, espere carregar e volte aqui.';
    }

    function applySync(items, quiet, pile) {
      const ch = syncLedger(ledger(), items, Date.now(), pile || 'transfer', app.state.bids);
      ch.sold.forEach((e) => {
        const p = e.ignored ? null : entryProfit(e);
        log('Vendida: ' + e.name + ' por ' + fmt(e.soldFor) + (p == null ? '' : ' · lucro ' + (p > 0 ? '+' : '') + fmt(p) + ' (já sem os 5% da EA)'), 'success');
      });
      save();
      if (tab === 'profit' && !panel.hidden) renderProfit();
      if (!quiet) log('Lucro atualizado: ' + items.length + ' carta(s) lidas, ' + ch.added + ' nova(s), ' + ch.sold.length + ' venda(s).', 'success');
    }

    async function syncProfit() {
      if (modBusy || engine.running) return win.alert('Espere o bot/módulo terminar.');
      modBusy = 'lucro';
      try {
        for (const which of ['transfer', 'unassigned']) {
          const r = await readPile(which);
          if (r.ok) {
            applySync(r.items, false, which);
            if (r.source === 'captura') log(PILE_NAMES[which] + ': usei a que o Web App carregou às ' + new Date(r.at).toLocaleTimeString('pt-BR') + '.', 'warn');
          } else {
            log('Não consegui ler ' + PILE_NAMES[which] + ' (' + r.why + '). Abra essa tela no Web App e toque em Atualizar de novo.', 'warn');
          }
        }
        renderProfit();
      } finally {
        modBusy = '';
      }
    }

    // Lances: alvos de jogador/consumível existentes ou a última busca do mercado.
    function bidTargets() {
      const list = app.state.targets.filter((t) => t.kind).map((t) => ({ id: t.id, label: t.name, target: t }));
      if (app.captured && kindFromCriteria(app.captured)) {
        const kind = kindFromCriteria(app.captured);
        list.unshift({
          id: '__captured',
          label: 'Última busca do mercado: ' + targetParts({ kind, criteria: app.captured, labels: app.capturedLabels }, names).join(' · '),
          target: { kind, criteria: app.captured, labels: app.capturedLabels },
        });
      }
      return list;
    }

    function renderBidTargets() {
      const sel = el('bidTarget');
      const cur = sel.value;
      const list = bidTargets();
      sel.innerHTML = list.length
        ? list.map((x) => '<option value="' + escapeHtml(x.id) + '"' + (x.id === cur ? ' selected' : '') + '>' + escapeHtml(x.label) + '</option>').join('')
        : '<option value="">Crie um alvo no Sniper ou faça uma busca no mercado</option>';
    }

    async function startBids() {
      if (modBusy || engine.running) return win.alert('Pare o sniper/módulo antes de dar lances.');
      const choice = bidTargets().find((x) => x.id === el('bidTarget').value);
      if (!choice) return win.alert('Escolha quais cartas.');
      const plan = {
        target: Object.assign({}, choice.target, { maxBuy: 999999999 }),
        maxBid: parseCoins(el('bidMax').value),
        minBid: parseCoins(el('bidMin').value),
        maxBids: parseCoins(el('bidCount').value),
        maxExpires: parseCoins(el('bidMinutes').value) * 60,
        maxSearches: parseCoins(el('bidSearches').value) || 20,
      };
      if (plan.maxBid < 150) return win.alert('Informe o lance máximo por carta (mínimo 150).');
      if (plan.minBid > 0) plan.minBid = roundDown(plan.minBid);
      if (plan.minBid > plan.maxBid) return win.alert('O lance mínimo não pode ser maior que o máximo.');
      const sellBin = parseCoins(el('bidSell').value);
      if (sellBin > 0 && netAfterTax(roundDown(sellBin)) <= plan.maxBid &&
        !win.confirm('Revendendo por ' + fmt(roundDown(sellBin)) + ', as cartas ganhas pelo lance máximo dão prejuízo (5% da EA). Continuar?')) return;
      if (!(plan.maxBids > 0)) return win.alert('Informe quantos lances dar.');
      const problem = targetProblem(Object.assign({}, plan.target, { maxBuy: 1000 }));
      if (problem) return win.alert('Não dá para usar essas cartas: ' + problem + '.');
      const total = plan.maxBid * plan.maxBids;
      const bidText = plan.minBid > 0 && plan.minBid === roundDown(plan.maxBid) ? 'de exatamente ' + fmt(plan.minBid)
        : (plan.minBid > 0 ? 'de ' + fmt(plan.minBid) + ' a ' : 'de no máximo ') + fmt(plan.maxBid);
      if (!win.confirm('Lances em massa:\n\n' + describeTarget(plan.target, names) + '\nAté ' + plan.maxBids + ' lance(s) ' +
        bidText + ' (até ' + fmt(total) + ' moedas presas)\nLeilões que terminam em até ' + (plan.maxExpires / 60) + ' min' +
        (app.state.settings.dryRun ? '\n\n(Modo simulação: nenhum lance será dado.)' : ''))) return;
      modBusy = 'lances';
      modStop = false;
      el('bidResult').hidden = false;
      el('bidResult').textContent = 'Dando lances…';
      log('Lances em massa iniciados.');
      bidListNow = false;
      const trace = bidTracer();
      app.state.bidSession = { start: Date.now(), ids: [], until: 0, pending: [] };
      save();
      trace('Começando: ' + describeTarget(plan.target, names) + '.', 'info');
      try {
        const onBid = (it, amount) => {
          if (!(it.id > 0)) return;
          app.state.bids = app.state.bids || {};
          app.state.bids[ledgerKey(it.id)] = { amount, at: Date.now(), name: it.name, targetId: plan.target && plan.target.id };
          const sess = bidSession();
          const endsAt = Date.now() + (it.expires > 0 ? it.expires : 3600) * 1000;
          sess.ids.push(ledgerKey(it.id));
          sess.until = Math.max(sess.until || 0, endsAt);
          sess.pending = (sess.pending || []).concat([{ id: ledgerKey(it.id), at: endsAt }]);
          app.state.bidSession = sess;
          save();
        };
        // Anuncia as ganhas assim que cada leilão termina, sem esperar o fim.
        let lastCollect = 0;
        const between = async () => {
          if (!el('bidAutoCollect').checked) return;
          const sess = bidSession();
          const ended = (sess.pending || []).filter((x) => Date.now() > x.at + 15000);
          if (!ended.length || Date.now() - lastCollect < 45000) return;
          lastCollect = Date.now();
          trace(ended.length + ' leilão(ões) seu(s) terminou(aram): conferindo' + (bidSellPlan() ? ' e anunciando as ganhas' : '') + '…', 'info');
          await runCollect(trace);
          sess.pending = (sess.pending || []).filter((x) => !ended.includes(x));
          app.state.bidSession = sess;
          save();
        };
        const r = await runBulkBids({ adapter, plan, settings: app.state.settings, log, trace, onBid, between, isStopped: () => modStop });
        el('bidResult').innerHTML = 'Terminado (' + escapeHtml(r.stopReason) + '): <b>' + (r.bids || r.simulated) + '</b> lance(s)' +
          (r.simulated ? ' simulados' : '') + ', ' + r.missed + ' não aceito(s), ' + r.searches + ' busca(s). Moedas comprometidas: ' + fmt(r.coinsCommitted) + '.';
        log('Lances em massa terminados: ' + r.stopReason + '.', 'warn');
        // Espera os leilões acabarem e confere/anuncia as ganhas.
        const sess = bidSession();
        if (bidListNow) {
          trace('Lances parados por você: conferindo e anunciando as cartas já ganhas (leilões ainda abertos ficam para depois).', 'info');
          modStop = false;
          await runCollect(trace);
        } else if (el('bidAutoCollect').checked && !modStop && sess.ids.length && !/captcha|sessão|limitad/i.test(r.stopReason)) {
          const until = sess.until + 20000;
          trace('Esperando os leilões acabarem (até ' + new Date(until).toLocaleTimeString('pt-BR') + ') para conferir' +
            (bidSellPlan() ? ' e anunciar' : '') + '. Toque em Parar para cancelar.', 'info');
          let lastNote = 0;
          while (!modStop && !bidListNow && Date.now() < until) {
            if (Date.now() - lastNote > 60000) {
              lastNote = Date.now();
              trace('Faltam ~' + Math.max(1, Math.ceil((until - Date.now()) / 60000)) + ' min para conferir.', 'muted');
            }
            await sleepMs(1000);
          }
          if (bidListNow) {
            modStop = false;
            trace('Anunciando agora as cartas já ganhas (leilões ainda abertos ficam para depois).', 'info');
            await runCollect(trace);
          } else if (!modStop) await runCollect(trace);
          else trace('Conferência automática cancelada.', 'warn');
        }
      } finally {
        modBusy = '';
      }
    }

    let bidListNow = false;

    // Lances desta sessão: guardados para anunciar só as cartas ganhas neles.
    function bidSession() {
      const s = app.state.bidSession;
      return s && Array.isArray(s.ids) ? s : { start: 0, ids: [], until: 0 };
    }

    function bidSellPlan() {
      const bin = parseCoins(el('bidSell').value);
      if (!(bin > 0)) return null;
      const onlyIds = el('bidOnlySession').checked ? new Set(bidSession().ids) : null;
      return { bin: roundDown(bin), duration: 3600, onlyIds };
    }

    function updateBidSellProfit() {
      const bin = parseCoins(el('bidSell').value);
      const max = parseCoins(el('bidMax').value);
      el('bidSellProfit').innerHTML = bin > 0 && max > 0 ? targetProfitHtml(max, bin).replace('Lucro por carta', 'Lucro por carta (se ganhar pelo lance máximo)') : '';
    }

    // Confere a lista de observação; usado pelo botão e ao fim dos lances.
    async function runCollect(trace) {
      el('bidResult').hidden = false;
      el('bidResult').textContent = 'Conferindo lista de observação…';
      const sell = bidSellPlan();
      if (sell && sell.onlyIds && !sell.onlyIds.size) trace('Nenhum lance desta sessão para anunciar (desmarque "só desta sessão" para anunciar todas as ganhas).', 'warn');
      const r = await collectWonBids({ adapter, ledger: ledger(), log, trace, settings: app.state.settings, sell });
      save();
      el('bidResult').innerHTML = r.error ? 'Não consegui: ' + escapeHtml(r.error)
        : 'Ganhou <b>' + r.ganhou + '</b> (movidas para a lista: ' + r.moved + ')' +
          (sell ? ' · anunciadas: <b>' + (r.listed || r.simulated) + '</b>' + (r.simulated ? ' (simulação)' : '') + (r.failed ? ', ' + r.failed + ' com erro' : '') : '') +
          ' · ganhando ' + r.ganhando + ' · superado ' + r.superado + ' · perdeu ' + r.perdeu + '.';
      if (!r.error) trace('Conferido: ganhou ' + r.ganhou + ', anunciadas ' + (r.listed || r.simulated) + '.', 'info');
      return r;
    }

    function bidTracer() {
      const lines = [];
      const box = el('bidLog');
      box.hidden = false;
      return (msg, level) => {
        lines.unshift('<div class="' + (level || 'info') + '">' + new Date().toLocaleTimeString('pt-BR') + ' ' + escapeHtml(msg) + '</div>');
        if (lines.length > 80) lines.length = 80;
        box.innerHTML = lines.join('');
      };
    }

    async function collectBids() {
      if (modBusy || engine.running) return win.alert('Espere o bot/módulo terminar.');
      modBusy = 'lances';
      try {
        await runCollect(bidTracer());
      } finally {
        modBusy = '';
      }
    }

    // ---------- SBC: solução do FUTBIN → alvos do sniper ----------
    function importSbc(text) {
      const r = decodeSbc(text);
      if (r.error) return win.alert('Não deu para importar: ' + r.error + '.');
      if (sbcEngine.running) return win.alert('Pare as compras do SBC atual antes de importar outro.');
      r.sbc.players.forEach((p) => { p.buy = true; p.max = p.price >= 200 ? p.price : 0; p.owned = ''; p.bought = false; });
      app.state.sbc = r.sbc;
      save();
      el('sbcCode').value = '';
      renderSbc();
      log('SBC importado: ' + r.sbc.name + ' (' + r.sbc.players.length + ' jogadores).', 'success');
    }

    async function pasteSbc() {
      let text = '';
      try { text = await win.navigator.clipboard.readText(); } catch (e) { text = ''; }
      if (!text || text.indexOf('FCAB-SBC1:') < 0) {
        win.alert('Não consegui ler a solução copiada. Toque e segure no campo de baixo → Colar → toque em "Importar código colado".');
        el('sbcCode').focus();
        return;
      }
      importSbc(text);
    }

    function sbcStatus(p) {
      if (p.owned) return '✅ você já tem (' + p.owned + ')';
      if (p.bought) return '✅ comprado' + (p.paid ? ' por ' + fmt(p.paid) : '');
      if (sbcEngine.running && p.buy && sbcBuying.has(p.definitionId)) return '🔎 procurando até ' + fmt(p.max);
      return '';
    }

    function sbcRowHtml(p, i) {
      const m = deps.market && deps.market.get(p.definitionId);
      const now = m && m.state === 'checking' ? 'Agora …' : m && m.price > 0 ? 'Agora ' + fmt(m.price) : m ? 'Agora: sem anúncio' : '';
      const info = [p.price ? 'FUTBIN ' + fmt(p.price) : 'FUTBIN sem preço', now, sbcStatus(p)].filter(Boolean).join(' · ');
      return '<div class="sbc-row" data-i="' + i + '">' +
        '<input type="checkbox" data-sbc="buy"' + (p.buy ? ' checked' : '') + '>' +
        '<div><b>' + escapeHtml(p.name) + '</b> ' + (p.rating || '') + ' <span class="hint">' + escapeHtml(p.position) + '</span>' +
        '<div class="hint">' + escapeHtml(info) + '</div></div>' +
        '<input data-sbc="max" inputmode="numeric" placeholder="até" value="' + (p.max > 0 ? p.max : '') + '">' +
        '</div>';
    }

    function renderSbc() {
      const s = app.state.sbc;
      el('sbcActions').hidden = !s;
      el('sbcResume').hidden = !app.state.targets.some((t) => t.pausedForSbc);
      el('sbcLegacy').hidden = !app.state.targets.some((t) => t.sbc);
      if (!s) {
        el('sbcList').innerHTML = '<p class="hint">Nenhuma solução importada ainda.</p>';
        return;
      }
      el('sbcList').innerHTML = '<p class="captured"><b>' + escapeHtml(s.name) + '</b> · ' + s.players.length + ' jogadores · importado em ' +
        new Date(s.at).toLocaleString('pt-BR') + '</p>' +
        '<div class="sbc-row sbc-head"><span>Comprar</span><span>Jogador</span><span>Pagar até</span></div>' +
        s.players.map(sbcRowHtml).join('');
      renderSbcTotal();
    }

    function renderSbcTotal() {
      const s = app.state.sbc;
      if (!s) return;
      const buy = s.players.filter((p) => p.buy);
      const total = buy.reduce((n, p) => n + (p.max || 0), 0);
      const missing = buy.filter((p) => !(p.max >= 200)).length;
      el('sbcTotal').innerHTML = buy.length + ' para comprar · até <b>' + fmt(total) + '</b> moedas' +
        (missing ? ' · <span class="neg">' + missing + ' sem preço máximo (mínimo 200)</span>' : '');
    }

    function onSbcInput(e) {
      const row = e.target.closest('.sbc-row');
      const s = app.state.sbc;
      if (!row || !s || !e.target.dataset.sbc) return;
      const p = s.players[parseInt(row.dataset.i, 10)];
      if (!p) return;
      if (e.target.dataset.sbc === 'buy') p.buy = e.target.checked;
      if (e.target.dataset.sbc === 'max') p.max = parseCoins(e.target.value);
      save();
      renderSbcTotal();
    }

    async function sbcCheckClub(btn) {
      const s = app.state.sbc;
      if (!s) return;
      if (modBusy || engine.running) return win.alert('Pare o bot/módulo antes de conferir o clube.');
      modBusy = 'sbc';
      btn.disabled = true;
      btn.textContent = 'Conferindo…';
      try {
        const ids = s.players.map((p) => p.definitionId);
        const found = new Map();
        let club;
        try { club = await adapter.clubOwned(ids, deps.lookup); } catch (e) { club = { success: false, status: e.message, owned: new Set() }; }
        club.owned.forEach((id) => found.set(id, 'no clube'));
        for (const w of ['unassigned', 'transfer']) {
          let r = null;
          try { r = await readPile(w); } catch (e) { r = null; }
          if (!r || !r.ok) continue;
          r.items.forEach((it) => {
            if (ids.includes(it.definitionId) && !found.has(it.definitionId)) found.set(it.definitionId, w === 'unassigned' ? 'em Não atribuídos' : 'na lista de transferências');
          });
        }
        s.players.forEach((p) => {
          p.owned = found.get(p.definitionId) || '';
          if (p.owned) p.buy = false;
        });
        save();
        renderSbc();
        log('SBC: você já tem ' + found.size + ' de ' + ids.length + ' jogador(es)' + (club.success ? '.' :
          '. Não deu para ler o clube (' + (club.missing ? 'função não encontrada' : club.status) + '); conferi só Não atribuídos e a lista de transferências.'),
        club.success ? 'success' : 'warn');
      } finally {
        modBusy = '';
        btn.disabled = false;
        btn.textContent = '🏠 Conferir no clube';
      }
    }

    function sbcPrices(btn) {
      if (modBusy === 'preços') { modStop = true; log('Parando a consulta de preços…', 'warn'); return; }
      const s = app.state.sbc;
      if (!s) return;
      const cards = s.players.filter((p) => p.buy).map((p) => ({ name: p.name, definitionId: p.definitionId, rating: p.rating }));
      if (!cards.length) return win.alert('Marque pelo menos um jogador.');
      const label = btn.textContent;
      checkPrices(cards, {
        quiet: cards.length > 1,
        onUpdate: renderSbc,
        progress: (t) => { btn.textContent = t ? 'Consultando ' + t + ' (toque para parar)' : label; },
      }).then(renderSbc);
    }

    function sbcUseNow() {
      const s = app.state.sbc;
      if (!s) return;
      let n = 0;
      s.players.forEach((p) => {
        const m = deps.market && deps.market.get(p.definitionId);
        if (p.buy && m && m.price > 0) { p.max = m.price; n++; }
      });
      save();
      renderSbc();
      if (!n) win.alert('Nenhum preço atual consultado ainda. Toque em "💲 Preço atual dos marcados" antes.');
    }

    // Compras do SBC: um bot só do módulo, com os jogadores da solução.
    // Nada vai para o Sniper.
    let sbcTraceLines = [];
    function sbcTrace(msg, level) {
      const box = el('sbcLog');
      box.hidden = false;
      sbcTraceLines.unshift('<div class="' + (level || 'info') + '">' + new Date().toLocaleTimeString('pt-BR') + ' ' + escapeHtml(msg) + '</div>');
      if (sbcTraceLines.length > 80) sbcTraceLines.length = 80;
      box.innerHTML = sbcTraceLines.join('');
    }

    let sbcTargets = [];
    const sbcBuying = new Set();
    const sbcEngine = new Autobuyer({
      adapter,
      getState: () => ({ settings: Object.assign({}, app.state.settings, { maxBuys: 0, budget: 0 }), targets: sbcTargets }),
      log: (m, l) => { sbcTrace(m, l); log('SBC: ' + m, l); },
      onPurchase: (pu) => {
        if (pu.targetId && String(pu.targetId).indexOf('pts-') === 0) {
          const st = ptsState();
          const r = parseInt(String(pu.targetId).slice(4), 10);
          st.bought = st.bought || {};
          (st.bought[r] = st.bought[r] || []).push({ itemId: pu.itemId, paid: pu.price, name: pu.name });
          save();
          renderPts();
          return;
        }
        const s = app.state.sbc;
        const p = s && s.players.find((x) => x.definitionId === pu.definitionId && !x.bought);
        if (p) {
          p.bought = true;
          p.itemId = pu.itemId;
          p.paid = pu.price;
          sbcBuying.delete(p.definitionId);
        }
        save();
        renderSbc();
      },
      onTargetsChanged: () => { save(); renderSbc(); },
      onChange: () => { renderSbcStatus(); renderPtsStatus(); },
    });

    // ---------- SBC por pontos ----------
    function ptsState() {
      if (!app.state.pts) app.state.pts = { target: 0, lines: [{ qty: 0, rating: 0, max: 0 }], bought: {}, picks: {} };
      return app.state.pts;
    }
    let ptsRaw = new Map();   // id → carta do Web App (só nesta página)
    let ptsLines = [];
    function ptsTrace(msg, level) {
      const box = el('ptsLog');
      box.hidden = false;
      ptsLines.unshift('<div class="' + (level || 'info') + '">' + new Date().toLocaleTimeString('pt-BR') + ' ' + escapeHtml(msg) + '</div>');
      if (ptsLines.length > 80) ptsLines.length = 80;
      box.innerHTML = ptsLines.join('');
    }

    function boughtCount(st, r) {
      return ((st.bought || {})[r] || []).length;
    }

    function renderPts() {
      const st = ptsState();
      if (doc.activeElement !== el('ptsTarget')) el('ptsTarget').value = st.target > 0 ? st.target : '';
      const box = el('ptsLines');
      const focused = box.contains(doc.activeElement);
      if (!focused) {
        box.innerHTML = st.lines.map((l, i) => '<div class="pts-row" data-pi="' + i + '">' +
          '<input data-pts="qty" inputmode="numeric" placeholder="qtd" value="' + (l.qty > 0 ? l.qty : '') + '">' +
          '<span>× ouro</span>' +
          '<input data-pts="rating" inputmode="numeric" placeholder="nota" value="' + (l.rating > 0 ? l.rating : '') + '">' +
          '<input data-pts="max" inputmode="numeric" placeholder="pagar até" value="' + (l.max > 0 ? l.max : '') + '">' +
          '<button type="button" data-pts-del="' + i + '">✕</button></div>').join('');
      }
      const total = ptsTotal(st.lines);
      const lineText = st.lines.filter((l) => l.qty > 0 && l.rating > 0)
        .map((l) => l.qty + ' × ' + l.rating + ' = ' + fmt(l.qty * ptsScore(l.rating))).join(' · ');
      el('ptsCheck').innerHTML = !lineText ? 'Preencha quantidade e nota de cada linha.'
        : lineText + '<br>Total <b>' + fmt(total) + '</b> pontos' + (st.target > 0
          ? (total >= st.target ? ' ✅ fecha a meta de ' + fmt(st.target) + ' (sobram ' + fmt(total - st.target) + ')'
            : ' ❌ faltam ' + fmt(st.target - total) + ' para ' + fmt(st.target)) : '') +
          '<br><span class="hint">Pontos de cartas comuns pela tabela dos guias; especiais e holográficas valem mais.</span>';
      renderPtsPlan();
      renderPtsStatus();
    }

    function renderPtsPlan() {
      const st = ptsState();
      const picks = st.picks || {};
      const rows = [];
      for (const l of st.lines) {
        const r = parseInt(l.rating, 10);
        if (!(r > 0) || !(l.qty > 0)) continue;
        const p = picks[r];
        const use = p ? p.items.filter((x) => x.use) : [];
        const got = boughtCount(st, r);
        const missing = Math.max(0, l.qty - use.length - got);
        rows.push('<div class="ed-h">Ouro ' + r + ': precisa ' + l.qty + ' · do clube ' + use.length + (p ? ' (de ' + p.available + ' achadas)' : '') +
          ' · compradas ' + got + ' · <b>falta comprar ' + missing + '</b>' + (missing && l.max ? ' até ' + fmt(l.max) : '') + '</div>' +
          (p ? p.items.map((x) => '<label class="pts-pick"><input type="checkbox" data-pts-use="' + r + ':' + x.id + '"' + (x.use ? ' checked' : '') + '> ' +
            escapeHtml(x.name + ' ' + r) + (x.untradeable ? ' · intransferível' : '') + '</label>').join('') : ''));
      }
      el('ptsPlan').innerHTML = rows.join('') || '';
    }

    function renderPtsStatus() {
      const box = el('ptsStatus');
      const st = app.state.pts;
      const mine = sbcEngine.running && sbcTargets.some((t) => t.ptsRating);
      if (!st || (!mine && !Object.keys(st.bought || {}).length)) { box.hidden = true; return; }
      box.hidden = false;
      const parts = st.lines.filter((l) => l.rating > 0).map((l) => 'ouro ' + l.rating + ': ' + boughtCount(st, l.rating) + ' comprada(s)');
      box.innerHTML = (mine ? '🟢 Comprando · ' : '') + parts.join(' · ') + (mine && sbcEngine.stats.searches ? ' · ' + sbcEngine.stats.searches + ' busca(s)' : '');
    }

    function onPtsInput(e) {
      const st = ptsState();
      if (e.target.dataset.el === 'ptsTarget') { st.target = parseCoins(e.target.value); save(); renderPts(); return; }
      const row = e.target.closest('.pts-row');
      if (row && e.target.dataset.pts) {
        const l = st.lines[parseInt(row.dataset.pi, 10)];
        if (!l) return;
        l[e.target.dataset.pts] = parseCoins(e.target.value);
        save();
        renderPts();
        return;
      }
      const use = e.target.dataset.ptsUse;
      if (use) {
        const [r, id] = use.split(':').map(Number);
        const p = (st.picks || {})[r];
        const x = p && p.items.find((y) => y.id === id);
        if (x) {
          x.use = e.target.checked;
          // Desmarcada = protegida (não entra nas próximas buscas).
          const prot = new Set(app.state.ptsProtected || []);
          if (x.use) prot.delete(x.id); else prot.add(x.id);
          app.state.ptsProtected = Array.from(prot);
          save();
          renderPtsPlan();
        }
      }
    }

    function logNotFound(found, trace) {
      trace('❌ Não achei o SBC na tela: ' + found.error + '. Me mande um print destas linhas:', 'error');
      if (found.diag) {
        trace('  telas: ' + found.diag.classes.join(', '), 'muted');
        trace('  campos: ' + (found.diag.keys.join(', ') || 'nenhum com "challenge"'), 'muted');
      }
    }

    async function ptsRead() {
      const found = adapter.sbcChallenge ? adapter.sbcChallenge() : { error: 'função indisponível' };
      if (found.error) { logNotFound(found, ptsTrace); return win.alert('Não achei o SBC aberto. Os detalhes estão no log da seção "SBC por pontos" — me mande um print.'); }
      ptsTrace('SBC encontrado. Detalhes (me mande um print se algo não funcionar):', 'info');
      adapter.sbcDescribe(found).forEach((line) => ptsTrace('  ' + line, 'muted'));
      const slots = found.squad ? adapter.sbcSlots(found.squad, 200) : [];
      ptsTrace('Vagas encontradas: ' + slots.length + ' (ocupadas: ' + slots.filter((x) => x.item).length + ').', 'info');
      // Meta lida da tela, se o desafio informar (ex.: targetScore = 85000).
      const st = ptsState();
      const goal = adapter.sbcDescribe(found).map((l) => l.match(/(?:target|goal|required|req)\w*=(\d{4,})/i)).find(Boolean);
      if (goal && !(st.target > 0)) {
        st.target = parseInt(goal[1], 10);
        save();
        renderPts();
        ptsTrace('Meta lida do SBC: ' + fmt(st.target) + ' pontos (confira).', 'success');
      }
    }

    async function ptsScanClub(btn) {
      const st = ptsState();
      const lines = st.lines.filter((l) => l.qty > 0 && l.rating > 0);
      if (!lines.length) return win.alert('Preencha a solução (quantidade × nota).');
      if (modBusy || engine.running) return win.alert('Espere o bot/módulo terminar.');
      modBusy = 'SBC';
      btn.disabled = true;
      btn.textContent = 'Procurando…';
      try {
        const club = await adapter.clubGoldPlayers(deps.lookup);
        let items = club.items || [];
        const un = await readPile('unassigned').catch(() => null);
        if (un && un.ok) items = items.concat(un.items.filter((it) => it.kind === 'player'));
        ptsTrace('Li ' + (club.items || []).length + ' jogador(es) ouro do clube' + (un && un.ok ? ' + ' + un.items.length + ' em Não atribuídos' : '') +
          (club.success ? '.' : ' (não consegui ler o clube: ' + (club.missing ? 'função não encontrada' : club.status) + ').'), club.success ? 'info' : 'warn');
        const squad = await adapter.activeSquadIds();
        const exclude = new Set(squad.ids);
        items.forEach((it) => { if (it.raw && adapter.inActiveSquad && adapter.inActiveSquad(it.raw)) exclude.add(it.id); });
        const protectedIds = new Set(app.state.ptsProtected || []);
        protectedIds.forEach((id) => exclude.add(id));
        if (squad.success) ptsTrace('Time ativo: ' + squad.ids.size + ' carta(s) fora da lista.', 'info');
        else ptsTrace('Não consegui ler o seu time (' + squad.why + '). Abra a tela "Squads" do Web App uma vez e procure de novo; ou desmarque as cartas do time (elas ficam protegidas nas próximas buscas).', 'warn');
        if (protectedIds.size) ptsTrace(protectedIds.size + ' carta(s) que você desmarcou antes ficaram de fora.', 'muted');
        const specials = items.filter((it) => lines.some((l) => l.rating === it.rating) && it.special === true).length;
        if (specials) ptsTrace(specials + ' carta(s) especial(is) dessas notas ficaram de fora.', 'muted');
        if (items.some((it) => it.special == null)) ptsTrace('Algumas cartas não informam a raridade: confira se nenhuma especial ficou marcada.', 'warn');
        ptsRaw = new Map(items.filter((it) => it.raw).map((it) => [it.id, it.raw]));
        const plan = planPtsFromClub(lines, items, exclude);
        st.picks = {};
        plan.picks.forEach((p) => {
          st.picks[p.rating] = { available: p.available, items: p.items.map((it) => ({ id: it.id, name: it.name, untradeable: !!it.untradeable, use: true })) };
        });
        save();
        renderPts();
        ptsTrace(plan.need.length ? 'Falta comprar: ' + plan.need.map((n) => n.qty + ' × ouro ' + n.rating).join(', ') + '.' : 'Seu clube cobre a solução inteira! ✅',
          plan.need.length ? 'warn' : 'success');
      } finally {
        modBusy = '';
        btn.disabled = false;
        btn.textContent = '🏠 Procurar no meu clube';
      }
    }

    function ptsMissing() {
      const st = ptsState();
      return st.lines.filter((l) => l.qty > 0 && l.rating > 0).map((l) => {
        const p = (st.picks || {})[l.rating];
        const use = p ? p.items.filter((x) => x.use).length : 0;
        return { rating: l.rating, qty: Math.max(0, l.qty - use - boughtCount(st, l.rating)), max: l.max };
      }).filter((n) => n.qty > 0);
    }

    async function ptsBuy() {
      const st = ptsState();
      if (engine.running) return win.alert('Pare o Sniper antes.');
      if (modBusy) return win.alert('Espere o módulo de ' + modBusy + ' terminar.');
      if (!st.picks || !Object.keys(st.picks).length) {
        if (!win.confirm('Você ainda não procurou no clube. Comprar tudo, sem usar cartas do clube?')) return;
      }
      const need = ptsMissing();
      if (!need.length) return win.alert('Nada para comprar: o clube e as compras já cobrem a solução.');
      const bad = need.filter((n) => !(n.max >= 200));
      if (bad.length) return win.alert('Informe o "pagar até" (mínimo 200) da nota: ' + bad.map((n) => n.rating).join(', ') + '.');
      const total = need.reduce((n, x) => n + x.qty * x.max, 0);
      if (!win.confirm('Comprar para o SBC por pontos:\n\n' + need.map((n) => n.qty + ' × ouro ' + n.rating + ' (comum, não especial) até ' + fmt(n.max)).join('\n') +
        '\n\nTotal: até ' + fmt(total) + ' moedas.' + (app.state.settings.dryRun ? '\n\n(Modo simulação ligado: nada será comprado.)' : '\n\nATENÇÃO: compras de verdade.'))) return;
      const now = Date.now();
      sbcTargets = need.map((n) => ptsTarget(n.rating, n.qty, n.max, now));
      modBusy = 'SBC';
      ptsTrace('Comprando: ' + need.map((n) => n.qty + ' × ouro ' + n.rating + ' até ' + fmt(n.max)).join(', ') + '. Busca de ' +
        sbcTargets.map((t) => fmt(t.minPrice) + ' a ' + fmt(t.maxBuy)).join(' / ') + ' e só compra a nota exata.', 'info');
      renderPtsStatus();
      const origTrace = sbcTrace;
      try {
        sbcTrace = ptsTrace;
        await sbcEngine.start();
      } finally {
        sbcTrace = origTrace;
        modBusy = '';
        renderPts();
      }
      const left = ptsMissing();
      ptsTrace(left.length ? 'Faltam: ' + left.map((n) => n.qty + ' × ouro ' + n.rating).join(', ') + '. Toque em Comprar de novo (ou suba o "pagar até").'
        : 'Tudo comprado! Abra o SBC no Web App e toque em "Montar entrega no SBC".', left.length ? 'warn' : 'success');
    }

    async function ptsAssemble(btn) {
      const st = ptsState();
      if (modBusy || engine.running) return win.alert('Espere o bot/módulo terminar.');
      const found = adapter.sbcChallenge ? adapter.sbcChallenge() : { error: 'função indisponível' };
      if (found.error) { logNotFound(found, ptsTrace); return win.alert('Não achei o SBC aberto. Os detalhes estão no log da seção — me mande um print.'); }
      modBusy = 'SBC';
      btn.disabled = true;
      try {
        adapter.sbcDescribe(found).forEach((line) => ptsTrace('  ' + line, 'muted'));
        if (!found.squad) {
          ptsTrace('❌ Achei o SBC, mas ele não usa vagas de elenco. Ainda não sei colocar cartas nessa tela: me mande um print deste log para eu ajustar.', 'error');
          return;
        }
        const raws = [];
        // Do clube (escolhidas na lista).
        for (const [r, p] of Object.entries(st.picks || {})) {
          for (const x of p.items) {
            if (!x.use) continue;
            if (ptsRaw.has(x.id)) raws.push({ raw: ptsRaw.get(x.id), name: x.name, rating: Number(r) });
            else ptsTrace(x.name + ': toque em "Procurar no meu clube" de novo (a página foi recarregada).', 'warn');
          }
        }
        // Compradas (Não atribuídos) → clube.
        const ids = new Set();
        Object.values(st.bought || {}).forEach((list) => list.forEach((b) => ids.add(b.itemId)));
        if (ids.size) {
          const un = await readPile('unassigned').catch(() => null);
          if (un && un.ok) {
            for (const it of un.items.filter((x) => ids.has(x.id) && x.raw)) {
              const mv = await adapter.moveToClub(it.raw);
              ptsTrace(it.name + ': ' + (mv.success ? 'mandei para o clube.' : 'não consegui mandar para o clube (erro ' + mv.status + ').'), mv.success ? 'muted' : 'warn');
              raws.push({ raw: it.raw, name: it.name, rating: it.rating });
              await sleepMs(400);
            }
          }
        }
        if (!raws.length) { win.alert('Nenhuma carta para colocar. Procure no clube e/ou compre antes.'); return; }
        const pts = raws.reduce((n, x) => n + ptsScore(x.rating), 0);
        const slots = adapter.sbcSlots(found.squad, 200);
        const free = slots.filter((x) => !x.item);
        const usable = free.length ? free : slots;
        ptsTrace(raws.length + ' carta(s) = ' + fmt(pts) + ' pontos (tabela). Vagas livres no SBC: ' + free.length + ' de ' + slots.length + '.', 'info');
        if (!usable.length) { ptsTrace('❌ Não achei vagas no SBC aberto. Me mande um print deste log.', 'error'); return; }
        const now = raws.slice(0, usable.length);
        const later = raws.slice(usable.length);
        const r = await adapter.sbcPlace(Object.assign({}, found, { maxSlots: slots.length }), now.map((x, i) => ({ index: usable[i].index, raw: x.raw })));
        if (r.success) {
          ptsTrace('✅ ' + now.length + ' carta(s) colocada(s) (via ' + r.method + (r.saved ? ', salvo' : '') + '). Confira e envie você mesmo.' +
            (later.length ? ' Faltaram vagas para ' + later.length + ': depois de enviar, toque em Montar de novo.' : ''), 'success');
        } else {
          ptsTrace('❌ Não consegui colocar: ' + r.status + '. Me mande um print deste log; as cartas já estão no clube.', 'error');
        }
      } finally {
        modBusy = '';
        btn.disabled = false;
      }
    }

    function renderSbcStatus() {
      const box = el('sbcStatusBox');
      const s = app.state.sbc;
      if (!s) { box.hidden = true; return; }
      const want = s.players.filter((p) => p.buy && !p.owned);
      const got = want.filter((p) => p.bought);
      if (!sbcEngine.running && !got.length && !sbcEngine.stopReason) { box.hidden = true; return; }
      box.hidden = false;
      const st = sbcEngine.stats || {};
      box.innerHTML = (sbcEngine.running ? '🟢 Comprando' : '⏹ Parado' + (sbcEngine.stopReason ? ' (' + escapeHtml(sbcEngine.stopReason) + ')' : '')) +
        ' · comprados <b>' + got.length + ' de ' + want.length + '</b> · gasto ' + fmt(got.reduce((n, p) => n + (p.paid || 0), 0)) +
        (st.searches ? ' · ' + st.searches + ' busca(s)' : '');
    }

    async function sbcStartBuying() {
      const s = app.state.sbc;
      if (!s) return;
      if (engine.running) return win.alert('Pare o Sniper antes: os dois buscando juntos chamam a atenção da EA.');
      if (modBusy) return win.alert('Espere o módulo de ' + modBusy + ' terminar.');
      const buy = s.players.filter((p) => p.buy && !p.owned && !p.bought);
      if (!buy.length) return win.alert(s.players.some((p) => p.bought) ? 'Todos os marcados já foram comprados.' : 'Marque pelo menos um jogador para comprar.');
      const bad = buy.filter((p) => !(p.max >= 200));
      if (bad.length) return win.alert('Informe quanto pagar (mínimo 200) por: ' + bad.map((p) => p.name).join(', ') + '.');
      const total = buy.reduce((n, p) => n + p.max, 0);
      if (!win.confirm('Comprar ' + buy.length + ' jogador(es) para o SBC (1 de cada, só aquela versão):\n\n' +
        buy.map((p) => p.name + ' ' + p.rating + ' até ' + fmt(p.max)).join('\n') + '\n\nTotal: até ' + fmt(total) + ' moedas.' +
        (app.state.settings.dryRun ? '\n\n(Modo simulação ligado: nada será comprado.)' : '\n\nATENÇÃO: compras de verdade.'))) return;
      const now = Date.now();
      sbcBuying.clear();
      sbcTargets = buy.map((p) => {
        sbcBuying.add(p.definitionId);
        return Object.assign(sbcTarget(p, s.name, p.max, now), { id: 'sbc-' + p.definitionId });
      });
      modBusy = 'SBC';
      sbcTraceLines = [];
      sbcTrace('Comprando ' + buy.length + ' jogador(es) para ' + s.name + '.', 'info');
      renderSbc();
      try {
        await sbcEngine.start();
      } finally {
        modBusy = '';
        sbcBuying.clear();
        renderSbc();
        renderSbcStatus();
      }
      const left = s.players.filter((p) => p.buy && !p.owned && !p.bought);
      if (!left.length && s.players.some((p) => p.bought)) {
        sbcTrace('Tudo comprado! Abra o desafio no Web App e toque em "Montar elenco no SBC".', 'success');
      } else if (left.length) {
        sbcTrace('Faltam ' + left.length + ': ' + left.map((p) => p.name).join(', ') + '. Toque em Comprar de novo para continuar (ou suba o "Pagar até").', 'warn');
      }
    }

    // Monta o elenco do desafio aberto no Web App com as cartas do SBC.
    async function sbcAssemble(btn) {
      const s = app.state.sbc;
      if (!s) return;
      if (modBusy || engine.running) return win.alert('Espere o bot/módulo terminar.');
      const found = adapter.sbcChallenge ? adapter.sbcChallenge() : { error: 'função indisponível' };
      if (found.error || !found.squad) {
        if (found.error) logNotFound(found, sbcTrace);
        return win.alert('Não achei o elenco do desafio aberto' + (found.error ? '' : ' (esse SBC não usa vagas de elenco)') + '. Detalhes no log.');
      }
      modBusy = 'SBC';
      btn.disabled = true;
      try {
        const slots = adapter.sbcSlots(found.squad);
        sbcTrace('Desafio encontrado: ' + slots.length + ' vaga(s) (' + slots.map((x) => x.position || '?').join(', ') + ').', 'info');
        const ids = s.players.map((p) => p.definitionId);
        // Cartas: compradas (Não atribuídos) e as que já estão no clube.
        const raws = new Map();
        const un = await readPile('unassigned').catch(() => null);
        if (un && un.ok) {
          for (const it of un.items) {
            if (!ids.includes(it.definitionId) || raws.has(it.definitionId) || !it.raw) continue;
            const mv = await adapter.moveToClub(it.raw);
            sbcTrace(it.name + ': ' + (mv.success ? 'mandei para o clube.' : 'não consegui mandar para o clube (erro ' + mv.status + '); tento usar assim mesmo.'), mv.success ? 'muted' : 'warn');
            raws.set(it.definitionId, it.raw);
            await sleepMs(400);
          }
        }
        const club = await adapter.clubOwned(ids.filter((id) => !raws.has(id)), deps.lookup).catch(() => ({ items: new Map() }));
        (club.items || new Map()).forEach((raw, id) => { if (!raws.has(id)) raws.set(id, raw); });
        const players = s.players.filter((p) => raws.has(p.definitionId)).map((p) => Object.assign({}, p, { raw: raws.get(p.definitionId) }));
        const missing = s.players.filter((p) => !raws.has(p.definitionId));
        if (missing.length) sbcTrace('Não achei no clube/Não atribuídos: ' + missing.map((p) => p.name + ' ' + p.rating).join(', ') + '.', 'warn');
        if (!players.length) { win.alert('Não achei nenhuma carta do SBC no clube nem em Não atribuídos.'); return; }
        const plan = planSbcSlots(slots.length ? slots : players.map((p, i) => ({ index: i, position: p.position })), players);
        plan.forEach((x) => sbcTrace('Vaga ' + (x.index + 1) + (slots[x.index] && slots[x.index].position ? ' (' + slots[x.index].position + ')' : '') + ': ' +
          x.player.name + ' ' + x.player.rating + (x.match ? '' : ' — posição diferente da solução'), x.match ? 'muted' : 'warn'));
        const r = await adapter.sbcPlace(found, plan.map((x) => ({ index: x.index, raw: x.player.raw })));
        if (r.success) {
          sbcTrace('✅ Elenco montado (' + plan.length + ' carta(s), via ' + r.method + (r.saved ? ', salvo' : '') + '). Se a tela não mudou, volte e abra o desafio de novo. Confira e envie você mesmo.', 'success');
          log('SBC: elenco montado com ' + plan.length + ' carta(s).', 'success');
        } else {
          sbcTrace('❌ Não consegui montar: ' + r.status + (r.method ? ' (via ' + r.method + ')' : '') + '. Monte à mão: as cartas já estão no clube.', 'error');
        }
      } finally {
        modBusy = '';
        btn.disabled = false;
      }
    }

    function sbcClearLegacy() {
      const old = app.state.targets.filter((t) => t.sbc);
      if (!old.length) return;
      if (!win.confirm('Tirar do Sniper ' + old.length + ' alvo(s) de SBC criados pela versão anterior?')) return;
      app.state.targets = app.state.targets.filter((t) => !t.sbc);
      save();
      renderTargets();
      renderSbc();
    }

    function sbcResume() {
      let n = 0;
      app.state.targets.forEach((t) => {
        if (t.pausedForSbc) { t.enabled = true; delete t.pausedForSbc; n++; }
      });
      save();
      renderTargets();
      renderSbc();
      log(n + ' alvo(s) reativado(s).', 'success');
    }

    // Venda: carrega, agrupa e mostra cada grupo com quantidade e preço.
    async function loadSellable() {
      if (modBusy || engine.running) return win.alert('Espere o bot/módulo terminar.');
      modBusy = 'venda';
      el('sellGroups').innerHTML = '<p class="hint">Carregando…</p>';
      try {
        const which = ['transfer'].concat(el('sellUnassigned').checked ? ['unassigned'] : []);
        let items = [];
        const notes = [];
        for (const w of which) {
          const r = await readPile(w);
          if (!r.ok) {
            el('sellGroups').innerHTML = '<p class="hint">Não consegui ler ' + PILE_NAMES[w] + ' (' + escapeHtml(r.why) + '). ' + pileHelp(w) + '</p>';
            return;
          }
          if (r.source === 'captura') notes.push(PILE_NAMES[w] + ' carregada pelo Web App às ' + new Date(r.at).toLocaleTimeString('pt-BR'));
          applySync(r.items, true, w);
          items = items.concat(r.items);
        }
        sellGroups = groupSellable(items, ledger());
        renderSellGroups();
        el('sellPrices').hidden = !sellGroups.length;
        const st = sellableStats(items);
        const missing = sellGroups.reduce((n, g) => n + g.items.filter((it) => !it.raw).length, 0);
        const summary = 'Li ' + st.total + ' carta(s)' + (lastPileMethod ? ' (via ' + lastPileMethod + ')' : '') + ': ' + st.ready +
          ' para vender, ' + st.listed + ' já anunciada(s), ' + st.sold + ' vendida(s), ' + st.untradeable + ' intransferível(is).';
        el('sellGroups').insertAdjacentHTML('afterbegin', '<p class="captured">' + escapeHtml(summary) + '</p>' +
          (notes.length || missing ? '<p class="hint">' + escapeHtml(notes.join(' · ')) +
            (missing ? (notes.length ? ' · ' : '') + missing + ' carta(s) ainda não apareceram na tela: para anunciá-las, abra a lista de transferências no Web App e role até vê-las.' : '') + '</p>' : ''));
        if (!st.total) {
          el('sellGroups').insertAdjacentHTML('beforeend', '<p class="hint">' + pileHelp('transfer') + '</p>');
        }
        log('Venda: ' + summary, st.ready ? 'success' : 'warn');
      } finally {
        modBusy = '';
      }
    }

    function suggestionFor(g) {
      const m = deps.market && deps.market.get(g.definitionId);
      return m && m.price > 0 ? m.price : g.futbin > 0 ? g.futbin : 0;
    }

    function sellRef(g) {
      const m = deps.market && deps.market.get(g.definitionId);
      return [m && m.state === 'checking' ? 'Consultando preço atual…' : m && m.price > 0 ? 'Menor compre já agora ' + fmt(m.price) : m ? 'Nenhum anúncio de compre já agora' : '',
        g.futbin ? 'FUTBIN ' + fmt(g.futbin) : '',
        g.avgCost ? 'pago em média ' + fmt(g.avgCost) : 'preço pago desconhecido'].filter(Boolean).join(' · ');
    }

    // Atualiza só o preço de um grupo, sem apagar o que você já digitou.
    function refreshSellGroup(defId) {
      for (const g of sellGroups) {
        if (g.definitionId !== defId) continue;
        const card = panel.querySelector('.sg[data-key="' + cssEscape(g.key) + '"]');
        if (!card) continue;
        card.querySelector('[data-s="ref"]').textContent = sellRef(g) + (g.minPrice ? ' · EA permite ' + fmt(g.minPrice) + '–' + fmt(g.maxPrice) : '');
        const bin = card.querySelector('[data-s="bin"]');
        const sug = suggestionFor(g);
        if (sug && !bin.dataset.typed) bin.value = roundDown(sug);
        updateEstimate(card);
      }
    }

    function cssEscape(v) {
      return String(v).replace(/["\\]/g, '\\$&');
    }

    function checkSellPrices(groups, button) {
      if (modBusy === 'preços') { modStop = true; log('Parando a consulta de preços…', 'warn'); return; }
      const cards = groups.filter((g) => g.definitionId > 0).map((g) => ({ name: g.name, definitionId: g.definitionId, rating: g.rating }));
      const label = button ? button.textContent : '';
      checkPrices(cards, {
        quiet: groups.length > 1,
        onUpdate: (c) => refreshSellGroup(c.definitionId),
        progress: (t) => { if (button) button.textContent = t ? 'Consultando ' + t + ' (toque para parar)' : label; },
      }).then(() => {
        groups.forEach((g) => refreshSellGroup(g.definitionId));
      });
    }

    function renderSellGroups() {
      el('sellActions').hidden = !sellGroups.length;
      if (!sellGroups.length) {
        el('sellGroups').innerHTML = '<p class="hint">Nenhuma carta para anunciar (as já anunciadas ou intransferíveis não aparecem).</p>';
        return;
      }
      el('sellGroups').innerHTML = sellGroups.map((g) => {
        const sug = suggestionFor(g);
        const ref = sellRef(g);
        return '<div class="card sg" data-key="' + escapeHtml(g.key) + '">' +
          '<div class="sg-top"><b>' + escapeHtml(g.name + (g.rating ? ' ' + g.rating : '')) + '</b><span class="sg-count">Você tem ' + g.count +
          (g.items.some((it) => !it.raw) ? ' (' + g.items.filter((it) => it.raw).length + ' prontas)' : '') + '</span></div>' +
          '<p class="hint" data-s="ref">' + escapeHtml(ref) + (g.minPrice ? ' · EA permite ' + fmt(g.minPrice) + '–' + fmt(g.maxPrice) : '') + '</p>' +
          '<div class="grid3">' +
          '<div><label>Quantas</label><input data-s="qty" inputmode="numeric" value="0"></div>' +
          '<div><label>Compre já</label><input data-s="bin" inputmode="numeric" value="' + (sug ? roundDown(sug) : '') + '"></div>' +
          '<div><label>Lance inicial</label><input data-s="start" inputmode="numeric" placeholder="auto"></div>' +
          '</div>' +
          '<div class="ed-actions"><select data-s="duration"><option value="3600">1 hora</option><option value="10800">3 horas</option>' +
          '<option value="21600">6 horas</option><option value="43200">12 horas</option><option value="86400">1 dia</option>' +
          '<option value="259200">3 dias</option></select>' +
          '<button data-act="sellMarket" data-key="' + escapeHtml(g.key) + '">💲 Preço atual</button></div>' +
          '<div class="hint" data-s="est"></div></div>';
      }).join('');
      panel.querySelectorAll('.sg').forEach(updateEstimate);
    }

    function readOrder(card) {
      const g = sellGroups.find((x) => x.key === card.dataset.key);
      const val = (k) => card.querySelector('[data-s="' + k + '"]').value;
      const qty = Math.min(parseCoins(val('qty')), g.count);
      const prices = sellPrices(g, parseCoins(val('bin')), parseCoins(val('start')));
      return { group: g, qty, duration: parseInt(val('duration'), 10) || 3600, prices };
    }

    function updateEstimate(card) {
      const o = readOrder(card);
      const box = card.querySelector('[data-s="est"]');
      if (!o.qty) { box.textContent = 'Escolha quantas vender.'; return; }
      if (o.prices.error) { box.innerHTML = '<span class="neg">' + escapeHtml(o.prices.error) + '</span>'; return; }
      const net = netAfterTax(o.prices.bin);
      box.innerHTML = o.qty + '× por ' + fmt(o.prices.bin) + ' (lance inicial ' + fmt(o.prices.start) + ') → você recebe ' + fmt(net) +
        ' cada, já sem os 5% da EA' +
        (o.prices.profitPerCard != null ? ' · lucro ' + money(o.prices.profitPerCard) + ' cada, ' + money(o.prices.profitPerCard * o.qty) + ' no total' : '') +
        (o.prices.notes.length ? ' · ' + escapeHtml(o.prices.notes.join(', ')) : '');
    }

    async function startSell() {
      if (modBusy || engine.running) return win.alert('Pare o sniper/módulo antes de vender.');
      const orders = [];
      for (const card of panel.querySelectorAll('.sg')) {
        const o = readOrder(card);
        if (!o.qty) continue;
        if (o.prices.error) return win.alert(o.group.name + ': ' + o.prices.error + '.');
        orders.push({ group: o.group, qty: o.qty, bin: o.prices.bin, start: o.prices.start, duration: o.duration });
      }
      if (!orders.length) return win.alert('Escolha a quantidade de pelo menos uma carta.');
      const summary = orders.map((o) => o.qty + '× ' + o.group.name + ' ' + (o.group.rating || '') + ' por ' + fmt(o.bin)).join('\n');
      if (!win.confirm('Anunciar:\n\n' + summary + (app.state.settings.dryRun ? '\n\n(Modo simulação: nada será anunciado.)' : ''))) return;
      modBusy = 'venda';
      modStop = false;
      el('sellResult').hidden = false;
      el('sellResult').textContent = 'Anunciando…';
      try {
        const r = await runBulkSell({ adapter, orders, ledger: ledger(), settings: app.state.settings, log, isStopped: () => modStop });
        save();
        el('sellResult').innerHTML = 'Terminado (' + escapeHtml(r.stopReason) + '): <b>' + (r.listed || r.simulated) + '</b> carta(s) ' +
          (r.simulated ? 'simuladas' : 'anunciadas') + (r.failed ? ', ' + r.failed + ' com erro' : '') + '.';
      } finally {
        modBusy = '';
      }
      if (!app.state.settings.dryRun) loadSellable();
    }


    function onCaptured(criteria, card) {
      if (!card) {
        const learned = learnPsPlusField(criteria, adapter.criteriaDefaults && adapter.criteriaDefaults());
        const cur = app.state.settings.psPlusField;
        if (learned && (!cur || cur.key !== learned.key || JSON.stringify(cur.value) !== JSON.stringify(learned.value))) {
          app.state.settings.psPlusField = learned;
          save();
          log('Aprendi o filtro "PlayStyle+" do Web App. Agora dá para usar nos alvos.', 'success');
        }
      }
      const kind = kindFromCriteria(criteria);
      if (kind !== 'player') card = null;
      // Ajuda a diagnosticar tipos novos: mostra no Log os campos da busca.
      log('Campos da busca capturada: ' + JSON.stringify(criteria), 'info');
      app.captured = criteria;
      app.capturedCard = card || null;
      if (!card) {
        app.capturedLabels = {};
        renderNewFilters();
      } else {
        app.capturedLabels = { player: card.name };
        newEditor.setLabel('player', card.name);
      }
      const kindText = kind ? kindLabel(kind) : 'Tipo não reconhecido: escolha abaixo';
      const parts = targetParts({ kind, criteria, labels: app.capturedLabels,
        psPlus: hasPsPlusFilter(criteria, app.state.settings.psPlusField) }, names);
      el('captured').innerHTML = '<b>Busca capturada:</b> ' + escapeHtml(kindText) +
        (parts.length ? ' · ' + escapeHtml(parts.join(' · ')) : '');
      el('capturedPrice').textContent = card ? 'FUTBIN: buscando preço...' : '';
      if (!card) {
        if (!el('newName').value) {
          el('newName').value = kind === 'chemstyle' && criteria.playStyle > 0
            ? 'Consumível ' + chemStyleName(criteria.playStyle)
            : kind === 'mgrleague' ? parts.join(' ')
            : (kind === 'manager' ? 'Técnico ' : '') + parts.join(' ');
        }
        return;
      }
      el('newName').value = card.name + ' ' + (card.rating || '');
      if (!futbinOn()) return;
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
      const edited = newEditor.value();
      const maxBuy = parseCoins(el('newMax').value);
      const draft = Object.assign({}, edited, { maxBuy });
      const problem = targetProblem(draft);
      if (problem) return win.alert('Não dá para adicionar: ' + problem + '.');
      const sellPrice = parseCoins(el('newSell').value);
      if (sellPrice && sellPrice <= maxBuy) {
        if (!win.confirm('O preço de revenda é menor ou igual ao de compra. Adicionar mesmo assim?')) return;
      }
      const sameCard = app.capturedCard && edited.criteria.maskedDefId &&
        app.captured && app.captured.maskedDefId === edited.criteria.maskedDefId;
      const card = edited.kind === 'player' && sameCard ? app.capturedCard : null;
      if (edited.kind === 'manager' && sameCard && app.capturedCard && app.capturedCard.name) {
        edited.labels = Object.assign({}, edited.labels, { player: app.capturedCard.name });
      }
      const summary = describeTarget(draft, names);
      const count = parseCoins(el('newCount').value);
      const minPriceRaw = parseCoins(el('newMinPrice').value);
      const minPrice = minPriceRaw > 0 ? roundDown(minPriceRaw) : 0;
      if (minPrice && minPrice >= maxBuy) return win.alert('"Buscar a partir de" precisa ser menor que o "Compra até".');
      if (!win.confirm('Confirme o alvo:\n\n' + summary + (minPrice ? '\nBusca de ' + fmt(minPrice) + ' a ' + fmt(maxBuy) : '') + '\nCompra até ' + fmt(maxBuy) +
        '\nQuantidade: ' + (count > 0 ? count + ' carta(s)' : 'sem limite') +
        (app.state.settings.dryRun ? '\n\n(Modo simulação ligado: nada será comprado.)' : '\n\nATENÇÃO: compras de verdade.'))) return;
      app.state.targets.push({
        id: Date.now().toString(36),
        createdAt: Date.now(),
        name: el('newName').value.trim() || (edited.kind === 'manager' ? 'Técnico ' : '') + targetParts(draft, names).join(' ') || summary,
        kind: edited.kind,
        criteria: edited.criteria,
        labels: edited.labels,
        playStyles: edited.playStyles,
        maxCount: parseCoins(el('newCount').value),
        bought: 0,
        psPlus: edited.psPlus,
        psPlusServer: edited.psPlusServer,
        minRating: edited.minRating,
        maxRating: edited.maxRating,
        maxBuy,
        minPrice,
        sellPrice,
        enabled: true,
        card,
        futbin: card && app.capturedFutbin && app.capturedCard === card ? app.capturedFutbin : null,
      });
      save();
      ['newName', 'newMax', 'newSell', 'newCount', 'newMinPrice'].forEach((k) => { el(k).value = ''; });
      app.captured = null;
      app.capturedCard = null;
      app.capturedLabels = {};
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
      if (!(engine.running || modBusy) || !win.navigator.wakeLock || wakeLock) return;
      win.navigator.wakeLock.request('screen').then((l) => {
        wakeLock = l;
        l.addEventListener && l.addEventListener('release', () => { if (wakeLock === l) wakeLock = null; });
      }).catch(() => {});
    }
    // Vale também para os módulos (lances, venda, preços): enquanto algo
    // estiver rodando ou esperando, a tela não apaga.
    win.setInterval(() => {
      const want = engine.running || !!modBusy;
      if (want && doc.visibilityState === 'visible') requestWakeLock();
      if (!want && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    }, 3000);
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'visible') requestWakeLock();
      else if (engine.running) log('Aba em segundo plano: o navegador pode pausar o bot.', 'warn');
    });

    // Ao abrir o painel, usa os filtros que estão na tela de busca do Web App
    // (Players, Managers, Consumables...), mesmo sem ter tocado em Search.
    let lastScreen = '';
    function readScreenFilters() {
      if (engine.running || !adapter.screenCriteria) return;
      const c = adapter.screenCriteria();
      if (!c || !kindFromCriteria(c)) return;
      const key = JSON.stringify(c);
      if (key === lastScreen) return;
      lastScreen = key;
      const same = (a) => a && JSON.stringify(Object.assign({}, a, { maxBuy: 0, minBuy: 0 })) === JSON.stringify(Object.assign({}, c, { maxBuy: 0, minBuy: 0 }));
      if (same(app.captured)) return;
      onCaptured(c, null);
      log('Usei os filtros da tela de busca do Web App no Novo alvo.', 'info');
    }

    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) { readScreenFilters(); renderStatus(); renderTabs(); refreshStalePrices(); }
    });

    panel.addEventListener('click', (e) => {
      const ledgerBtn = e.target.closest('[data-ledger-toggle]');
      if (ledgerBtn) {
        const entry = ledger()[ledgerBtn.dataset.ledgerToggle];
        if (entry) {
          entry.ignored = !entry.ignored;
          entry.autoIgnored = false;
          save();
          renderProfit();
          renderTargets();
        }
        return;
      }
      // Botões − e +: sobem/descem um degrau de preço da EA (como no app).
      const stepBtn = e.target.closest('[data-step]');
      if (stepBtn) {
        const input = stepBtn.parentElement.querySelector('input');
        let cur = parseCoins(input.value);
        if (!cur && stepBtn.dataset.from) {
          const from = stepBtn.closest('.grid, .card, section').querySelector(stepBtn.dataset.from);
          cur = from ? parseCoins(from.value) : 0;
        }
        const next = stepPrice(cur, stepBtn.dataset.step === '+' ? 1 : -1);
        if (!next) return;
        input.value = next;
        input.dispatchEvent(new win.Event('change', { bubbles: true }));
        if (input.dataset.el === 'bidSell' || input.dataset.el === 'bidMax') updateBidSellProfit();
        return;
      }
      const periodBtn = e.target.closest('[data-period]');
      if (periodBtn) {
        periodName = periodBtn.dataset.period;
        if (periodName === 'custom' && !el('periodFrom').value) {
          el('periodFrom').value = dayKey(Date.now() - 6 * 86400000);
          el('periodTo').value = dayKey(Date.now());
        }
        renderProfit();
        return;
      }
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) { tab = tabBtn.dataset.tab; renderTabs(); return; }
      const act = e.target.closest('[data-act]');
      if (act) {
        const a = act.dataset.act;
        if (a === 'close') panel.hidden = true;
        if (a === 'start') {
          if (modBusy) return win.alert('Espere o módulo de ' + modBusy + ' terminar (ou toque em Parar nele).');
          if (!app.state.targets.some((t) => t.enabled)) return win.alert('Adicione e ative pelo menos um alvo.');
          engine.start();
          requestWakeLock();
        }
        if (a === 'stop') {
          engine.stop();
          if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
        }
        if (a === 'add') addTarget();
        if (a === 'cleanDone') cleanTargets(false);
        if (a === 'cleanAll') cleanTargets(true);
        if (a === 'dockReset') {
          app.state.settings.dock = null;
          save();
          placeDock(null);
        }
        if (a === 'diagnose') {
          const hooks = deps.overlay.installed();
          const bulk = deps.prices.bulkStatus();
          const rows = adapter.diagnose().concat([
            ['ponte FUTBIN (segundo script)', futbin.bridgeReady()],
            ['preço nas cartas: ' + (hooks.length ? hooks.join(', ') : 'nenhuma função de desenho encontrada'), hooks.length > 0],
            ['linha: ' + (deps.overlay.rowSample() || 'nenhuma lista vista ainda').slice(0, 400), true],
            ['funções das pilhas: ' + adapter.pileMethods(), true],
            ['pilhas lidas do Web App: ' + (['transfer', 'unassigned', 'watch'].filter((w) => deps.piles && deps.piles[w])
              .map((w) => PILE_NAMES[w] + ' (' + deps.piles[w].items.length + ')').join(', ') || 'nenhuma ainda (abra a lista de transferências)'), true],
            ['filtro PlayStyle+ do Web App: ' + (app.state.settings.psPlusField ? 'aprendido (' + app.state.settings.psPlusField.key + ')' : 'ainda não aprendido'), !!app.state.settings.psPlusField],
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
        if (a === 'profitSync') syncProfit();
        if (a === 'profitClear' && win.confirm('Apagar todo o registro de compras e lucro?')) {
          app.state.ledger = {};
          save();
          renderProfit();
        }
        if (a === 'bidStart') startBids();
        if (a === 'bidCollect') collectBids();
        if (a === 'bidStopList') {
          if (modBusy === 'lances') {
            bidListNow = true;
            modStop = true;
            log('Parando os lances para anunciar as cartas ganhas…', 'warn');
          } else if (!modBusy) {
            collectBids();
          } else {
            win.alert('Espere o módulo de ' + modBusy + ' terminar.');
          }
        }
        if (a === 'sellLoad') loadSellable();
        if (a === 'sellStart') startSell();
        if (a === 'sellMarket') {
          const g = sellGroups.find((x) => x.key === act.dataset.key);
          if (g) checkSellPrices([g], null);
        }
        if (a === 'sellPrices') checkSellPrices(sellGroups, act);
        if (a === 'sbcPaste') pasteSbc();
        if (a === 'sbcImport') importSbc(el('sbcCode').value);
        if (a === 'sbcClub') sbcCheckClub(act);
        if (a === 'sbcPrices') sbcPrices(act);
        if (a === 'sbcUseNow') sbcUseNow();
        if (a === 'sbcBuy') sbcStartBuying();
        if (a === 'ptsAddLine') { ptsState().lines.push({ qty: 0, rating: 0, max: 0 }); save(); renderPts(); }
        if (a === 'ptsRead') ptsRead();
        if (a === 'ptsUnprotect') {
          const n = (app.state.ptsProtected || []).length;
          if (n && win.confirm('Desproteger ' + n + ' carta(s)? Elas voltam a poder entrar no SBC.')) { app.state.ptsProtected = []; save(); }
        }
        if (a === 'ptsClub') ptsScanClub(act);
        if (a === 'ptsBuy') ptsBuy();
        if (a === 'ptsAssemble') ptsAssemble(act);
        if (a === 'sbcStop') { if (sbcEngine.running) sbcEngine.stop(); }
        if (a === 'sbcAssemble') sbcAssemble(act);
        if (a === 'sbcResume') sbcResume();
        if (a === 'sbcLegacy') sbcClearLegacy();
        if (a === 'modStop') { modStop = true; log('Parando o módulo…', 'warn'); }
        return;
      }
      const tg = e.target.closest('.tg');
      const tgt = tg && app.state.targets.find((t) => t.id === tg.dataset.id);
      if (tgt && e.target.dataset.f === 'editFilters') {
        const box = tg.querySelector('.fe-box');
        box.hidden = !box.hidden;
        if (!box.hidden) {
          box.innerHTML = '<div class="ed-host"></div><div class="ed-actions"><button class="go" data-f="saveFilters">Salvar filtros</button>' +
            (app.captured ? '<button data-f="useCaptured">Usar a última busca do mercado</button>' : '') + '</div>';
          const ed = createEditor(box.querySelector('.ed-host'));
          ed.load(tgt.kind, tgt.criteria, tgt);
          editors.set(tgt.id, ed);
        }
        return;
      }
      if (tgt && e.target.dataset.f === 'useCaptured' && app.captured) {
        // Só preenche o editor; nada muda até o usuário conferir e salvar.
        const ed = editors.get(tgt.id);
        if (ed) ed.load(kindFromCriteria(app.captured), app.captured, null, app.capturedLabels);
        log('Editor preenchido com a última busca. Confira o tipo e toque em Salvar filtros.', 'warn');
        return;
      }
      if (tgt && e.target.dataset.f === 'saveFilters') {
        const ed = editors.get(tgt.id);
        if (!ed) return;
        const edited = ed.value();
        const draft = Object.assign({}, tgt, edited);
        const problem = targetProblem(draft);
        if (problem) return win.alert('Não dá para salvar: ' + problem + '.');
        if (!win.confirm('Confirme o alvo:\n\n' + describeTarget(draft, names) + '\nCompra até ' + fmt(tgt.maxBuy))) return;
        Object.assign(tgt, edited, { needsReview: false });
        if (tgt.kind !== 'player') { tgt.card = null; tgt.futbin = null; }
        save();
        renderTargets();
        log('Filtros de ' + tgt.name + ' salvos: ' + describeTarget(tgt, names) + '.', 'success');
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
      if (tgt && e.target.dataset.f === 'resetCount') {
        if (!win.confirm('Zerar a contagem de compras de "' + tgt.name + '"?')) return;
        tgt.bought = 0;
        save();
        renderTargets();
        return;
      }
      if (tg && e.target.dataset.f === 'remove') {
        if (!win.confirm('Remover este alvo?')) return;
        app.state.targets = app.state.targets.filter((t) => t.id !== tg.dataset.id);
        save();
        renderTargets();
      }
    });

    el('sbcList').addEventListener('input', onSbcInput);
    ['ptsTarget', 'ptsLines', 'ptsPlan'].forEach((k) => el(k).addEventListener('change', onPtsInput));
    el('ptsLines').addEventListener('click', (e) => {
      const d = e.target.closest('[data-pts-del]');
      if (!d) return;
      const st = ptsState();
      st.lines.splice(parseInt(d.dataset.ptsDel, 10), 1);
      if (!st.lines.length) st.lines.push({ qty: 0, rating: 0, max: 0 });
      save();
      renderPts();
    });
    el('sbcList').addEventListener('change', onSbcInput);

    panel.addEventListener('input', (e) => {
      if (e.target.dataset && (e.target.dataset.el === 'bidSell' || e.target.dataset.el === 'bidMax')) updateBidSellProfit();
      const f = e.target.dataset && e.target.dataset.f;
      if (f === 'maxBuy' || f === 'sellPrice') updateTargetProfit(e.target.closest('.tg'));
      const card = e.target.closest('.sg');
      if (card && e.target.dataset.s === 'bin') e.target.dataset.typed = '1';
      if (card && e.target.dataset.s) updateEstimate(card);
    });

    panel.addEventListener('change', (e) => {
      if (e.target.dataset.el === 'periodFrom' || e.target.dataset.el === 'periodTo') {
        renderProfit();
        return;
      }
      if (e.target.dataset.s) {
        const card = e.target.closest('.sg');
        if (card) updateEstimate(card);
        return;
      }
      const key = e.target.dataset.setting;
      if (key === 'priceSource') {
        app.state.settings.priceSource = e.target.value === 'futbin' ? 'futbin' : 'market';
        save();
        log('Preço nas cartas: ' + (app.state.settings.priceSource === 'market' ? 'preço atual do mercado (botão 💲)' : 'FUTBIN') + '. Troque de tela para atualizar.', 'success');
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
      if (e.target.closest('.ed')) return;
      const tg = e.target.closest('.tg');
      const f = e.target.dataset.f;
      if (!tg || !f) return;
      const target = app.state.targets.find((t) => t.id === tg.dataset.id);
      if (!target) return;
      if (f === 'enabled') {
        const problem = target.needsReview ? 'revise o alvo em ✎ Filtros e salve'
          : targetDone(target) ? 'este alvo já comprou a quantidade pedida (' + countLabel(target) + '); aumente a quantidade ou toque em Zerar'
          : targetProblem(target);
        if (e.target.checked && problem) {
          e.target.checked = false;
          return win.alert('Não dá para ativar: ' + problem + '.');
        }
        target.enabled = e.target.checked;
      }
      if (f === 'maxBuy') target.maxBuy = parseCoins(e.target.value) || target.maxBuy;
      if (f === 'maxBuy' || f === 'sellPrice') updateTargetProfit(tg);
      if (f === 'sellPrice') target.sellPrice = parseCoins(e.target.value);
      if (f === 'minPrice') {
        const v = parseCoins(e.target.value);
        if (v > 0 && v >= target.maxBuy) {
          e.target.value = target.minPrice > 0 ? target.minPrice : '';
          return win.alert('"Buscar a partir de" precisa ser menor que o "Compra até" (' + fmt(target.maxBuy) + ').');
        }
        target.minPrice = v > 0 ? roundDown(v) : 0;
        save();
        renderTargets();
        return;
      }
      if (f === 'maxCount') {
        target.maxCount = parseCoins(e.target.value);
        save();
        renderTargets();
        return;
      }
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
      syncWatchList(items) {
        const n = recordWonBids(ledger(), items);
        if (n) {
          save();
          log(n + ' carta(s) ganha(s) em leilão registrada(s) no lucro.', 'success');
          if (tab === 'profit' && !panel.hidden) renderProfit();
        }
      },
      syncFromTransferList(items, pile) {
        applySync(items, true, pile);
        if (!panel.hidden && tab === 'targets' && !el('targets').contains(doc.activeElement)) renderTargets();
      },
      refreshTargets() {
        renderTargets();
      },
      // Reordena a lista enquanto o bot roda, mas não enquanto você mexe no painel.
      reorderTargets() {
        if (panel.hidden || tab !== 'targets') return;
        if (Date.now() - lastTouch < 6000) return;
        const box = el('targets');
        if (box.contains(doc.activeElement) || box.querySelector('.fe-box:not([hidden])')) return;
        const order = targetsByRecent(app.state.targets).map((t) => t.id).join();
        const shown = Array.from(box.querySelectorAll('.tg')).map((n) => n.dataset.id).join();
        if (order !== shown) renderTargets();
      },
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
        if (tab === 'profit') renderProfit();
      },
    };
  }

  // ---------------------------------------------------------------------------
  // SBC: solução do FUTBIN → alvos do sniper
  // ---------------------------------------------------------------------------

  const SBC_PREFIX = 'FCAB-SBC1:';
  const SBC_POSITIONS = ['GK', 'RWB', 'LWB', 'RB', 'LB', 'CB', 'CDM', 'CM', 'CAM', 'RM', 'LM', 'RW', 'LW', 'RF', 'LF', 'CF', 'ST'];
  const STAT_LABELS = /^(PAC|SHO|PAS|DRI|DEF|PHY|DIV|HAN|KIC|REF|SPD|POS|RAT|CHEM|RAT\.)$/i;

  // A solução viaja do FUTBIN para o Web App como texto (área de transferência).
  function encodeSbc(sbc) {
    const json = JSON.stringify(sbc);
    return SBC_PREFIX + btoa(unescape(encodeURIComponent(json)));
  }

  function decodeSbc(text) {
    const s = String(text || '');
    const i = s.indexOf(SBC_PREFIX);
    if (i < 0) return { error: 'não achei o código da solução (ele começa com ' + SBC_PREFIX + ')' };
    const b64 = s.slice(i + SBC_PREFIX.length).match(/^[A-Za-z0-9+/=]+/);
    try {
      const data = JSON.parse(decodeURIComponent(escape(atob(b64 ? b64[0] : ''))));
      const players = (Array.isArray(data.players) ? data.players : []).filter((p) => p && p.definitionId > 0);
      if (!players.length) return { error: 'o código não tem jogadores' };
      return {
        sbc: {
          name: String(data.name || 'SBC'),
          url: String(data.url || ''),
          total: data.total > 0 ? data.total : 0,
          at: data.at || Date.now(),
          players: players.map((p) => ({
            definitionId: p.definitionId,
            name: String(p.name || 'Jogador'),
            rating: p.rating > 0 ? p.rating : 0,
            position: String(p.position || ''),
            price: p.price > 0 ? p.price : 0,
            pcPrice: p.pcPrice > 0 ? p.pcPrice : 0,
          })),
        },
      };
    } catch (e) {
      return { error: 'código incompleto ou corrompido (copie de novo no FUTBIN)' };
    }
  }

  // ID da carta na imagem do FUTBIN: .../players/231747.png ou .../players/p50563427.png
  function futbinImageId(url) {
    const m = String(url || '').match(/\/players\/(?:p)?(\d{3,10})\.(?:png|webp|jpe?g)/i);
    return m ? parseInt(m[1], 10) : 0;
  }

  function imageUrlsOf(node) {
    const urls = [];
    if (node.getAttribute) {
      ['src', 'data-src', 'data-original', 'data-lazy-src', 'srcset', 'data-srcset'].forEach((a) => {
        const v = node.getAttribute(a);
        if (v) urls.push(v);
      });
      const st = node.getAttribute('style');
      if (st) urls.push(st);
    }
    return urls;
  }

  function playerIdOf(node) {
    for (const u of imageUrlsOf(node)) {
      const id = futbinImageId(u);
      if (id) return id;
    }
    return 0;
  }

  // Lê as cartas da página de solução do FUTBIN. A página não tem um formato
  // documentado, então procura as fotos dos jogadores e lê o texto em volta.
  function parseSbcCards(root) {
    const photos = Array.from(root.querySelectorAll('img, [style*="/players/"]')).filter((n) => playerIdOf(n) > 0);
    const countIn = (el) => photos.filter((p) => el.contains(p)).length;
    const seen = new Set();
    const cards = [];
    for (const photo of photos) {
      // Sobe até o maior bloco que ainda contém só esta foto: é a carta.
      let card = photo;
      while (card.parentElement && card.parentElement !== root && countIn(card.parentElement) === 1) card = card.parentElement;
      if (seen.has(card)) continue;
      seen.add(card);
      const p = readSbcCard(card, playerIdOf(photo));
      if (p) cards.push(p);
    }
    return cards;
  }

  function textTokens(el) {
    const text = (el.innerText != null && el.innerText !== '' ? el.innerText : el.textContent) || '';
    return text.split(/[\n\r\t]+|\s{2,}/).map((t) => t.trim()).filter(Boolean);
  }

  function readSbcCard(card, definitionId) {
    const tokens = textTokens(card);
    const words = [];
    tokens.forEach((t) => t.split(/\s+/).forEach((w) => words.push(w)));
    let rating = 0;
    let position = '';
    const prices = [];
    for (const w of words) {
      const up = w.toUpperCase();
      if (!position && SBC_POSITIONS.includes(up)) { position = up; continue; }
      if (/^\d{2}$/.test(w)) {
        const n = parseInt(w, 10);
        if (!rating && n >= 40 && n <= 99) rating = n;
        continue;
      }
      // Preços: 650, 1,200, 12.5K, 1.2M (as notas e atributos têm 2 dígitos).
      if (/^\d{1,3}([.,]\d{3})+$|^\d{3,}$|^\d+([.,]\d+)?[KkMm]$/.test(w)) {
        const v = parseShortPrice(w);
        if (v >= 150) prices.push(v);
      }
    }
    // Preço por atributo data-*, quando a página informa.
    let attrPrice = 0;
    let attrPc = 0;
    const nodes = [card].concat(Array.from(card.querySelectorAll('*')));
    for (const n of nodes) {
      for (const a of Array.from(n.attributes || [])) {
        if (!/price/i.test(a.name)) continue;
        const v = parseShortPrice(a.value);
        if (!(v >= 150)) continue;
        if (/pc/i.test(a.name)) attrPc = attrPc || v;
        else if (/ps|console|xbox|xb/i.test(a.name)) attrPrice = attrPrice || v;
      }
    }
    const name = sbcCardName(card, tokens);
    if (!definitionId || !rating) return null;
    return {
      definitionId,
      name,
      rating,
      position,
      // Na tela de preços o FUTBIN mostra console primeiro e PC depois.
      price: attrPrice || prices[0] || 0,
      pcPrice: attrPc || prices[1] || 0,
    };
  }

  function sbcCardName(card, tokens) {
    const byClass = card.querySelector('[class*="name" i]');
    if (byClass && byClass.textContent.trim() && !/^\d+$/.test(byClass.textContent.trim())) return byClass.textContent.trim();
    const alt = Array.from(card.querySelectorAll('img[alt], img[title]')).map((i) => i.getAttribute('alt') || i.getAttribute('title'))
      .find((t) => t && /[A-Za-zÀ-ÿ]{2}/.test(t) && !/futbin|coin|icon|logo|club|nation|league|flag|badge/i.test(t));
    const words = tokens.filter((t) => /[A-Za-zÀ-ÿ]{2}/.test(t) && !SBC_POSITIONS.includes(t.toUpperCase()) &&
      !t.split(/\s+/).every((w) => STAT_LABELS.test(w)));
    return (words[0] || alt || 'Jogador').trim();
  }

  function sbcTitle(doc) {
    const crumbs = Array.from(doc.querySelectorAll('[class*="breadcrumb" i] a, [class*="breadcrumb" i] li, nav a'))
      .map((a) => a.textContent.trim()).filter(Boolean);
    const last = crumbs.length ? crumbs[crumbs.length - 1] : '';
    if (last && !/^home$/i.test(last)) return last;
    return (doc.title || 'SBC').replace(/\s*[-|–]\s*FUTBIN.*$/i, '').trim();
  }

  // Alvo do sniper para um jogador da solução: só aquela versão e aquela nota,
  // uma carta, sem revenda (fica em Não atribuídos para o SBC).
  function sbcTarget(p, sbcName, maxBuy, now) {
    return {
      id: (now || Date.now()).toString(36) + '-' + p.definitionId,
      name: 'SBC ' + sbcName + ': ' + p.name + (p.rating ? ' ' + p.rating : ''),
      kind: 'player',
      criteria: { type: 'player', maskedDefId: baseDefId(p.definitionId) },
      labels: { player: p.name },
      playStyles: [],
      definitionId: p.definitionId,
      maxCount: 1,
      bought: 0,
      minRating: p.rating || 0,
      maxRating: p.rating || 0,
      maxBuy,
      sellPrice: 0,
      enabled: true,
      sbc: sbcName,
      createdAt: now || Date.now(),
      card: { name: p.name, definitionId: p.definitionId, rating: p.rating },
    };
  }

  // SBC por pontos (Streamlined): pontos de cada carta comum por nota.
  // Valores divulgados pelos guias do FC 27; a EA pode mudar.
  const ITEM_SCORES = {
    75: 90, 76: 100, 77: 120, 78: 140, 79: 160, 80: 180, 81: 280, 82: 340, 83: 410, 84: 830,
    85: 2100, 86: 4100, 87: 5500, 88: 8300, 89: 11000, 90: 14000, 91: 19000, 92: 20000, 93: 25000,
    94: 30000, 95: 40000, 96: 55000, 97: 85000, 98: 90000, 99: 100000,
  };
  function ptsScore(rating) {
    const r = parseInt(rating, 10);
    if (!(r > 0)) return 0;
    if (r < 65) return 20;
    if (r < 75) return 35;
    return ITEM_SCORES[Math.min(99, r)] || 0;
  }

  function ptsTotal(lines) {
    return (lines || []).reduce((n, l) => n + (parseInt(l.qty, 10) || 0) * ptsScore(l.rating), 0);
  }

  // Cartas do clube para cada nota da solução: só ouro comum (não especial),
  // fora do time; intransferíveis primeiro. Devolve o que usar e o que comprar.
  function planPtsFromClub(lines, items, exclude) {
    exclude = exclude || new Set();
    const used = new Set();
    const picks = [];
    const need = [];
    for (const line of lines) {
      const r = parseInt(line.rating, 10);
      const qty = parseInt(line.qty, 10) || 0;
      const cands = (items || []).filter((it) => it.rating === r && it.kind === 'player' && it.special !== true &&
        !exclude.has(it.id) && !used.has(it.id))
        .sort((a, b) => (b.untradeable ? 1 : 0) - (a.untradeable ? 1 : 0));
      const take = cands.slice(0, qty);
      take.forEach((it) => used.add(it.id));
      picks.push({ rating: r, items: take, available: cands.length });
      if (take.length < qty) need.push({ rating: r, qty: qty - take.length, max: line.max || 0 });
    }
    return { picks, need };
  }

  // Alvo de compra por nota exata (ouro comum), para o comprador do SBC.
  function ptsTarget(rating, qty, max, now) {
    const maxBuy = roundDown(max);
    return {
      id: 'pts-' + rating,
      name: 'Pontos: ouro ' + rating,
      kind: 'player',
      criteria: { type: 'player', level: 'gold' },
      labels: {},
      playStyles: [],
      minRating: rating,
      maxRating: rating,
      noSpecial: true,
      maxCount: qty,
      bought: 0,
      maxBuy,
      minPrice: roundDown(Math.max(200, maxBuy * 0.7)) < maxBuy ? roundDown(Math.max(200, maxBuy * 0.7)) : 0,
      sellPrice: 0,
      enabled: true,
      ptsRating: rating,
      createdAt: now || Date.now(),
    };
  }

  // Posição da vaga do elenco → posição "simples" (RCB → CB, LS → ST...).
  const SLOT_ALIASES = { RCB: 'CB', LCB: 'CB', SW: 'CB', RCM: 'CM', LCM: 'CM', RDM: 'CDM', LDM: 'CDM', RAM: 'CAM', LAM: 'CAM', RS: 'ST', LS: 'ST' };
  function simplePosition(p) {
    const up = String(p || '').toUpperCase();
    return SLOT_ALIASES[up] || up;
  }

  // Distribui os jogadores da solução nas vagas do desafio: primeiro quem
  // tem a mesma posição da vaga, depois o resto nas vagas que sobrarem.
  function planSbcSlots(slots, players) {
    const free = players.slice();
    const out = [];
    const taken = new Set();
    for (const slot of slots) {
      const want = simplePosition(slot.position);
      const i = free.findIndex((p) => want && simplePosition(p.position) === want);
      if (i >= 0) { out.push({ index: slot.index, player: free[i], match: true }); taken.add(slot.index); free.splice(i, 1); }
    }
    for (const slot of slots) {
      if (taken.has(slot.index) || !free.length) continue;
      out.push({ index: slot.index, player: free.shift(), match: false });
      taken.add(slot.index);
    }
    return out.sort((a, b) => a.index - b.index);
  }

  // Botão "Enviar ao bot" nas páginas do FUTBIN.
  function bootFutbin(win) {
    const doc = win.document;
    const btn = doc.createElement('button');
    btn.textContent = '🧩 Enviar ao bot';
    btn.style.cssText = 'position:fixed;left:12px;bottom:90px;z-index:2147483646;padding:12px 16px;border:0;border-radius:24px;' +
      'background:#1db954;color:#fff;font:700 16px -apple-system,system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4);display:none';
    const box = doc.createElement('div');
    box.style.cssText = 'position:fixed;left:8px;right:8px;bottom:150px;z-index:2147483646;background:#111;color:#eee;padding:12px;' +
      'border-radius:12px;font:14px -apple-system,system-ui,sans-serif;max-height:60vh;overflow:auto;display:none;box-shadow:0 2px 12px rgba(0,0,0,.6)';
    doc.body.appendChild(btn);
    doc.body.appendChild(box);

    const scan = () => {
      const n = parseSbcCards(doc.body).length;
      btn.style.display = n >= 3 ? 'block' : 'none';
    };
    scan();
    win.setInterval(scan, 2000);

    async function copy(text) {
      try {
        await win.navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        return false;
      }
    }

    function show(html) {
      box.innerHTML = html + '<p><button data-close style="padding:8px 14px;border-radius:8px;border:0">Fechar</button></p>';
      box.style.display = 'block';
      box.querySelector('[data-close]').onclick = () => { box.style.display = 'none'; };
    }

    btn.addEventListener('click', async () => {
      const players = parseSbcCards(doc.body);
      const total = players.reduce((n, p) => n + (p.price || 0), 0);
      const sbc = { name: sbcTitle(doc), url: win.location.href, total, at: Date.now(), players };
      const code = encodeSbc(sbc);
      const ok = await copy(code);
      const noPrice = players.filter((p) => !p.price).length;
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
      show('<b>' + esc(sbc.name) + '</b>: ' + players.length + ' jogador(es)<br>' +
        players.map((p) => esc(p.name + ' ' + p.rating + ' ' + p.position) + ' — ' + (p.price ? fmt(p.price) : 'sem preço')).join('<br>') +
        (noPrice ? '<p>⚠️ ' + noPrice + ' sem preço. Toque no selo verde do FUTBIN até aparecerem os preços e toque em "Enviar ao bot" de novo.</p>' : '') +
        (ok ? '<p>✅ Copiado. Agora abra o Web App da EA → ⚡ → aba 🧩 SBC → <b>Colar solução</b>.</p>'
          : '<p>Não consegui copiar sozinho. Toque e segure no código abaixo → Selecionar tudo → Copiar:</p>') +
        '<textarea readonly style="width:100%;height:70px;font-size:11px">' + esc(code) + '</textarea>');
    });
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
    // Cartas que o Web App já desenhou na tela (para poder anunciá-las) e as
    // pilhas que ele já carregou (lista de transferências etc.).
    const entities = new Map();
    entities.screens = new Map();
    const market = createMarketCache();
    const piles = {};
    let ui = null;
    let lookup = null;
    installPileCapture(win, (which, json) => {
      const items = itemsFromPileJson(json, lookup || {});
      piles[which] = { at: Date.now(), items };
      if (ui && (which === 'transfer' || which === 'unassigned')) ui.syncFromTransferList(items, which);
      if (ui && which === 'watch') ui.syncWatchList(items);
    });
    const adapter = createEaAdapter(win);
    const bridge = createBridgeRequest(win);
    const futbinRequest = withCircuitBreaker(bridge);
    const futbin = Object.assign(createFutbin(futbinRequest), { bridgeReady: bridge.isReady });
    const prices = createPriceService(futbinRequest, futbin);
    const overlay = createPriceOverlay(win, prices, () => app.state.settings, (msg) => {
      if (ui) ui.log('FUTBIN: ' + msg, 'error');
    }, entities, market);
    const engine = new Autobuyer({
      adapter,
      getState: () => app.state,
      log: (msg, level) => ui && ui.log(msg, level),
      onChange: () => ui && ui.refresh(),
      onPurchase: (p) => {
        app.state.history.unshift(p);
        if (app.state.history.length > 100) app.state.history.length = 100;
        if (!app.state.ledger) app.state.ledger = {};
        recordBuy(app.state.ledger, { itemId: p.itemId, name: p.name, rating: p.rating, definitionId: p.definitionId, price: p.price, source: 'bot', at: p.at, targetId: p.targetId });
        store.save(app.state);
      },
      // Alvos criados por ID ainda não sabem qual é a carta; a primeira busca
      // do bot traz o nome, e aí dá para consultar o FUTBIN.
      onTargetsChanged: () => {
        store.save(app.state);
        if (ui) ui.refreshTargets();
      },
      onSearchResults: (target, items) => {
        store.save(app.state);
        if (ui) ui.reorderTargets();
        const c = target.criteria || {};
        if (target.kind !== 'player' || target.card || !(c.maskedDefId || (Array.isArray(c.defId) && c.defId.length))) return;
        const card = cardFromItems(items);
        if (!card) return;
        target.card = card;
        store.save(app.state);
        ui.onTargetCard(target);
      },
    });
    const names = createNameService(() => adapter.localize());
    const playersDb = createPlayersDb(adapter, win);
    names.player = (id) => playersDb.name(id);
    lookup = {
      entity: (id) => entities.get(id) || null,
      entityName: (e) => itemNameOf(e),
      playerName: (assetId) => playersDb.name(assetId),
    };
    ui = createUI(win, { app, store, engine, adapter, futbin, prices, overlay, names, players: playersDb, piles, entities, lookup, market });
    ui.log('Painel carregado. Aguardando o Web App...');

    const timer = setInterval(() => {
      if (!adapter.ready()) return;
      clearInterval(timer);
      adapter.hookManualSearch((criteria, card) => ui.onCaptured(criteria, card));
      adapter.hookTransferList((items) => ui.syncFromTransferList(items, 'transfer'));
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
    PLAYSTYLES, playStyleName, readPlayStyles, playStyleMismatch, targetParts, createNameService,
    searchByName, parsePlayersDb, searchPlayers, validName,
    learnPsPlusField, applyPsPlus, hasPsPlusFilter, psPlusMismatch, zoneInfo, zoneLabel,
    targetRemaining, targetDone, countLabel,
    ledgerKey, recordBuy, syncLedger, entryProfit, ledgerSummary, inPeriod, dayKey, dayRange, presetPeriod, dailyProfit, runBulkBids, collectWonBids, runBulkSell,
    lowestBin, createMarketCache, clampDock, ptsScore, ptsTotal, planPtsFromClub, ptsTarget, planSbcSlots, simplePosition, readPositionFilter, stepPrice, minPriceValues, targetLedgerStats, migrateLedger, recordWonBids, encodeSbc, decodeSbc, futbinImageId, parseSbcCards, sbcTarget, findPileMethod, pileFromUrl, itemFromJson, looksLikeItem, findItemArray, shapeOf, itemsFromPileJson, installPileCapture, readFlag, sellableStats,
    nextBidAmount, bidAmountFor, bidProblem, planBids, watchStatus, groupSellable, sellPrices,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined' && window.document) {
    if (window.__fcabLoaded) return;
    window.__fcabLoaded = true;
    if (/(^|\.)futbin\.com$/i.test(window.location.hostname)) bootFutbin(window);
    else boot(window);
  }
})();
