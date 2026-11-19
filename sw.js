// Service worker: aplikacja działa offline; po deployu nowa wersja pobiera się sama (sieć najpierw, 3 s limitu).
const V = 'budynki-foto-v1'; // zmień przy każdej publikacji nowej wersji
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'config.js', 'manifest.webmanifest', 'logo.png', 'icon-192.png',
  'vendor/xlsx.full.min.js', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return; // Google API – bez ingerencji
  e.respondWith((async () => {
    const c = await caches.open(V);
    try {
      const r = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(rej, 3000))]);
      if (r.ok) c.put(req, r.clone());
      return r;
    } catch (_) {
      const m = await c.match(req, { ignoreSearch: true });
      return m || fetch(req);
    }
  })());
});
