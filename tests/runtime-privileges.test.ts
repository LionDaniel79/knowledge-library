import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";

it("provisions a runtime role that can save records but cannot erase history, administer roles, or read auth data", async () => {
  const { pg, db } = await testDatabase();
  try {
    await pg.exec(
      'CREATE SCHEMA neon_auth; CREATE TABLE neon_auth."user" (id text)',
    );
    await pg.exec(
      await readFile("db/operations/provision-web-runtime.sql", "utf8"),
    );
    const { rows: roles } = await pg.query(
      "SELECT rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='library_web_runtime'",
    );
    expect(roles).toEqual([
      {
        rolcanlogin: false,
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
      },
    ]);
    // SET SESSION AUTHORIZATION models a connection made by this role;
    // SET ROLE alone would retain the test administrator's session privileges.
    await pg.exec("SET SESSION AUTHORIZATION library_web_runtime");
    const store = createLibraryStore(db);
    const book = await store.mutate("test-owner", {
      requestId: randomUUID(),
      type: "addBook",
      payload: { title: "권한 검수 도서", formats: ["paper"] },
    });
    const note = await store.mutate("test-owner", {
      requestId: randomUUID(),
      type: "addNote",
      payload: {
        title: "내 기록",
        content: "기록과 이력을 보존한다.",
        kind: "thought",
        tags: [],
      },
    });
    expect(book.id).toBeTruthy();
    expect((await store.revisions("test-owner", note.id)).length).toBe(1);
    for (const sql of [
      "DELETE FROM library_books",
      "TRUNCATE library_books",
      "UPDATE library_revisions SET action='changed'",
      "DELETE FROM library_revisions",
      "CREATE TABLE public.not_allowed (id int)",
      "ALTER TABLE library_books ADD COLUMN not_allowed int",
      "CREATE ROLE unwanted_admin",
      "SET ROLE postgres",
      'SELECT * FROM neon_auth."user"',
    ])
      await expect(pg.exec(sql)).rejects.toThrow();
    expect((await store.revisions("test-owner", note.id)).length).toBe(1);
    await pg.exec("RESET SESSION AUTHORIZATION");
    // Fail safely on an existing identity rather than changing a role used elsewhere.
    await expect(
      pg.exec(
        await readFile("db/operations/provision-web-runtime.sql", "utf8"),
      ),
    ).rejects.toThrow();
    await pg.exec("ROLLBACK");
  } finally {
    await pg.close();
  }
}, 30000);
