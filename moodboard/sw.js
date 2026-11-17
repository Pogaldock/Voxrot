// Service worker: offline cache + receives images shared from Android's share menu.
importScripts('db.js');

var CACHE = 'mb-v1';
var ASSETS = ['./', './index.html', './db.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('mb-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network first so updates arrive, cache when offline.
  e.respondWith(fetch(e.request).then(function (r) {
    var copy = r.clone();
    caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
    return r;
  }).catch(function () {
    return caches.match(e.request, { ignoreSearch: true });
  }));
});

// Pull a direct image URL out of whatever text/link Chrome hands over.
function findImageUrl(s) {
  if (!s) return null;
  var m = s.match(/https?:\/\/\S+/);
  if (!m) return null;
  var u = m[0];
  try {
    var parsed = new URL(u);
    // Google Images links carry the real image in ?imgurl=
    var direct = parsed.searchParams.get('imgurl');
    if (direct) return direct;
  } catch (err) {}
  return u;
}

async function handleShare(request) {
  var ids = [];
  try {
    var form = await request.formData();
    var board = await MB.active();
    var files = form.getAll('image').filter(function (f) { return f && f.size; });
    var link = findImageUrl(form.get('url')) || findImageUrl(form.get('text')) || findImageUrl(form.get('title'));
    var now = Date.now();

    for (var i = 0; i < files.length; i++) {
      var id = MB.uid();
      await MB.put('items', { id: id, board: board, blob: files[i], src: link, t: now + i });
      ids.push(id);
    }

    if (!files.length && link) {
      var item = { id: MB.uid(), board: board, url: link, src: link, t: now };
      // Try to keep a real copy; many sites block this, then we keep the link.
      try {
        var r = await fetch(link, { mode: 'cors' });
        var type = r.headers.get('content-type') || '';
        if (r.ok && type.indexOf('image') === 0) item.blob = await r.blob();
      } catch (err) {}
      await MB.put('items', item);
      ids.push(item.id);
    }
    await MB.touch(board);
  } catch (err) {
    return Response.redirect('./?error=1', 303);
  }
  return Response.redirect('./?saved=' + ids.join(','), 303);
}
