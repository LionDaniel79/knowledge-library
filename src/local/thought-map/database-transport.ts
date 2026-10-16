import { Pool } from "pg";
import { dateOnlyTypes } from "../../server/pg-types";
import { randomUUID } from "node:crypto";
import type { Database } from "../../server/library-store";
import { createThoughtJobStore } from "../../server/thought-job-store";
import { createThoughtMapStore } from "../../server/thought-map-store";
import {
  resolveThoughtRecord,
  noteFromRow,
  withEvent,
} from "../../lib/thought-map/records";
import type {
  WorkerSources,
  WorkerTransport,
} from "../../lib/thought-map/jobs";
import type {
  AnalysisProvenance,
  Candidate,
} from "../../lib/thought-map/types";
import type { ThoughtIndex } from "./index";
export async function openLocalDatabase() {
  if (!process.env.DATABASE_URL || !process.env.LIBRARY_OWNER_EMAIL)
    throw Error("소유자와 앱 DB 설정이 필요합니다.");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    types: dateOnlyTypes,
  });
  try {
    const role = (
      await pool.query(
        "SELECT has_schema_privilege(current_user,'public','CREATE') AS can_create",
      )
    ).rows[0];
    if (role.can_create)
      throw Error("분석기는 관리자 DB 계정을 사용할 수 없습니다.");
    const owners = (
      await pool.query(
        'SELECT id::text FROM neon_auth."user" WHERE lower(email)=lower($1) AND "emailVerified"=true',
        [process.env.LIBRARY_OWNER_EMAIL],
      )
    ).rows;
    if (owners.length !== 1) throw Error("인증된 소유자 확인이 필요합니다.");
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
    return { db, owner: String(owners[0].id), close: () => pool.end() };
  } catch {
    await pool.end();
    throw Error(
      "앱 DB의 소유자 확인을 완료하지 못했습니다. PC 연결 키 방식으로 연결해 주세요.",
    );
  }
}
export async function loadOwnerSources(
  db: Database,
  owner: string,
): Promise<Omit<WorkerSources, "candidates"> & { candidates: Candidate[] }> {
  const snapshot = await createThoughtMapStore(db).snapshot(owner),
    rows = (
      await db.query(
        "SELECT * FROM library_active_notes WHERE owner_id=$1 ORDER BY id",
        [owner],
      )
    ).rows;
  return {
    ...snapshot,
    notes: rows.map((r) =>
      withEvent(
        resolveThoughtRecord(noteFromRow(r)),
        snapshot.events.find((e) => e.noteId === r.id),
      ),
    ),
    context: [],
  };
}
export async function seedMetadata(
  db: Database,
  owner: string,
  index: ThoughtIndex,
) {
  const state = await createThoughtMapStore(db).snapshot(owner);
  index.setTopics(state.topics, state.topicLinks);
  const books = (
    await db.query(
      "SELECT b.id,b.title,b.author,b.publisher,b.isbn,b.tags,b.version,coalesce(array_agg(d.id) FILTER(WHERE d.id IS NOT NULL),'{}') AS documents FROM library_books b LEFT JOIN library_documents d ON d.owner_id=b.owner_id AND d.book_id=b.id WHERE b.owner_id=$1 GROUP BY b.id ORDER BY b.id",
      [owner],
    )
  ).rows;
  for (const b of books)
    index.put({
      key: "book:" + b.id,
      rootId: /^\d{13}$/.test(b.isbn) ? "isbn:" + b.isbn : b.id,
      source: {
        kind: "book_metadata",
        id: b.id,
        version: String(b.version),
        page: null,
      },
      text: [b.title, b.author, b.publisher, ...b.tags].join(" "),
      hash: String(b.version),
      topicIds: state.memberships
        .filter(
          (m) =>
            m.sourceKind === "book" &&
            m.sourceId === b.id &&
            m.status === "accepted",
        )
        .map((m) => m.topicId),
      coverage: "metadata",
      tags: b.tags,
      pdfDocumentIds: b.documents,
    });
}
export function createDatabaseTransport(
  db: Database,
  owner: string,
  provenance: AnalysisProvenance,
): WorkerTransport {
  const jobs = createThoughtJobStore(db),
    workerId = randomUUID();
  return {
    claim: () => jobs.claim(owner, workerId, new Date(), provenance),
    renew: (j) => jobs.renew(owner, j.id, j.leaseToken!),
    getSources: (j) => jobs.sources(owner, j.id, j.leaseToken!),
    finish: (j, r) => jobs.finish(owner, j.id, j.leaseToken!, r),
    fail: (j, c) => jobs.fail(owner, j.id, j.leaseToken!, c),
    heartbeat: (n) => jobs.heartbeat(owner, workerId, n, provenance),
  };
}
