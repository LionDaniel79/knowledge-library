/** Explicit, resumable category organization of existing linked books only. */
import { Pool } from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { zoteroConnection } from "../src/server/zotero-connection";
import {
  categoryPath,
  collectionSpecs,
  membershipPatch,
  preservedBookData,
} from "../src/lib/zotero-organization";
import { syncHash } from "../src/lib/zotero-sync";
import {
  organizationRows,
  assertOrganizationUnchanged,
  saveOrganizationBatch,
} from "../src/server/zotero-organization-store";
const args = process.argv.slice(2),
  out = args[args.indexOf("--output") + 1],
  apply = args.includes("--apply");
if (!args.includes("--output") || !out || !isAbsolute(out))
  throw Error("새 비공개 결과 폴더를 --output으로 지정하세요.");
await mkdir(out); // Refuse to overwrite a previous audit.
const save = (name: string, value: unknown) =>
  writeFile(join(out, name + ".json"), JSON.stringify(value, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 1,
  connectionTimeoutMillis: 15000,
});
const db = await pool.connect();
let owner = "",
  locked = false;
try {
  owner = (
    await db.query(
      'SELECT id::text FROM neon_auth."user" WHERE lower(email)=lower($1)',
      [process.env.LIBRARY_OWNER_EMAIL],
    )
  ).rows[0]?.id;
  if (!owner) throw Error("서재 소유자 확인 필요");
  if (apply) {
    locked = (
      await db.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [
        "zotero-sync:" + owner,
      ])
    ).rows[0].locked;
    if (!locked) throw Error("다른 Zotero 작업이 진행 중입니다.");
  }
  const personal = async () => {
    const result: Record<string, string> = {};
    for (const table of ["library_notes", "library_cycles"])
      result[table] = syncHash(
        (
          await db.query(
            `SELECT to_jsonb(t) AS data FROM ${table} t WHERE owner_id=$1 ORDER BY id`,
            [owner],
          )
        ).rows,
      );
    return result;
  };
  const beforePersonal = await personal(),
    rows = await organizationRows(db, owner),
    remote = await zoteroConnection();
  if (!remote) throw Error("이 PC의 Zotero 연결이 필요합니다.");
  const existing = await remote.readCollections(),
    books = await remote.readOrganizationBooks();
  if (existing.version !== books.version)
    throw Error("Zotero 목록이 변경되었습니다. 다시 실행하세요.");
  let version = books.version;
  const items = new Map(books.items.map((i) => [i.key, i])),
    specs = collectionSpecs(
      remote.libraryId,
      rows.map((r) => categoryPath(r.category, r.classification)),
    );
  const existingMap = new Map(existing.items.map((c) => [c.key, c]));
  for (const s of specs) {
    const old = existingMap.get(s.key);
    if (
      old &&
      (old.data.name !== s.name ||
        old.data.parentCollection !== s.parentCollection)
    )
      throw Error("관리 컬렉션 이름/위치가 변경되었습니다. 직접 검토하세요.");
  }
  const targets = new Map(specs.map((s) => [JSON.stringify(s.path), s.key]));
  const targetFor = (r: (typeof rows)[number]) =>
    targets.get(JSON.stringify(categoryPath(r.category, r.classification)))!;
  for (const r of rows)
    if (
      !r.external_id.startsWith("users/" + remote.libraryId + "/") ||
      !items.has(r.external_id.split("/").at(-1)!)
    )
      throw Error("연결된 Zotero 항목이 누락되거나 다른 서재에 속합니다.");
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const path = categoryPath(r.category, r.classification)
      .slice(1)
      .join(" / ");
    counts[path] = (counts[path] ?? 0) + 1;
  }
  await save("before", {
    at: new Date().toISOString(),
    libraryId: remote.libraryId,
    libraryVersion: version,
    rows,
    books: books.items,
    collections: existing.items,
    personal: beforePersonal,
  });
  await save("preview", {
    scope: "existing-linked-book-collections-only",
    books: rows.length,
    categories: counts,
    collections: specs,
    createCollections: specs.filter((s) => !existingMap.has(s.key)).length,
  });
  if (!apply) {
    console.log(
      JSON.stringify({
        preview: true,
        books: rows.length,
        categories: counts,
        output: out,
      }),
    );
  } else {
    for (let depth = 1; depth <= 3; depth++) {
      const missing = specs.filter(
        (s) => s.path.length === depth && !existingMap.has(s.key),
      );
      if (!missing.length) continue;
      await save("collections-request-" + depth, { version, items: missing });
      const result = await remote.createCollections(missing, version);
      await save("collections-result-" + depth, result);
      version = result.version;
      for (const s of missing) {
        const actual = result.items.find((c) => c.key === s.key);
        if (
          !actual ||
          actual.data.name !== s.name ||
          actual.data.parentCollection !== s.parentCollection
        )
          throw Error("컬렉션 저장 검증 실패");
      }
    }
    let changed = 0,
      saved = 0;
    for (let offset = 0; offset < rows.length; offset += 50) {
      const expected = rows.slice(offset, offset + 50),
        batch = String(offset / 50 + 1).padStart(3, "0");
      await db.query("BEGIN");
      try {
        const current = await organizationRows(
          db,
          owner,
          expected.map((r) => r.book_id),
          true,
        );
        assertOrganizationUnchanged(expected, current);
        const requests = current
          .map((r) =>
            membershipPatch(
              items.get(r.external_id.split("/").at(-1)!)!,
              targetFor(r),
              r.snapshot.organization?.managedCollections ?? [],
            ),
          )
          .filter((p) => p !== null);
        if (requests.length) {
          await save("request-" + batch, { version, items: requests });
          const result = await remote.writeMemberships(requests, version);
          await save("result-" + batch, result);
          for (const i of result.items) {
            const original = items.get(i.key)!;
            const requested = requests.find((p) => p.key === i.key)!;
            if (
              !Array.isArray(i.data.collections) ||
              syncHash([...i.data.collections].sort()) !==
                syncHash([...requested.collections].sort()) ||
              syncHash(preservedBookData(i)) !==
                syncHash(preservedBookData(original))
            )
              throw Error("원격 분류 또는 기존 서지 보존 검증 실패");
            items.set(i.key, i);
          }
          version = result.version;
          changed += result.items.length;
        }
        const entries = current
          .map((row) => ({
            row,
            remote: items.get(row.external_id.split("/").at(-1)!)!,
            managedCollections: [targetFor(row)],
          }))
          .filter((e) => {
            const old = e.row.snapshot.organization;
            return (
              !old ||
              old.remoteVersion !== e.remote.version ||
              old.category !== e.row.category ||
              syncHash(old.classification) !== syncHash(e.row.classification) ||
              syncHash(old.managedCollections) !==
                syncHash(e.managedCollections)
            );
          });
        if (entries.length) {
          await saveOrganizationBatch(db, owner, entries);
          saved += entries.length;
        }
        await db.query("COMMIT");
        console.log(
          JSON.stringify({
            batch: Number(batch),
            processed: offset + current.length,
            total: rows.length,
            changed,
            saved,
          }),
        );
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      }
    }
    const final = await remote.readOrganizationBooks(),
      finalMap = new Map(final.items.map((i) => [i.key, i]));
    let classified = 0;
    for (const r of rows) {
      const key = r.external_id.split("/").at(-1)!,
        item = finalMap.get(key),
        before = books.items.find((i) => i.key === key)!;
      if (
        !item ||
        !item.data.collections.includes(targetFor(r)) ||
        syncHash(preservedBookData(item)) !==
          syncHash(preservedBookData(before))
      )
        throw Error("최종 분류/서지 보존 검증 실패");
      classified++;
    }
    const afterPersonal = await personal(),
      intact = syncHash(beforePersonal) === syncHash(afterPersonal);
    const result = {
      at: new Date().toISOString(),
      linkedBooks: rows.length,
      classified,
      changed,
      localLinksUpdated: saved,
      remoteBooksBefore: books.items.length,
      remoteBooksAfter: final.items.length,
      categories: counts,
      personalRecordsUnchanged: intact,
      newBooksCreated: 0,
      complete:
        intact &&
        classified === rows.length &&
        books.items.length === final.items.length,
    };
    await save("verification", result);
    console.log(JSON.stringify(result));
    if (!result.complete) throw Error("최종 검수 확인 필요");
  }
} catch (error) {
  await save("failure", {
    at: new Date().toISOString(),
    message: error instanceof Error ? error.message : "작업 실패",
  });
  throw error;
} finally {
  if (locked)
    await db.query("SELECT pg_advisory_unlock(hashtext($1))", [
      "zotero-sync:" + owner,
    ]);
  db.release();
  await pool.end();
}
