// ─── KKTR SERVICE WORKER v9 ───────────────────────────────────────────────────
// Caches the entire app shell so it loads even with zero network

const CACHE_NAME = "kktr-v9-shell";
const RUNTIME_CACHE = "kktr-v9-runtime";

// App shell — everything needed to boot the app offline
const SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/favicon.ico",
  "/logo192.png",
  "/logo512.png"
];

// ─── INSTALL: cache app shell ─────────────────────────────────────────────────
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(SHELL_URLS).catch(err => {
        // Don't fail install if some assets are missing — cache what we can
        console.log("SW: partial cache", err.message);
      });
    }).then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE: clean old caches ───────────────────────────────────────────────
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== RUNTIME_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── FETCH: serve from cache, fall back to network ───────────────────────────
self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and Firebase API calls (let Firestore SDK handle those)
  if (request.method !== "GET") return;
  if (url.hostname.includes("firestore.googleapis.com")) return;
  if (url.hostname.includes("firebase.googleapis.com")) return;
  if (url.hostname.includes("identitytoolkit.googleapis.com")) return;
  if (url.hostname.includes("securetoken.googleapis.com")) return;
  if (url.hostname.includes("firebasestorage.googleapis.com")) return;

  // Navigation requests (page loads) — serve index.html from cache
  if (request.mode === "navigate") {
    event.respondWith(
      caches.match("/index.html").then(cached => {
        return cached || fetch(request).catch(() => caches.match("/index.html"));
      })
    );
    return;
  }

  // JS/CSS/fonts/images — cache first, then network
  if (
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".jpg") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".ico") ||
    url.pathname.endsWith(".woff2") ||
    url.hostname.includes("cdnjs.cloudflare.com")
  ) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached;
          return fetch(request).then(response => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          }).catch(() => cached); // return stale cache on network error
        })
      )
    );
    return;
  }

  // Everything else — network first, cache fallback
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(RUNTIME_CACHE).then(c => c.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

// ─── BACKGROUND SYNC (when connection returns) ────────────────────────────────
self.addEventListener("sync", event => {
  if (event.tag === "kktr-sync") {
    event.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(client =>
          client.postMessage({ type: "SYNC_NOW" })
        );
      })
    );
  }
});
