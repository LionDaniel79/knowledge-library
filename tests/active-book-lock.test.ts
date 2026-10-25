import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./helpers/database";
import { ownRow } from "../src/server/thought-map-store";
import { readCurationSource } from "../src/server/curation-store";

let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
  await f.pg.exec(
    await readFile("db/operations/provision-web-runtime.sql", "utf8"),
  );
  await f.pg.exec("SET SESSION AUTHORIZATION library_web_runtime");
});
afterAll(async () => {
  await f?.pg.close();
});

it.each(["topic", "curation"])(
  "locks book sources for %s with restricted runtime permissions and excludes other owners and excluded books",
  async (consumer) => {
    const owner = randomUUID(),
      id = randomUUID();
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,'내 도서',ARRAY['paper'])",
      [id, owner],
    );
    const read = (forOwner: string) =>
      consumer === "topic"
        ? ownRow(f.db, "library_active_books", forOwner, id, true)
        : readCurationSource(
            f.db,
            forOwner,
            { kind: "book", id, version: "1" },
            true,
          );
    expect(await read(owner)).toMatchObject(
      consumer === "topic"
        ? { id, version: 1 }
        : { text: "내 도서", version: "1" },
    );
    await expect(read("other-owner")).rejects.toMatchObject({ status: 404 });
    await f.db.query(
      "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id) VALUES($1,$2,'periodical','도서 목록 제외',$3)",
      [id, owner, randomUUID()],
    );
    await expect(read(owner)).rejects.toMatchObject({ status: 404 });
  },
);
