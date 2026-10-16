import { DatabaseSync } from "node:sqlite";
import type {
  ContextExcerpt,
  Topic,
  TopicLink,
} from "../../lib/thought-map/types";
export interface IndexedSource {
  pdfDocumentIds?: string[];
  key: string;
  rootId: string;
  source: ContextExcerpt["source"];
  text: string;
  hash: string;
  topicIds: string[];
  coverage: ContextExcerpt["coverage"];
  start?: number;
  end?: number;
  tags?: string[];
}
export function terms(text: string): string[] {
  const words =
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return [
    ...new Set(
      words.flatMap((w) => {
        const c = Array.from(w);
        return [
          w,
          ...(c.length > 3
            ? c.slice(0, -2).map((_, i) => c.slice(i, i + 3).join(""))
            : []),
        ];
      }),
    ),
  ];
}
export function splitText(text: string) {
  const chars = Array.from(text),
    offsets = [0];
  for (const c of chars) offsets.push(offsets.at(-1)! + c.length);
  const out: { text: string; start: number; end: number }[] = [];
  for (let i = 0; i < chars.length;) {
    let end = Math.min(i + 1000, chars.length);
    if (end < chars.length) {
      const paragraph = chars.slice(i + 500, end).lastIndexOf("\n");
      if (paragraph >= 0) end = i + 500 + paragraph + 1;
    }
    out.push({
      text: chars.slice(i, end).join(""),
      start: offsets[i],
      end: offsets[end],
    });
    if (end === chars.length) break;
    i = end - 100;
  }
  return out;
}
export function normalizeVector(vector: number[], dimensions: number) {
  if (vector.length !== dimensions || vector.some((n) => !Number.isFinite(n)))
    throw Error("invalid_vector");
  const norm = Math.hypot(...vector);
  if (!norm) throw Error("zero_vector");
  return vector.map((n) => n / norm);
}
export class ThoughtIndex {
  private db: DatabaseSync;
  constructor(
    path: string,
    readonly owner: string,
    readonly modelDigest: string,
    readonly dimensions = 1024,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sources(owner TEXT,key TEXT,hash TEXT,body TEXT,PRIMARY KEY(owner,key)); CREATE TABLE IF NOT EXISTS vectors(owner TEXT,key TEXT,hash TEXT,model TEXT,vector BLOB,PRIMARY KEY(owner,key,model)); CREATE VIRTUAL TABLE IF NOT EXISTS source_search USING fts5(owner UNINDEXED,key UNINDEXED,tokens); CREATE TABLE IF NOT EXISTS taxonomy(owner TEXT PRIMARY KEY,body TEXT NOT NULL);",
    );
  }
  put(doc: IndexedSource, vector?: number[]) {
    const normalized = vector ? normalizeVector(vector, this.dimensions) : null;
    const ownTransaction = !this.db.isTransaction;
    if (ownTransaction) this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO sources(owner,key,hash,body) VALUES(?,?,?,?) ON CONFLICT(owner,key) DO UPDATE SET hash=excluded.hash,body=excluded.body",
        )
        .run(this.owner, doc.key, doc.hash, JSON.stringify(doc));
      this.db
        .prepare("DELETE FROM source_search WHERE owner=? AND key=?")
        .run(this.owner, doc.key);
      this.db
        .prepare("INSERT INTO source_search(owner,key,tokens) VALUES(?,?,?)")
        .run(this.owner, doc.key, terms(doc.text).join(" "));
      if (normalized)
        this.db
          .prepare(
            "INSERT INTO vectors(owner,key,hash,model,vector) VALUES(?,?,?,?,?) ON CONFLICT(owner,key,model) DO UPDATE SET hash=excluded.hash,vector=excluded.vector",
          )
          .run(
            this.owner,
            doc.key,
            doc.hash,
            this.modelDigest,
            Buffer.from(new Float32Array(normalized).buffer),
          );
      if (ownTransaction) this.db.exec("COMMIT");
    } catch (e) {
      if (ownTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }
  list(): IndexedSource[] {
    return this.db
      .prepare("SELECT body FROM sources WHERE owner=? ORDER BY key")
      .all(this.owner)
      .map((r) => JSON.parse(String(r.body)));
  }
  replaceSources(kind: IndexedSource["source"]["kind"], docs: IndexedSource[]) {
    // A complete synchronized source set replaces old offsets/deleted records atomically.
    const keys = new Set(docs.map((d) => d.key));
    this.db.exec("BEGIN");
    try {
      for (const old of this.list())
        if (old.source.kind === kind && !keys.has(old.key))
          this.remove(old.key);
      for (const doc of docs) this.put(doc);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  vector(key: string, hash: string): number[] | null {
    const r = this.db
      .prepare(
        "SELECT vector FROM vectors WHERE owner=? AND key=? AND hash=? AND model=?",
      )
      .get(this.owner, key, hash, this.modelDigest);
    if (!r) return null;
    const bytes = r.vector as Uint8Array;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength !== this.dimensions * 4) return null;
    return Array.from({ length: this.dimensions }, (_, i) =>
      view.getFloat32(i * 4, true),
    );
  }
  lexical(text: string): string[] {
    const tokens = terms(text).slice(0, 100);
    if (!tokens.length) return [];
    const query = tokens
      .map((t) => '"' + t.replaceAll('"', '""') + '"')
      .join(" OR ");
    return this.db
      .prepare(
        "SELECT key FROM source_search WHERE source_search MATCH ? AND owner=? ORDER BY rank LIMIT 200",
      )
      .all(query, this.owner)
      .map((r) => String(r.key));
  }
  setTopics(topics: Topic[], links: TopicLink[]) {
    this.db
      .prepare(
        "INSERT INTO taxonomy(owner,body) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET body=excluded.body",
      )
      .run(this.owner, JSON.stringify({ topics, links }));
  }
  taxonomy(): { topics: Topic[]; links: TopicLink[] } {
    const row = this.db
      .prepare("SELECT body FROM taxonomy WHERE owner=?")
      .get(this.owner);
    return row ? JSON.parse(String(row.body)) : { topics: [], links: [] };
  }
  remove(key: string) {
    this.db
      .prepare("DELETE FROM sources WHERE owner=? AND key=?")
      .run(this.owner, key);
    this.db
      .prepare("DELETE FROM source_search WHERE owner=? AND key=?")
      .run(this.owner, key);
    this.db
      .prepare("DELETE FROM vectors WHERE owner=? AND key=?")
      .run(this.owner, key);
  }
  close() {
    this.db.close();
  }
}
