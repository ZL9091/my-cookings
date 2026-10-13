// Bump this version whenever you change index.html.
const CACHE = 'my-cookings-v6';
const ASSETS = ['./', './index.html', './app.js', './config.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png', './avatar.webp'];
const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const SDK = ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'].map(f => FB + f);

self.addEventListener('install', e => {
  // cache:'reload' skips the browser's HTTP cache so we always store the newest files.
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.all([
      ...ASSETS.map(u => fetch(new Request(u, { cache: 'reload' })).then(r => c.put(u, r))),
      ...SDK.map(u => fetch(u, { mode: 'cors' }).then(r => r.ok && c.put(u, r)).catch(() => {}))
    ])));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Opening the app: try the internet first (always fresh), fall back to the saved copy when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); }
      return res;
    }).catch(() => caches.match('./index.html')));
    return;
  }

  // Other app files (icons, manifest): saved copy first, refresh in the background.
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => {
      const net = fetch(req, { cache: 'no-cache' }).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    }));
    return;
  }

  // Fonts and the sync library: keep a copy after the first online visit.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com' ||
      (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'))) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); c.put(req, res.clone()); return res; }
      catch { return Response.error(); }
    }));
  }
});
