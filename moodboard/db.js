// Shared storage layer (used by the page and the service worker).
// Everything lives on the phone in IndexedDB "moodboard":
//   items  : {id, board, blob?, url?, src?, t}
//   boards : {id, name, t}   (t = last used, for ordering)
//   meta   : 'active' -> board id that new shares go to
var MB = (function () {
  var _db;
  function idb() {
    return _db || (_db = new Promise(function (res, rej) {
      var r = indexedDB.open('moodboard', 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        d.createObjectStore('items', { keyPath: 'id' }).createIndex('board', 'board');
        d.createObjectStore('boards', { keyPath: 'id' });
        d.createObjectStore('meta');
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    }));
  }
  function p(r) {
    return new Promise(function (a, b) { r.onsuccess = function () { a(r.result); }; r.onerror = function () { b(r.error); }; });
  }
  async function st(name, mode) { return (await idb()).transaction(name, mode || 'readonly').objectStore(name); }

  var api = {
    uid: function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); },
    get: async function (s, k) { return p((await st(s)).get(k)); },
    put: async function (s, v, k) { return p((await st(s, 'readwrite')).put(v, k)); },
    del: async function (s, k) { return p((await st(s, 'readwrite')).delete(k)); },
    all: async function (s) { return p((await st(s)).getAll()); },
    byBoard: async function (b) {
      var list = await p((await st('items')).index('board').getAll(b));
      return list.sort(function (x, y) { return y.t - x.t; });
    },
    boards: async function () {
      var list = await api.all('boards');
      return list.sort(function (x, y) { return y.t - x.t; });
    },
    newBoard: async function (name) {
      var b = { id: api.uid(), name: name, t: Date.now(), c: Date.now() };
      await api.put('boards', b);
      return b;
    },
    touch: async function (id) {
      var b = await api.get('boards', id);
      if (b) { b.t = Date.now(); await api.put('boards', b); }
    },
    active: async function () {
      var a = await api.get('meta', 'active');
      var list = await api.boards();
      if (!a || !list.some(function (x) { return x.id === a; })) {
        a = list.length ? list[0].id : (await api.newBoard('inbox')).id;
        await api.put('meta', a, 'active');
      }
      return a;
    },
    setActive: async function (id, when) {
      await api.put('meta', id, 'active');
      await api.put('meta', when || Date.now(), 'activeT');
      await api.touch(id);
    },
    move: async function (ids, board) {
      for (var i = 0; i < ids.length; i++) {
        var it = await api.get('items', ids[i]);
        if (it) { it.board = board; await api.put('items', it); }
      }
      await api.touch(board);
    }
  };
  return api;
})();
