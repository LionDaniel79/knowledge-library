import { beforeAll, afterAll, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { types } from "pg";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createLibraryStore, type Database } from "../src/server/library-store";
import {
  createThoughtMapStore,
  currentRecord,
  dto,
} from "../src/server/thought-map-store";
import {
  createThoughtJobStore,
  sourceVersion,
} from "../src/server/thought-job-store";
import { createRemoteTransport } from "../src/local/thought-map/remote-transport";
let pg: PGlite, db: Database;
const config = { modelDigest: "m", promptVersion: "1", retrievalVersion: "1" };
const cmd = (type: string, payload: unknown) => ({
  requestId: randomUUID(),
  type,
  payload,
});
beforeAll(async () => {
  pg = new PGlite();
  for (const f of [
    "001_library",
    "002_ireaditnow",
    "003_reading_history",
    "004_pdf_library",
    "005_knowledge",
    "006_catalog",
    "007_thought_map",
    "008_thought_jobs",
    "017_note_trash",
    "025_book_exclusions",
  ])
    await pg.exec(await readFile(`db/${f}.sql`, "utf8"));
  db = {
    query: (s, p = []) => pg.query(s, p),
    transaction: (fn) =>
      pg.transaction((tx) => fn({ query: (s, p = []) => tx.query(s, p) })),
  };
});
afterAll(async () => {
  await pg?.close();
});
it("preserves the pg DATE calendar day instead of converting midnight to UTC", () => {
  expect(
    dto({ occurred_on: types.getTypeParser(1082)("2026-10-13") }).occurredOn,
  ).toBe("2026-10-13");
  expect(dto({ occurred_on: "2026-10-13" }).occurredOn).toBe("2026-10-13");
});
it("preserves confirmed days on both Seoul and UTC hosts", () => {
  for (const tz of ["Asia/Seoul", "UTC"]) {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        "import {types} from 'pg'; import {dto} from './src/server/thought-map-store.ts'; console.log(dto({occurred_on:types.getTypeParser(1082)('2026-10-13')}).occurredOn);",
      ],
      { env: { ...process.env, TZ: tz }, encoding: "utf8" },
    );
    expect(output.trim()).toBe("2026-10-13");
  }
});
it("pages a large corpus and includes remote book/document mappings without candidate bodies", async () => {
  const owner = "paged",
    library = createLibraryStore(db),
    jobs = createThoughtJobStore(db, { legacyDiagnostics: true });
  const ids = [];
  for (let i = 0; i < 12; i++)
    ids.push(
      (
        await library.mutate(
          owner,
          cmd("addNote", {
            title: "기록",
            content: "정서 ".repeat(8000),
            kind: "thought",
          }),
        )
      ).id!,
    );
  const book = (
    await library.mutate(
      owner,
      cmd("addBook", {
        title: "정서의 책",
        author: "저자",
        formats: ["paper"],
        status: "unread",
        tags: [],
      }),
    )
  ).id!;
  const documentId = randomUUID();
  await db.query(
    "INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns) VALUES($1,$2,$3,$4,$5,$6,1,$7)",
    [documentId, owner, book, "E:/books", "E:/books/test.pdf", "test.pdf", "1"],
  );
  await jobs.reconcile(owner, config);
  const job = (await jobs.claim(owner, "pc", new Date("2030-01-01"), config))!;
  const all: any[] = [];
  let after: string | undefined;
  do {
    const page = await jobs.sourcePage(
      owner,
      job.id,
      job.leaseToken!,
      { kind: "notes", after },
      new Date("2030-01-01"),
    );
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(512 * 1024);
    all.push(...page.items);
    after = page.next ?? undefined;
  } while (after);
  expect(all.map((x) => x.id).sort()).toEqual(ids.sort());
  const books = await jobs.sourcePage(
    owner,
    job.id,
    job.leaseToken!,
    { kind: "books" },
    new Date("2030-01-01"),
  );
  expect(books.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: book, documentIds: [documentId] }),
    ]),
  );
  const transport = createRemoteTransport(
    { origin: "https://library.example", token: "fixture", provenance: config },
    async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json(
        await jobs.sourcePage(
          owner,
          request.id,
          request.leaseToken,
          request,
          new Date("2030-01-01"),
        ),
      );
    },
  );
  const remote = await transport.getSources(job);
  expect(remote.notes).toHaveLength(12);
  expect(remote.books?.[0].documentIds).toEqual([documentId]);
  expect(Buffer.byteLength(JSON.stringify(remote))).toBeGreaterThan(512 * 1024);
});

