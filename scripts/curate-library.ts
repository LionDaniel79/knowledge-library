import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import {
  buildCurationInventory,
  selectCurationSample,
  type InventoryManifest,
} from "../src/local/curation/inventory";
import {
  applyValidated,
  validateCurationItems,
} from "../src/local/curation/validate";
import { createCurationStore } from "../src/server/curation-store";
import type { Database } from "../src/server/library-store";
const args = process.argv.slice(2),
  action = args[0],
  arg = (name: string) => args[args.indexOf(name) + 1];
const run = args.includes("--run")
  ? arg("--run")
  : new Date().toISOString().replace(/[:.]/g, "-");
if (!/^[a-zA-Z0-9_-]+$/.test(run)) throw Error("실행 이름을 확인해 주세요.");
const dir = resolve("private-data/curation", run);
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
  max: 1,
});
const db: Database = {
  query: (s, p = []) => pool.query(s, p),
  transaction: async (fn) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn({ query: (s, p = []) => c.query(s, p) });
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  },
};
try {
  const owner = (
    await pool.query(
      'SELECT id::text FROM neon_auth."user" WHERE lower(email)=lower($1)',
      [process.env.LIBRARY_OWNER_EMAIL],
    )
  ).rows[0]?.id;
  if (!owner) throw Error("서재 소유자를 확인할 수 없습니다.");
  await mkdir(dir, { recursive: true });
  if (action === "inventory") {
    const inv = await buildCurationInventory(db, {
      owner,
      pdfRoot: "E:/전자도서관",
      outputDir: dir,
      indexPath: process.env.LIBRARY_PDF_INDEX,
    });
    console.log(
      JSON.stringify({ counts: inv.counts, snapshotHash: inv.snapshotHash }),
    );
  } else {
    const inv = JSON.parse(
      await readFile(resolve(dir, "inventory.json"), "utf8"),
    ) as InventoryManifest;
    if (inv.owner !== owner) throw Error("자료 소유자 불일치");
    if (action === "sample") {
      const sample = selectCurationSample(inv);
      await writeFile(
        resolve(dir, "sample.json"),
        JSON.stringify(sample, null, 2),
        { flag: "wx", mode: 0o600 },
      );
      console.log(
        JSON.stringify({
          groups: sample.groups,
          humanReview: sample.humanReview,
        }),
      );
    } else if (action === "validate" || action === "apply") {
      const items = JSON.parse(
        await readFile(resolve(dir, "items.json"), "utf8"),
      );
      let runId: string | undefined;
      try {
        runId = (await readFile(resolve(dir, "run-id.txt"), "utf8")).trim();
      } catch {}
      const result =
        action === "validate"
          ? validateCurationItems(items, inv)
          : await applyValidated(db, owner, inv, items, {
              apply: args.includes("--apply"),
              runId,
            });
      if ("runId" in result && result.runId)
        await writeFile(resolve(dir, "run-id.txt"), result.runId, {
          mode: 0o600,
        });
      await writeFile(
        resolve(dir, "validation.json"),
        JSON.stringify(result, null, 2),
        { mode: 0o600 },
      );
      console.log(
        JSON.stringify({
          valid: Array.isArray(result.valid)
            ? result.valid.length
            : result.valid,
          rejected: result.rejected.length,
          ...("applied" in result
            ? { applied: result.applied, dryRun: result.dryRun }
            : {}),
        }),
      );
    } else if (action === "rollback" || action === "seal") {
      const id = (await readFile(resolve(dir, "run-id.txt"), "utf8")).trim();
      if (!args.includes("--apply"))
        console.log(JSON.stringify({ dryRun: true, action }));
      else {
        const store = createCurationStore(db);
        console.log((await store[action](owner, id)) ?? { sealed: true });
      }
    } else
      throw Error(
        "inventory, sample, validate, apply, rollback, seal 중 하나를 선택하세요.",
      );
  }
} finally {
  await pool.end();
}
