import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { createHash, randomUUID } from "node:crypto";
import {
  syncEntities,
  syncKey,
  type SyncEntity,
} from "../src/lib/replica/entities";
import {
  createSyncCursor,
  VALUE_PART_BYTES,
  type SyncRow,
} from "../src/lib/replica/contracts";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {openReplica} from './src/client/replica/indexed-db';import {bootstrapReplica} from './src/client/replica/bootstrap';import {createSyncTransport} from './src/client/replica/transport';import {readReplicaValue,resolveReplicaImage} from './src/client/replica/values';import {sha256Bytes} from './src/lib/replica/codec';window.replica={openReplica,bootstrapReplica,createSyncTransport,readReplicaValue,resolveReplicaImage,sha256Bytes};`,
        resolveDir: process.cwd(),
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
    })
  ).outputFiles[0].text;
});
test("downloads every entity, resumes saved pieces after closing, and reads complete data and images without the network", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const owner = "e2e-owner",
    epoch = randomUUID(),
    rows: SyncRow[] = [],
    values = new Map<string, Buffer>(),
    calls = new Map<string, number>(),
    hash = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
  let failed = false;
  for (const [name, def] of Object.entries(syncEntities)) {
    const entity = name as SyncEntity,
      value: Record<string, unknown> = Object.fromEntries(
        def.columns.map((c) => [c, null]),
      );
    for (const key of def.keys)
      value[key] = key === "year" ? 2026 : randomUUID();
    if (entity === "library_imports")
      value.original_data = { text: "한글🙂".repeat(430000) };
    if (entity === "library_cover_assets") {
      value.data_base64 = "YWJj".repeat(90000);
      value.mime = "image/webp";
    }
    const bytes = Buffer.from(JSON.stringify(value)),
      key = syncKey(entity, value),
      row: SyncRow = {
        entity,
        key,
        revision: "1",
        deleted: false,
        sha256: hash(bytes),
        bytes: bytes.length,
      };
    if (bytes.length < 8192) row.inline = bytes.toString("utf8");
    else
      row.parts = Array.from(
        { length: Math.ceil(bytes.length / VALUE_PART_BYTES) },
        (_, index) => {
          const part = bytes.subarray(
            index * VALUE_PART_BYTES,
            (index + 1) * VALUE_PART_BYTES,
          );
          return { index, bytes: part.length, sha256: hash(part) };
        },
      );
    rows.push(row);
    values.set(entity, bytes);
  }
  await page.route("https://replica.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<html><body>download fixture</body></html>",
    }),
  );
  await page.route("https://replica.test/api/sync/**", (r) => {
    const u = new URL(r.request().url()),
      kind = u.pathname.split("/").at(-1),
      p = u.searchParams;
    if (kind === "meta")
      return r.fulfill({
        json: {
          epoch,
          head: "1",
          floor: "0",
          protocol: 1,
          totalRows: rows.length,
          totalBytes: rows.reduce((n, v) => n + v.bytes, 0),
          entities: Object.fromEntries(
            rows.map((v) => [v.entity, { rows: 1, bytes: v.bytes }]),
          ),
        },
      });
    if (kind === "scan") {
      const entity = p.get("entity")!,
        found = rows.filter((v) => v.entity === entity);
      return r.fulfill({
        json: {
          epoch,
          head: "1",
          rows: found,
          cursor: createSyncCursor({
            owner,
            epoch,
            after: "1",
            entity: entity as SyncEntity,
            key: found[0].key,
          }),
          hasMore: false,
        },
      });
    }
    if (kind === "changes")
      return r.fulfill({
        json: {
          epoch,
          head: "1",
          rows: [],
          cursor: createSyncCursor({ owner, epoch, after: "1" }),
          hasMore: false,
        },
      });
    if (kind === "coverage")
      return r.fulfill({
        json: {
          epoch,
          head: "1",
          entities: Object.fromEntries(
            rows.map((v) => [
              v.entity,
              { rows: 1, sha256: hash(v.key + "\t" + v.sha256 + "\n") },
            ]),
          ),
        },
      });
    const entity = p.get("entity")!,
      index = Number(p.get("index")),
      key = entity + ":" + index;
    calls.set(key, (calls.get(key) ?? 0) + 1);
    if (entity === "library_imports" && index === 3 && !failed) {
      failed = true;
      return r.fulfill({ status: 503, json: { error: "network down" } });
    }
    return r.fulfill({
      contentType: "application/octet-stream",
      body: values
        .get(entity)!
        .subarray(index * VALUE_PART_BYTES, (index + 1) * VALUE_PART_BYTES),
    });
  });
  await page.goto("https://replica.test/");
  await page.addScriptTag({ content: bundle });
  expect(
    await page.evaluate(async () => {
      const api = (window as any).replica,
        s = await api.openReplica("e2e-owner");
      try {
        await api.bootstrapReplica({
          owner: s.owner,
          storage: s,
          transport: api.createSyncTransport(),
        });
        return false;
      } catch {
        const cp = await s.checkpoint();
        s.close();
        return cp === null;
      }
    }),
  ).toBe(true);
  const first = calls.get("library_imports:0");
  await page.reload();
  await page.addScriptTag({ content: bundle });
  expect(
    await page.evaluate(async () => {
      const api = (window as any).replica,
        s = await api.openReplica("e2e-owner");
      const cp = await api.bootstrapReplica({
        owner: s.owner,
        storage: s,
        transport: api.createSyncTransport(),
      });
      s.close();
      return cp.complete;
    }),
  ).toBe(true);
  expect(calls.get("library_imports:0")).toBe(first);
  await page.unroute("https://replica.test/api/sync/**");
  await page.route("https://replica.test/api/**", (r) => r.abort());
  await context.setOffline(true);
  await page.reload();
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(
    async (expected) => {
      const api = (window as any).replica,
        s = await api.openReplica("e2e-owner"),
        checks = [];
      for (const item of expected) {
        const row = await s.readRow(item.entity, item.key);
        checks.push({
          entity: item.entity,
          sha256: await api.sha256Bytes(await api.readReplicaValue(s, row)),
        });
      }
      const image = await api.resolveReplicaImage(
        s,
        JSON.parse(
          expected.find((r) => r.entity === "library_cover_assets")!.key,
        )[0],
      );
      s.close();
      return { checks, imageBytes: image.size };
    },
    rows.map((r) => ({ entity: r.entity, key: r.key })),
  );
  expect(result.checks).toEqual(
    rows.map((r) => ({ entity: r.entity, sha256: r.sha256 })),
  );
  expect(result.imageBytes).toBe(270000);
});
