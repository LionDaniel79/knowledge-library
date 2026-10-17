// This cache holds anonymous app code only. All private data stays in IndexedDB.
const VERSION =
  new URL(self.location.href).searchParams.get("build") || "development";
const CACHE = "knowledge-library-shell-" + VERSION;
const PUBLIC = [
  "/offline.html",
  "/offline.js",
  "/offline.css",
  "/library-icon.svg",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const path of PUBLIC) await cache.put(path, await publicFetch(path));
      const manifestResponse = await publicFetch("/replica-shell.json");
      if (!manifestResponse.ok) {
        if (VERSION === "development") return;
        throw Error("App code manifest unavailable");
      }
      const manifest = await manifestResponse.json();
      if (
        manifest.version !== VERSION ||
        !Array.isArray(manifest.assets) ||
        manifest.assets.length > 1500 ||
        manifest.assets.some((path) => !safeAsset(path))
      )
        throw Error("Invalid public app manifest");
      const shell = await publicFetch("/");
      if (
        !shell.ok ||
        shell.redirected ||
        shell.headers.get("X-Library-Public-Shell") !== "1"
      )
        throw Error("The entry is not an anonymous public shell");
      const html = await shell.clone().text();
      for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
        const path = match[1].replace(/&amp;/g, "&"),
          assetUrl = new URL(path, self.location.origin);
        if (
          assetUrl.pathname.startsWith("/_next/static/") &&
          !manifest.assets.some(
            (asset) =>
              decodeURIComponent(
                new URL(asset, self.location.origin).pathname,
              ) === decodeURIComponent(assetUrl.pathname),
          )
        )
          throw Error("The app entry changed during installation");
      }
      let cursor = 0;
      const download = async () => {
        while (cursor < manifest.assets.length) {
          const path = manifest.assets[cursor++];
          if (await cache.match(path)) continue;
          const response = await publicFetch(path);
          if (!response.ok || response.redirected || !assetType(response))
            throw Error("App asset unavailable");
          await cache.put(path, response);
        }
      };
      await Promise.all([download(), download()]);
      await cache.put("/", shell);
      await cache.put(
        "/replica-shell.json",
        new Response(JSON.stringify(manifest), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      // No skipWaiting: an update never replaces an open form or reloads a tab.
    })(),
  );
});
function publicFetch(path) {
  return fetch(
    new Request(new URL(path, self.location.origin), {
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    }),
  );
}
function safeAsset(path) {
  if (typeof path !== "string") return false;
  try {
    const url = new URL(path, self.location.origin),
      decoded = decodeURIComponent(url.pathname);
    return (
      url.origin === self.location.origin &&
      !url.search &&
      !url.hash &&
      /^\/_next\/static\/[a-zA-Z0-9_./\[\]-]+$/.test(decoded) &&
      !decoded.split("/").some((part) => part === "." || part === "..")
    );
  } catch {
    return false;
  }
}
function assetType(response) {
  return /javascript|text\/css|font\//.test(
    response.headers.get("Content-Type") || "",
  );
}
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (k) =>
                k.startsWith("knowledge-library-offline-") ||
                (k.startsWith("knowledge-library-shell-") && k !== CACHE),
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
  if (
    url.pathname.startsWith("/api/") ||
    url.searchParams.has("neon_auth_session_verifier") ||
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/connect/")
  )
    return;
  const asset =
    safeAsset(url.pathname) &&
    [...url.searchParams.keys()].every((key) => key === "dpl");
  if ((PUBLIC.includes(url.pathname) && !url.search) || asset) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const key = asset ? decodeURIComponent(url.pathname) : event.request;
        const hit = await cache.match(key, { ignoreVary: asset });
        if (hit) return hit;
        const response = await fetch(event.request);
        if (response.ok && !response.redirected && asset && assetType(response))
          await cache.put(key, response.clone());
        return response;
      }),
    );
    return;
  }
  if (
    event.request.mode === "navigate" &&
    url.pathname === "/" &&
    [...url.searchParams.keys()].every((key) =>
      ["view", "operations"].includes(key),
    )
  )
    event.respondWith(
      caches
        .open(CACHE)
        .then(
          async (cache) =>
            (await cache.match("/")) ||
            (await fetch(event.request).catch(
              async () =>
                (await cache.match("/offline.html")) || Response.error(),
            )),
        ),
    );
});
