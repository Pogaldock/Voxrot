// ==UserScript==
// @name         Moodboard: double tap to save
// @namespace    symbioze.moodboard
// @version      1.2.0
// @description  Double tap an image on Google Images to save it to your Moodboard.
// @match        https://pogaldock.github.io/Voxrot/moodboard/*
// @include      /^https:\/\/(www|images)\.google\.[a-z.]+\/.*/
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addValueChangeListener
// @connect      *
// @run-at       document-end
// @noframes
// @downloadURL  https://pogaldock.github.io/Voxrot/moodboard/moodboard.user.js
// @updateURL    https://pogaldock.github.io/Voxrot/moodboard/moodboard.user.js
// ==/UserScript==

// How it fits together:
// - On Google: double tap saves into a queue kept in Violentmonkey's storage (shared by both sites).
// - On the Moodboard page: the queue is handed to the page, which stores it in its own database.
// Messages between this script and the page are plain strings starting with "mbx:".

(function () {
  'use strict';

  var HOST = window.__mbHost || location.hostname; // __mbHost only exists in tests
  var P = 'mbx:';
  var DOUBLE_TAP_MS = 300;

  function get(k, d) { var v = GM_getValue(k); return v === undefined ? d : v; }
  function set(k, v) { GM_setValue(k, v); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

    function fetchBlob(url) {
    return new Promise(function (res) {
      if (/^data:image\//.test(url)) { res(url); return; }
      GM_xmlhttpRequest({
        method: 'GET', url: url, responseType: 'blob', timeout: 10000,
        onload: function (r) {
          var b = r.response;
          if (r.status >= 200 && r.status < 300 && b && b.size > 500 && /^image\//.test(b.type || '')) {
            var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { res(null); }; fr.readAsDataURL(b);
          } else res(null);
        },
        onerror: function () { res(null); }, ontimeout: function () { res(null); }
      });
    });
  }

  if (/\/moodboard\//.test(location.pathname)) bridge();
  else if (/(^|\.)google\.[a-z.]+$/.test(HOST)) google();

  // ================= Moodboard page side =================
  function bridge() {
    function send(o) { window.postMessage(P + JSON.stringify(o), '*'); }

    window.addEventListener('message', function (e) {
      // No e.source check: in Firefox's add-on sandbox it can fail silently. The prefix + message types are enough.
      if (typeof e.data !== 'string' || e.data.indexOf(P) !== 0) return;
      var m = JSON.parse(e.data.slice(P.length));

      if (m.type === 'hello') {
        var s = m.state;
        var boards = get('boards', []);
        var pageIds = {};
        s.boards.forEach(function (b) { pageIds[b.id] = 1; });
        // Page is the truth for boards it already has. Boards made on Google and not imported yet stay.
        var pending = boards.filter(function (b) { return b.pending && !pageIds[b.id]; });
        boards = s.boards.map(function (b) { return { id: b.id, name: b.name }; }).concat(pending);
        set('boards', boards);

        var active = get('active', null), activeT = get('activeT', 0);
        var known = boards.some(function (b) { return b.id === active; });
        var gmNewer = active && known && activeT > (s.activeT || 0);
        if (!gmNewer) { set('active', s.active); set('activeT', s.activeT || 0); }

        var queue = get('queue', []);
        if (queue.length || pending.length || gmNewer) {
          send({ type: 'import', boards: pending, items: queue, active: gmNewer ? active : null, activeT: activeT });
        }
      }

      if (m.type === 'imported') {
        var done = {}; m.ids.forEach(function (id) { done[id] = 1; });
        set('queue', get('queue', []).filter(function (q) { return !done[q.id]; }));
        var made = {}; (m.boardIds || []).forEach(function (id) { made[id] = 1; });
        set('boards', get('boards', []).map(function (b) { return made[b.id] ? { id: b.id, name: b.name } : b; }));
      }

      if (m.type === 'debug?') send({ type: 'debug', text: JSON.stringify(get('debug', []), null, 1) });

      // Page asked for Google results for a word; the Google tab it opens picks this up.
      if (m.type === 'grab') set('grabReq', { id: uid(), word: m.word, board: m.board, t: Date.now() });

      if (m.type === 'resultsSeen') { var r = get('grabRes', null); if (r && r.id === m.id) set('grabRes', null); }

      // Picked results: download the full images (falls back to the preview) and queue them for import.
      if (m.type === 'fetchPicked') {
        (async function () {
          for (var i = 0; i < m.items.length; i++) {
            var p = m.items[i];
            var data = (p.url && await fetchBlob(p.url)) || await fetchBlob(p.thumb);
            set('queue', get('queue', []).concat([{ id: uid(), board: p.board, word: p.word, data: data, url: data ? null : (p.url || p.thumb), src: p.src, t: Date.now() }]));
            send({ type: 'progress', done: i + 1, total: m.items.length });
          }
          send({ type: 'ready' });
        })();
      }
    });

    function sendResults() { var r = get('grabRes', null); if (r && r.items && r.items.length) send({ type: 'results', res: r }); }

    // A save on Google while this tab is open: ask the page for its state, which triggers the import.
    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener('queue', function (name, oldV, newV, remote) {
        if (remote && newV && newV.length) send({ type: 'ready', waiting: newV.length });
      });
      GM_addValueChangeListener('grabRes', function (name, oldV, newV, remote) { if (remote) sendResults(); });
    }

    send({ type: 'ready', waiting: get('queue', []).length });
    sendResults();
  }

  // ================= Google side =================
  function google() {
    function isImages() {
      return /[?&](udm=2|tbm=isch)(&|$)/.test(location.search) || /^images\./.test(HOST) || window.__mbHost;
    }

    // Stop double-tap zoom so two taps arrive as two clicks.
    var st = document.createElement('style');
    st.textContent = 'html,body{touch-action:manipulation!important}';
    document.documentElement.appendChild(st);

    // ---------- board state ----------
    function boards() {
      var b = get('boards', []);
      if (!b.length) {
        b = [{ id: uid(), name: 'inbox', pending: true }];
        set('boards', b); set('active', b[0].id); set('activeT', Date.now());
      }
      return b;
    }
    function active() {
      var b = boards(), a = get('active', null);
      if (!b.some(function (x) { return x.id === a; })) { a = b[0].id; set('active', a); }
      return a;
    }
    function boardName(id) { var b = boards().find(function (x) { return x.id === id; }); return b ? b.name : '?'; }

    // ---------- bar UI (shadow DOM so Google's CSS can't touch it) ----------
    var host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none';
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      '*{box-sizing:border-box;font:14px/1.2 system-ui,sans-serif}[hidden]{display:none!important}' +
      '.wrap{display:flex;flex-direction:column;align-items:center;gap:8px;padding:0 10px calc(env(safe-area-inset-bottom) + 14px)}' +
      '.pill,.chip{pointer-events:auto;background:#000;color:#fff;border:1px solid #444;border-radius:18px;height:36px;padding:0 14px;white-space:nowrap}' +
      '.pill{display:flex;align-items:center;gap:8px}' +
      '.dot{width:7px;height:7px;border-radius:50%;background:#fff}' +
      '.n{color:#999}' +
      '.panel{pointer-events:auto;display:flex;flex-wrap:wrap;justify-content:center;gap:6px;max-width:100%}' +
      '.chip.on{background:#fff;color:#000;border-color:#fff}' +
      '.chip.add{border-style:dashed;color:#bbb}' +
      '.flash{position:fixed;pointer-events:none;border:3px solid #fff;border-radius:8px;box-shadow:0 0 0 2px #000;transition:opacity .5s}' +
      '</style>' +
      '<div class="wrap"><div class="panel" hidden></div><button class="pill"><span class="dot"></span><span class="name"></span><span class="n"></span></button></div>';
    var pill = root.querySelector('.pill'), panel = root.querySelector('.panel');
    var sessionCount = 0, msgTimer;

    function drawPill(msg) {
      root.querySelector('.name').textContent = msg || boardName(active());
      root.querySelector('.n').textContent = msg ? '' : (sessionCount ? String(sessionCount) : '');
      clearTimeout(msgTimer);
      if (msg) msgTimer = setTimeout(function () { drawPill(); }, 1400);
    }
    function drawPanel() {
      panel.innerHTML = '';
      var a = active();
      boards().forEach(function (b) {
        var c = document.createElement('button');
        c.className = 'chip' + (b.id === a ? ' on' : '');
        c.textContent = b.name;
        c.onclick = function () { set('active', b.id); set('activeT', Date.now()); sessionCount = 0; panel.hidden = true; drawPill(); };
        panel.appendChild(c);
      });
      var add = document.createElement('button');
      add.className = 'chip add'; add.textContent = '+ new';
      add.onclick = function () {
        var name = (prompt('New board') || '').trim();
        if (!name) return;
        var b = { id: uid(), name: name, pending: true };
        set('boards', boards().concat([b])); set('active', b.id); set('activeT', Date.now());
        sessionCount = 0; panel.hidden = true; drawPill();
      };
      panel.appendChild(add);
    }
    pill.onclick = function () { panel.hidden = !panel.hidden; if (!panel.hidden) drawPanel(); };

    function showBar() {
      var want = !!isImages();
      if (want && !host.isConnected) { document.body.appendChild(host); drawPill(); }
      if (!want && host.isConnected) host.remove();
    }
    showBar();
    setInterval(showBar, 1000);

    function flash(rect) {
      var f = document.createElement('div');
      f.className = 'flash';
      f.style.cssText = 'left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px';
      root.appendChild(f);
      setTimeout(function () { f.style.opacity = '0'; }, 350);
      setTimeout(function () { f.remove(); }, 900);
    }

    // ---------- double tap detection ----------
    var pend = null, replaying = false;

    function imageAt(e) {
      var list = document.elementsFromPoint(e.clientX, e.clientY);
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (el === host) return null;
        if (el.tagName === 'IMG') {
          var r = el.getBoundingClientRect();
          if (r.width >= 80 && r.height >= 60) return el;
          return null;
        }
      }
      return null;
    }

    window.addEventListener('click', function (e) {
      if (replaying || !isImages() || e.composedPath().indexOf(host) >= 0) return;
      var img = imageAt(e);
      if (!img) return;
      e.preventDefault(); e.stopImmediatePropagation();

      if (pend && pend.img === img) {
        clearTimeout(pend.timer); pend = null;
        save(img);
        return;
      }
      if (pend) { clearTimeout(pend.timer); replay(pend); }
      var p = { img: img, target: e.target };
      p.timer = setTimeout(function () { if (pend === p) { pend = null; replay(p); } }, DOUBLE_TAP_MS);
      pend = p;
    }, true);

    // A single tap: hand the click back to Google so it opens the image like normal.
    function replay(p) {
      replaying = true;
      try { p.target.click(); } finally { replaying = false; }
    }

    // ---------- finding the full-size image ----------
    var scriptCache = '', scriptCount = -1;
    function scriptText() {
      if (document.scripts.length !== scriptCount) {
        scriptCount = document.scripts.length;
        var parts = [];
        for (var i = 0; i < document.scripts.length; i++) if (!document.scripts[i].src) parts.push(document.scripts[i].textContent);
        scriptCache = parts.join('\n');
      }
      return scriptCache;
    }
    function unescape(s) {
      return s.replace(/\\u([0-9a-fA-F]{4})/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); }).replace(/\\\//g, '/');
    }
    function isGoogleHost(u) {
      try { return /(^|\.)(gstatic\.com|google\.[a-z.]+|googleusercontent\.com)$/.test(new URL(u).hostname); } catch (e) { return true; }
    }
    // Google stores results as ["thumbnail",h,w],["original",h,w]. Take the first non-Google one after a marker.
    function originalAfter(text, at) {
      var win = text.slice(at, at + 5000);
      var re = /\["(https?:[^"]+)",(\d+),(\d+)\]/g, m;
      while ((m = re.exec(win))) {
        var u = unescape(m[1]);
        if (!isGoogleHost(u)) return u;
      }
      return null;
    }

    // The tile = the largest ancestor that still holds only this one picture.
    // Searching beyond it would pick up neighbouring results.
    function bigImgs(el) {
      var n = 0, list = el.querySelectorAll('img');
      for (var i = 0; i < list.length; i++) { var r = list[i].getBoundingClientRect(); if (r.width >= 60 && r.height >= 50) n++; }
      return n;
    }
    function tileChain(img) {
      var chain = [img], el = img;
      while (el.parentElement && el.parentElement !== document.body && bigImgs(el.parentElement) <= 1 && chain.length < 12) {
        el = el.parentElement; chain.push(el);
      }
      return chain;
    }

    function resolve(img) {
      var s = img.currentSrc || img.src || '';
      var chain = tileChain(img), tile = chain[chain.length - 1];
      // 1. Already a full image (e.g. the big preview)
      if (/^https?:/.test(s) && !isGoogleHost(s)) return { url: s, how: 'direct' };
      // 2. A link carrying imgurl= (around the picture, or inside its tile)
      var a = img.closest('a[href*="imgurl="]') || tile.querySelector('a[href*="imgurl="]');
      if (a) {
        var m = a.getAttribute('href').match(/[?&]imgurl=([^&]+)/);
        if (m) return { url: decodeURIComponent(m[1]), how: 'imgurl' };
      }
      // 3. An id on the tile that also appears in Google's page data
      var text = scriptText();
      for (var d = 0; d < chain.length; d++) {
        var el = chain[d];
        for (var i = 0; i < el.attributes.length; i++) {
          var at = el.attributes[i];
          if (!/^(id|data-.*)$/.test(at.name) || !/^[A-Za-z0-9_-]{8,48}$/.test(at.value)) continue;
          var idx = text.indexOf('"' + at.value + '"'), tries = 0;
          while (idx >= 0 && tries++ < 6) {
            var u = originalAfter(text, idx);
            if (u) return { url: u, how: 'id:' + at.name };
            idx = text.indexOf('"' + at.value + '"', idx + 1);
          }
        }
      }
      // 4. The thumbnail URL itself appearing in the page data
      if (/^https?:/.test(s)) {
        var esc = s.replace(/=/g, '\\u003d').replace(/&/g, '\\u0026');
        var j = text.indexOf(s); if (j < 0) j = text.indexOf(esc);
        if (j >= 0) { var u2 = originalAfter(text, j); if (u2) return { url: u2, how: 'thumb-in-data' }; }
      }
      return null;
    }

    function sourcePage(img) {
      var chain = tileChain(img), tile = chain[chain.length - 1];
      var a = img.closest('a[href^="http"]');
      if (a && !isGoogleHost(a.href)) return a.href;
      var links = tile.querySelectorAll('a[href^="http"]');
      for (var i = 0; i < links.length; i++) if (!isGoogleHost(links[i].href)) return links[i].href;
      return null;
    }

    function attrsOf(el) {
      var o = [];
      for (var d = 0; el && d < 8; d++, el = el.parentElement) {
        var a = [];
        for (var i = 0; i < el.attributes.length; i++) a.push(el.attributes[i].name + '=' + String(el.attributes[i].value).slice(0, 60));
        o.push(el.tagName + ' ' + a.join(' '));
      }
      return o;
    }

    // ---------- grab mode: Moodboard opened this tab to collect results for one word ----------
    function grabMode() {
      var req = get('grabReq', null);
      if (!req || Date.now() - req.t > 120000) return;
      var q = (new URLSearchParams(location.search).get('q') || '').trim().toLowerCase();
      if (q !== String(req.word).trim().toLowerCase()) return;
      set('grabReq', null);
      drawPill('grabbing "' + req.word + '"');
      var tries = 0, lastN = -1;
      var timer = setInterval(function () {
        tries++;
        var tiles = document.querySelectorAll('[data-docid][data-lpage]');
        var n = tiles.length;
        if ((n >= 10 && n === lastN) || tries > 16) { clearInterval(timer); collect(req, tiles); }
        lastN = n;
      }, 500);
    }
    function collect(req, tiles) {
      var text = scriptText(), out = [], seen = {};
      for (var i = 0; i < tiles.length && out.length < 60; i++) {
        var t = tiles[i], im = t.querySelector('img');
        if (!im) continue;
        var thumb = im.currentSrc || im.src || '';
        if (!/^(https?:|data:image)/.test(thumb) || /^data:image\/gif/.test(thumb)) thumb = im.getAttribute('data-jslayout-progressive-load') || thumb;
        var url = null;
        ['data-docid', 'data-ref-docid'].forEach(function (a) {
          var v = t.getAttribute(a); if (url || !v) return;
          var idx = text.indexOf('"' + v + '"'); if (idx >= 0) url = originalAfter(text, idx);
        });
        var key = url || thumb;
        if (!thumb || seen[key]) continue; seen[key] = 1;
        out.push({ thumb: thumb, url: url, lpage: t.getAttribute('data-lpage'), title: im.alt || '' });
      }
      set('grabRes', { id: uid(), word: req.word, board: req.board, items: out, t: Date.now() });
      var log = get('debug', []);
      log.unshift({ t: new Date().toISOString(), how: 'grab', word: req.word, tiles: tiles.length, sent: out.length, full: out.filter(function (x) { return x.url; }).length });
      set('debug', log.slice(0, 8));
      drawPill(out.length + ' sent to Moodboard');
      setTimeout(function () { try { window.close(); } catch (e) {} }, 700);
    }
    setTimeout(grabMode, 300);

    async function save(img) {
      var rect = img.getBoundingClientRect();
      var thumb = img.currentSrc || img.src || '';
      var found = resolve(img);
      var key = found ? found.url : thumb.slice(0, 300);
      var saved = get('saved', {});
      if (saved[key]) { flash(rect); drawPill('already saved'); return; }
      flash(rect); drawPill('saving');
      if (navigator.vibrate) navigator.vibrate(20);

      var data = found ? await fetchBlob(found.url) : null;
      var small = false;
      if (!data) { data = await fetchBlob(thumb); small = true; }

      var board = active();
      var q = (new URLSearchParams(location.search).get('q') || '').trim().toLowerCase();
      var item = { id: uid(), board: board, word: q || undefined, data: data, url: data ? null : (found ? found.url : thumb), src: sourcePage(img) || (found && found.url) || null, t: Date.now() };
      set('queue', get('queue', []).concat([item]));
      saved[key] = 1; set('saved', saved);
      sessionCount++;
      drawPill(small ? 'saved (small)' : 'saved');

      var log = get('debug', []);
      log.unshift({ t: new Date().toISOString(), how: found ? found.how : 'none', small: small, gotData: !!data, page: location.href.slice(0, 200), img: thumb.slice(0, 120), scripts: document.scripts.length, tile: attrsOf(img), tileDepth: tileChain(img).length });
      set('debug', log.slice(0, 8));
    }
  }
})();
