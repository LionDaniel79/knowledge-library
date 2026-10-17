import { test, expect } from "@playwright/test";
test.afterEach(async ({ page, context }) => {
  if (process.env.PLAYWRIGHT_PRODUCTION !== "1") return;
  await context.setOffline(false);
  await page
    .evaluate(async () => {
      for (const r of await navigator.serviceWorker.getRegistrations())
        await r.unregister();
    })
    .catch(() => {});
  await page.goto("about:blank");
});
test("the production build prepares its actual public code, styles and fonts without caching session responses", async ({
  page,
}) => {
  test.skip(
    process.env.PLAYWRIGHT_PRODUCTION !== "1",
    "Requires the production build and its generated asset manifest",
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Google 계정으로 시작하기", exact: true }),
  ).toBeVisible();
  const manifestResponse = await page.request.get("/replica-shell.json");
  expect(manifestResponse.status()).toBe(200);
  const manifest = await manifestResponse.json();
  const paths = manifest.assets as string[];
  const root = await page.request.get("/");
  expect(root.headers()["x-library-public-shell"]).toBe("1");
  const failures = [];
  for (const path of paths) {
    const r = await page.request.get(path);
    if (
      r.status() !== 200 ||
      !/javascript|text\/css|font\//.test(r.headers()["content-type"] ?? "")
    )
      failures.push({
        path,
        status: r.status(),
        type: r.headers()["content-type"],
      });
  }
  expect(failures).toEqual([]);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const reg = await navigator.serviceWorker.getRegistration("/");
          if (!reg?.active) return false;
          const version = new URL(reg.active.scriptURL).searchParams.get(
            "build",
          );
          if (!version) return false;
          return !!(await (
            await caches.open("knowledge-library-shell-" + version)
          ).match("/"));
        }),
      { timeout: 30000 },
    )
    .toBe(true);
  const report = await page.evaluate(async () => {
    const manifest = await fetch("/replica-shell.json").then((r) => r.json()),
      cache = await caches.open("knowledge-library-shell-" + manifest.version),
      keys = await cache.keys(),
      html = await (await cache.match("/"))!.text();
    return {
      expected: manifest.assets.length,
      cached: keys.filter((r) =>
        new URL(r.url).pathname.startsWith("/_next/static/"),
      ).length,
      api: keys.filter((r) => new URL(r.url).pathname.startsWith("/api/"))
        .length,
      public:
        html.includes("ReplicaEntry") ||
        html.includes("기기 자료") ||
        html.includes("나의 지식서재"),
    };
  });
  expect(report.cached).toBe(report.expected);
  expect(report.api).toBe(0);
  expect(report.public).toBe(true);
  await page.context().setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Google 계정으로 시작하기", exact: true }),
  ).toBeVisible();
});
