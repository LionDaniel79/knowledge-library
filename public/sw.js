// Cache only the public offline composer. Authenticated HTML, API data and PDFs
// always use the network and are never written to the service-worker cache.
const CACHE = "knowledge-library-offline-v1";
const PUBLIC = [
  "/offline.html",
  "/offline.js",
  "/offline.css",
  "/library-icon.svg",
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PUBLIC)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (k) => k.startsWith("knowledge-library-offline-") && k !== CACHE,
            )
            .map((k) => caches.delete(k)),
        ),
      ),
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin)
    return;
  if (PUBLIC.includes(url.pathname) && !url.search) {
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request)),
    );
    return;
  }
  if (event.request.mode === "navigate" && !url.pathname.startsWith("/api/"))
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/offline.html")),
    );
});