it("keeps valid job completion when an optional topic link no longer has independent sources", async () => {
  const owner = "optional-link",
    library = createLibraryStore(db),
    jobs = createThoughtJobStore(db, { legacyDiagnostics: true }),
    map = createThoughtMapStore(db);
  const note = await library.mutate(
    owner,
    cmd("addNote", { title: "생각", content: "정서 수용", kind: "thought" }),
  );
  const topics = [];
  for (const name of ["상담", "철학"])
    topics.push(
      (
        await map.mutate(
          owner,
          cmd("upsertTopic", {
            name,
            aliases: [],
            description: "",
            parentId: null,
            kdcCodes: [],
          }),
        )
      ).id,
    );
  await jobs.reconcile(owner, config);
  const job = (await jobs.claim(owner, "pc", new Date("2030-01-01"), config))!;
  await jobs.finish(
    owner,
    job.id,
    job.leaseToken!,
    {
      candidateInputs: [],
      indexStatus: "ready",
      topicLinks: [
        {
          id: randomUUID(),
          sourceTopicId: topics[0],
          targetTopicId: topics[1],
          status: "suggested",
          version: 1,
          supportingPairs: [
            { beforeId: note.id!, afterId: note.id! },
            { beforeId: note.id!, afterId: note.id! },
          ],
        },
      ],
    },
    new Date("2030-01-01"),
  );
  expect(
    (
      await db.query("SELECT status FROM library_thought_jobs WHERE id=$1", [
        job.id,
      ])
    ).rows[0].status,
  ).toBe("completed");
  expect((await map.snapshot(owner)).topicLinks).toEqual([]);
});
it("only claims a job matching all worker configuration versions", async () => {
  const owner = "configs",
    library = createLibraryStore(db),
    jobs = createThoughtJobStore(db, { legacyDiagnostics: true });
  await library.mutate(
    owner,
    cmd("addNote", { title: "기록", content: "정서 수용", kind: "thought" }),
  );
  await jobs.reconcile(owner, config);
  expect(
    await jobs.claim(owner, "wrong", new Date("2030-01-01"), {
      ...config,
      promptVersion: "2",
    }),
  ).toBeNull();
  expect(
    await jobs.claim(owner, "right", new Date("2030-01-01"), config),
  ).not.toBeNull();
});
it("reopening preserves prior completion without scheduling automatic generation", async () => {
  const owner = "reopen",
    library = createLibraryStore(db),
    map = createThoughtMapStore(db),
    jobs = createThoughtJobStore(db, { legacyDiagnostics: true });
  const ids = [];
  for (const day of ["2020-01-01", "2021-01-01"]) {
    const n = await library.mutate(
      owner,
      cmd("addNote", {
        title: "기록",
        content: "정서를 수용한다",
        kind: "thought",
      }),
    );
    ids.push(n.id!);
    await map.mutate(
      owner,
      cmd("setThoughtEvent", {
        noteId: n.id,
        expectedVersion: 0,
        occurredOn: day,
        voice: "self",
      }),
    );
  }
  await map.mutate(
    owner,
    cmd("connectThoughts", {
      beforeId: ids[0],
      afterId: ids[1],
      relation: "maintains",
      explanation: "유지",
    }),
  );
  await library.mutate(
    owner,
    cmd("editNote", {
      id: ids[0],
      expectedVersion: 1,
      title: "기록",
      content: "정서를 수용하고 살핀다",
      kind: "thought",
    }),
  );
  await jobs.heartbeat(owner, "pc", 5, config, new Date("2030-01-01"));
  await jobs.reconcile(owner, config);
  let job;
  while ((job = await jobs.claim(owner, "pc", new Date("2030-01-01"), config)))
    await jobs.finish(
      owner,
      job.id,
      job.leaseToken!,
      { candidateInputs: [], indexStatus: "ready" },
      new Date("2030-01-01"),
    );
  const old = await sourceVersion(db, owner, ids[0]);
  const candidate = (await map.snapshot(owner)).candidates[0];
  await map.mutate(
    owner,
    cmd("decideCandidate", {
      id: candidate.id,
      expectedVersion: candidate.version,
      decision: "reopen",
      relation: "maintains",
      explanation: "다시 확인",
      reason: "wrong_relation",
    }),
  );
  expect(await sourceVersion(db, owner, ids[0])).not.toBe(old);
  expect(
    await jobs.claim(owner, "pc", new Date("2030-01-01"), config),
  ).toBeNull();
  expect(
    (
      await db.query(
        "SELECT id FROM library_thought_jobs WHERE owner_id=$1 AND status='completed'",
        [owner],
      )
    ).rows,
  ).toHaveLength(2);
});
