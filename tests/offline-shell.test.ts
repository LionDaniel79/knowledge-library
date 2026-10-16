import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { readDrafts, offlineOwnerKey } from "../src/lib/offline-drafts";
import { randomUUID } from "node:crypto";
it("the standalone offline page writes a valid draft without sending it to a server", async () => {
  const values = new Map<string, string>([[offlineOwnerKey, "one"]]),
    events: Record<string, Function> = {},
    status = { textContent: "" },
    form = {
      hidden: false,
      reset: () => {},
      addEventListener: (name: string, fn: Function) => {
        events[name] = fn;
      },
    };
  const localStorage = {
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i],
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => values.delete(k),
  };
  runInNewContext(await readFile("public/offline.js", "utf8"), {
    localStorage,
    document: {
      getElementById: (id: string) => (id === "status" ? status : form),
    },
    crypto: { randomUUID },
    FormData: class {
      get(k: string) {
        return k === "title" ? "생각 제목" : "네트워크 없이 쓴 문장";
      }
    },
  });
  events.submit({ preventDefault() {} });
  expect(status.textContent).toContain("임시 저장했습니다");
  expect(
    readDrafts(localStorage as any, "one")[0].command.payload.content,
  ).toBe("네트워크 없이 쓴 문장");
});
it("the service worker caches only public offline assets and never intercepts authenticated APIs or PDF files", async () => {
  const events: Record<string, Function> = {},
    cached: string[][] = [];
  let responded = false;
  runInNewContext(await readFile("public/sw.js", "utf8"), {
    URL,
    self: {
      location: { origin: "https://library.test" },
      addEventListener: (n: string, fn: Function) => {
        events[n] = fn;
      },
    },
    caches: {
      open: async () => ({ addAll: async (p: string[]) => cached.push(p) }),
      match: async () => ({ offline: true }),
    },
    fetch: async () => {
      throw Error("offline");
    },
  });
  await new Promise<void>((resolve, reject) =>
    events.install({
      waitUntil: (p: Promise<any>) => p.then(() => resolve(), reject),
    }),
  );
  expect(cached.flat()).toEqual([
    "/offline.html",
    "/offline.js",
    "/offline.css",
    "/library-icon.svg",
  ]);
  for (const path of [
    "/api/library",
    "/api/pdf/abc/file",
    "/api/auth/get-session",
  ])
    events.fetch({
      request: {
        method: "GET",
        url: "https://library.test" + path,
        mode: "cors",
      },
      respondWith: () => {
        responded = true;
      },
    });
  expect(responded).toBe(false);
  const fallback = await new Promise((resolve) =>
    events.fetch({
      request: {
        method: "GET",
        url: "https://library.test/",
        mode: "navigate",
      },
      respondWith: resolve,
    }),
  );
  expect(fallback).toEqual({ offline: true });
});
