// Offline-Unterstützung: App-Seite sofort aus dem Speicher – auch bei schlechtem Empfang im Studio kein Warten.
// Im Hintergrund wird die neueste Version geholt; ist sie anders, bekommt die Seite eine Nachricht („Neu laden“).
// Schriften und Symbole aus dem Speicher.
const CACHE = "trainingsplan-v57";
const CORE = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Die App ist eine einzige Seite: gespeichert und gelesen immer unter einem Schlüssel
const PAGE = "./index.html";
function cachedPage(req) {
  return caches.match(PAGE).then(r => r || caches.match(req, { ignoreSearch: true }));
}
// Neueste Seite holen, speichern und offene Fenster benachrichtigen, wenn sie sich geändert hat
function refresh(req, old) {
  const altP = old ? old.clone().text() : Promise.resolve(null); // sofort klonen, bevor der Browser die gespeicherte Seite liest
  return fetch(req).then(res => {
    if (!res || !res.ok) return res;
    const forText = res.clone(), forPage = res.clone(), forRoot = res.clone();
    return Promise.all([forText.text(), altP]).then(([neu, alt]) =>
      caches.open(CACHE).then(c => Promise.all([c.put(PAGE, forPage), c.put("./", forRoot)])).then(() => {
        if (alt !== null && neu !== alt) return self.clients.matchAll({ type: "window" }).then(L => L.forEach(cl => cl.postMessage({ type: "update" })));
      })).then(() => res);
  });
}
// Sofort aus dem Speicher; ohne gespeicherte Seite (erster Besuch) aus dem Netz
function staleWhileRevalidate(e, req) {
  const hitP = cachedPage(req), netP = hitP.then(hit => refresh(req, hit));
  e.waitUntil(netP.catch(() => {}));
  return hitP.then(hit => hit || netP.catch(() => Response.error()));
}

function cacheFirst(req) {
  return caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }));
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return; // Suche immer frisch aus dem Netz
  if (req.mode === "navigate" || (url.origin === location.origin && url.pathname.endsWith(".html"))) {
    e.respondWith(staleWhileRevalidate(e, req));
  } else if (url.origin === location.origin || url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(cacheFirst(req));
  }
});
