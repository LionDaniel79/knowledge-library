import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import {
  verifiedCurationOwner,
  reviewedIdentityBook,
} from "../src/local/curation/owner";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
  await f.pg.exec(
    'CREATE SCHEMA neon_auth; CREATE TABLE neon_auth."user"(id text,email text,"emailVerified" boolean);',
  );
  await f.db.query(
    'INSERT INTO neon_auth."user" VALUES($1,$2,true),($3,$4,false)',
    [
      "curation-owner",
      "owner@example.test",
      "unverified",
      "unverified@example.test",
    ],
  );
});
afterAll(async () => f.pg.close());
it("pins reviewed samples to the configured verified owner and cannot adopt a foreign book owner", async () => {
  const owner = await verifiedCurationOwner(f.db, "OWNER@example.test");
  expect(owner).toBe("curation-owner");
  for (const email of [
    undefined,
    "",
    "absent@example.test",
    "unverified@example.test",
  ])
    await expect(verifiedCurationOwner(f.db, email)).rejects.toThrow();
  const store = createLibraryStore(f.db);
  for (const who of [owner, "foreign"]) {
    const book = await store.mutate(who, {
      requestId: randomUUID(),
      type: "addBook",
      payload: { title: "검수 표본", formats: ["pdf"] },
    });
    const found = await reviewedIdentityBook(f.db, owner, book.id!);
    if (who === owner) expect(found?.id).toBe(book.id);
    else expect(found).toBeNull();
  }
});
