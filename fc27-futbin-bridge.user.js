// ==UserScript==
// @name         FC27 Autobuyer - ponte FUTBIN
// @namespace    fc27-autobuyer
// @version      0.3.1
// @description  Permite que o FC27 Autobuyer consulte preços no FUTBIN
// @match        https://www.ea.com/*ea-sports-fc/ultimate-team/web-app/*
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      www.futbin.com
// @inject-into  content
// @updateURL    https://raw.githubusercontent.com/eduhandrade/fc27-autobuyer/main/fc27-futbin-bridge.user.js
// @downloadURL  https://raw.githubusercontent.com/eduhandrade/fc27-autobuyer/main/fc27-futbin-bridge.user.js
// @run-at       document-start
// ==/UserScript==

// O Web App (www.ea.com) não pode ler dados de outro site. Este script roda
// com a permissão de rede do gerenciador de userscripts e busca as páginas do
// FUTBIN a pedido do FC27 Autobuyer. Só aceita endereços do futbin.com.
(function () {
  'use strict';

  const ALLOWED = /^https:\/\/www\.futbin\.com\//;
  const gmRequest = (typeof GM !== 'undefined' && GM.xmlHttpRequest) ||
    (typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null);

  function send(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(detail) }));
  }

  window.addEventListener('fcab:ping', () => send('fcab:bridge-ready', {}));

  window.addEventListener('fcab:fetch', (e) => {
    let req;
    try {
      req = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    const reply = (d) => send('fcab:fetch:result', Object.assign({ id: req.id }, d));
    if (!ALLOWED.test(String(req.url))) return reply({ ok: false, status: 0, error: 'endereço não permitido' });
    if (!gmRequest) return reply({ ok: false, status: 0, error: 'o gerenciador de scripts não liberou GM.xmlHttpRequest' });
    gmRequest({
      method: 'GET',
      url: req.url,
      timeout: 15000,
      headers: { Accept: 'application/json, text/html;q=0.9, */*;q=0.8' },
      onload: (r) => reply({
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        text: r.responseText != null ? r.responseText : r.response,
        error: r.status === 403 ? 'FUTBIN bloqueou (abra futbin.com uma vez no Safari e tente de novo)' : undefined,
      }),
      onerror: () => reply({ ok: false, status: 0, error: 'falha de rede ao acessar o FUTBIN' }),
      ontimeout: () => reply({ ok: false, status: 0, error: 'FUTBIN demorou demais para responder' }),
    });
  });

  send('fcab:bridge-ready', {});
})();
