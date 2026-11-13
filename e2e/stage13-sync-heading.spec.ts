import { build } from "esbuild";
import { expect, test } from "@playwright/test";

let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import React from 'react';import{createRoot}from'react-dom/client';import{SyncButton,SyncSummary}from'./src/components/replica/sync-button';createRoot(document.getElementById('root')).render(<div className="main-content"><div className="page-heading"><h1>나의 서재</h1><div className="heading-actions"><SyncButton onError={()=>{}}/><button className="primary">책 추가</button><SyncSummary/></div></div><p id="below">기존 화면</p></div>);`,
        loader: "tsx",
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [
        {
          name: "isolated-status",
          setup(b) {
            b.onResolve({ filter: /^\.\/provider$/ }, (a) =>
              a.importer.endsWith("sync-button.tsx")
                ? { path: "provider", namespace: "status-fixture" }
                : undefined,
            );
            b.onLoad({ filter: /.*/, namespace: "status-fixture" }, () => ({
              contents: `import{useSyncExternalStore}from'react';export function useReplicaOptional(){return useSyncExternalStore(window.subscribe,window.snapshot,window.snapshot)}`,
              resolveDir: process.cwd(),
            }));
          },
        },
      ],
    })
  ).outputFiles[0].text;
});

for (const width of [1280, 390, 320])
  test(`sync heading keeps geometry and one busy label at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route("https://sync-heading.test/", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
      }),
    );
    await page.goto("https://sync-heading.test/");
    await page.evaluate(() => {
      const w = window as any;
      const listeners = new Set<() => void>();
      w.subscribe = (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      };
      w.calls = 0;
      w.value = {
        ready: true,
        authRequired: false,
        runtime: {
          sync: () => {
            w.calls++;
            w.setPhase("preparing");
            return new Promise(() => {});
          },
        },
        status: {
          phase: "idle",
          rows: 0,
          bytes: 0,
          remaining: 0,
          pending: 0,
          conflicts: 0,
          failed: 0,
          lastSyncedAt: null,
          error: "",
        },
      };
      w.snapshot = () => w.value;
      w.setPhase = (phase: string) => {
        w.value = {
          ...w.value,
          status: {
            ...w.value.status,
            phase,
            rows: 170000,
            upload: { processed: 9000, total: 170000 },
          },
        };
        listeners.forEach((fn) => fn());
      };
    });
    await page.addStyleTag({ path: "src/app/globals.css" });
    await page.addScriptTag({ content: bundle });
    const button = page.getByRole("button", { name: "동기화", exact: true });
    const geometry = () =>
      page.evaluate(() =>
        [".sync-button", ".heading-actions > .primary", "#below"].map((s) => {
          const r = document.querySelector(s)!.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        }),
      );
    await expect(button).toBeEnabled();
    const initial = await geometry();
    await button.click();
    for (const phase of [
      "preparing",
      "downloading",
      "checking",
      "pulling",
      "pushing",
      "complete",
      "error",
      "offline",
      "idle",
    ]) {
      await page.evaluate((p) => (window as any).setPhase(p), phase);
      const busy = [
        "preparing",
        "downloading",
        "checking",
        "pulling",
        "pushing",
      ].includes(phase);
      await expect(button).toHaveText(busy ? "동기화 중" : "동기화");
      expect(await geometry()).toEqual(initial);
      if (busy) {
        await expect(button).toBeDisabled();
        await expect(page.getByText("동기화 중", { exact: true })).toHaveCount(
          1,
        );
      }
    }
    expect(await page.evaluate(() => (window as any).calls)).toBe(1);
    await expect(page.getByRole("status")).toContainText("기기에 저장됨");
    await expect(page.locator("body")).not.toContainText(
      "다른 메뉴를 사용해도 계속 동기화합니다.",
    );
    await page.evaluate(() => {
      const w = window as any;
      w.value = {
        ...w.value,
        authRequired: true,
        status: { ...w.value.status, error: "로그인이 필요합니다." },
      };
      w.setPhase("error");
    });
    await expect(
      page.getByRole("link", { name: "로그인", exact: true }),
    ).toBeVisible();
    await expect(button).toHaveAttribute("title", "로그인이 필요합니다.");
    expect(await geometry()).toEqual(initial);
  });
