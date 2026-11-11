import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
it("prepares only a versioned anonymous public shell and assets, and never caches auth or API responses", async () => {
  const origin = "https://shell.test",
    saved = new Map<string, Response>(),
    handlers: Record<string, any> = {},
    calls: { path: string; credentials?: string }[] = [];
  const fetcher = async (input: any, init: any = {}) => {
    const req =
        input instanceof Request
          ? input
          : new Request(new URL(input, origin), init),
      p = new URL(req.url).pathname;
    calls.push({ path: p, credentials: req.credentials });
    if (p === "/replica-shell.json")
      return Response.json({
        version: "test-build",
        assets: [
          "/_next/static/main.js",
          "/_next/static/chunks/app/api/auth/[...path]/route.js",
        ],
      });
    if (p === "/")
      return new Response('<script src="/_next/static/main.js"></script>', {
        headers: { "Content-Type": "text/html", "X-Library-Public-Shell": "1" },
      });
    return new Response("public code", {
      headers: { "Content-Type": "application/javascript" },
    });
  };
  const cache = {
    put: async (input: any, response: Response) => {
      saved.set(
        new URL(typeof input === "string" ? input : input.url, origin).href,
        response,
      );
    },
    match: async (input: any) =>
      saved.get(
        new URL(typeof input === "string" ? input : input.url, origin).href,
      ),
    addAll: async (paths: string[]) => {
      for (const p of paths) await cache.put(p, await fetcher(p));
    },
  };
  const context = {
    self: {
      location: new URL(origin + "/sw.js?build=test-build"),
      addEventListener: (type: string, fn: any) => {
        handlers[type] = fn;
      },
    },
    caches: {
      open: async () => cache,
      keys: async () => [],
      match: cache.match,
      delete: async () => true,
    },
    fetch: fetcher,
    URL,
    Request,
    Response,
    Set,
    Promise,
  };
  runInNewContext(await readFile("public/sw.js", "utf8"), context);
  let pending: Promise<any>;
  handlers.install({
    waitUntil: (p: Promise<any>) => {
      pending = p;
    },
  });
  await pending!;
  expect(saved.has(origin + "/")).toBe(true);
  expect(calls.find((c) => c.path === "/")?.credentials).toBe("omit");
  expect(saved.has(origin + "/_next/static/main.js")).toBe(true);
  let handled = false;
  handlers.fetch({
    request: new Request(origin + "/api/library"),
    respondWith: () => {
      handled = true;
    },
  });
  expect(handled).toBe(false);
  handlers.fetch({
    request: new Request(origin + "/?neon_auth_session_verifier=private"),
    respondWith: () => {
      handled = true;
    },
  });
  expect(handled).toBe(false);
  expect(
    [...saved.keys()].some(
      (k) => new URL(k).pathname.startsWith("/api/") || k.includes("verifier"),
    ),
  ).toBe(false);
});
