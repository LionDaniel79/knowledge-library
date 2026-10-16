/** Resumable, conservative enrichment. Original files/notes and user edits are preserved. */
import { Pool } from "pg";
import { createCurationStore } from "../src/server/curation-store";
import type { Database } from "../src/server/library-store";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isbn13,
  compatibleIsbn,
  extractIsbns,
  compactTitle,
  sameTitle,
  suggestCategory,
  suggestNoteTags,
} from "../src/lib/bibliography";
const apply = process.argv.includes("--apply"),
  online = process.argv.includes("--online");
if (online)
  throw Error(
    "일괄 온라인 조회는 사용하지 않습니다. 출처별 이용 조건을 반영한 정비 도구를 사용해 주세요.",
  );
const local = new DatabaseSync(process.env.LIBRARY_PDF_INDEX!, {
  readOnly: true,
});
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 1,
});
const cacheDir = join(
  dirname(process.env.LIBRARY_PDF_INDEX!),
  "bibliography-cache",
);
await mkdir(cacheDir, { recursive: true });
const summary = {
  books: 0,
  categories: 0,
  pages: 0,
  articleMetadata: 0,
  isbnMatches: 0,
  covers: 0,
  notesTagged: 0,
  onlineMatches: 0,
  conflicts: 0,
};
try {
  const owner = (
    await pool.query(
      'SELECT id::text FROM neon_auth."user" WHERE lower(email)=lower($1) AND "emailVerified"=true',
      [process.env.LIBRARY_OWNER_EMAIL],
    )
  ).rows[0]?.id;
  if (!owner) throw Error("Verified owner required");
  const manuallyEdited = new Set(
    (
      await pool.query(
        "SELECT DISTINCT entity_id FROM library_revisions WHERE owner_id=$1 AND action='editBook'",
        [owner],
      )
    ).rows.map((r) => r.entity_id),
  );
  const books = (
    await pool.query(
      "SELECT * FROM library_books WHERE owner_id=$1 ORDER BY id",
      [owner],
    )
  ).rows;
  const owned = new Map<string, any[]>();
  for (const b of books) {
    const isbn = isbn13(b.isbn);
    if (isbn && b.source_data?.app !== "Local PDF")
      owned.set(isbn, [...(owned.get(isbn) ?? []), b]);
  }
  const docs = new Map(
    local
      .prepare(
        "SELECT id,title,author,page_count,signature,status,metadata,processing_scope FROM documents",
      )
      .all()
      .map((d) => [String(d.id), d]),
  );
  const front = local.prepare(
    "SELECT substr(text,1,14000) AS text FROM pages WHERE document_id=? AND page_number<=8 AND method='text' ORDER BY page_number",
  );
  const patches: any[] = [];
  const queriedIsbns = new Map<string, string[]>();
  for (const b of books) {
    if (manuallyEdited.has(b.id)) continue;
    if (
      b.source_data?.app === "Local PDF" &&
      docs.get(b.source_data.recordId)?.processing_scope !== "full"
    )
      continue;
    const next = { ...b },
      reasons: string[] = [];
    if (!b.category && b.classification?.method !== "manual") {
      const code = suggestCategory(b.title, b.tags);
      if (code) {
        next.category = code;
        next.classification = {
          source: "기존 주제·폴더·제목",
          code,
          verified: false,
          method: "KDC 큰 분류 제안",
          url: "https://oak.go.kr/nl-ir/handle/2020.oak/326",
        };
        summary.categories++;
        reasons.push("categorySuggestion");
      }
    }
    const d = docs.get(b.source_data?.recordId);
    if (
      b.source_data?.app === "Local PDF" &&
      d &&
      !["changed", "missing", "error", "locked"].includes(String(d.status))
    ) {
      if (!b.total_pages && Number(d.page_count) > 0) {
        next.total_pages = Number(d.page_count);
        summary.pages++;
        reasons.push("pdfPageCount");
      }
      if (b.version === 1 && !b.enrichment?.article) {
        const m = b.title.match(/^(.{1,100}?) 저,\s*(.+?),\s*(신학지남사),/);
        if (m) {
          next.author = m[1].trim();
          next.title = m[2].trim();
          next.publisher = m[3];
          summary.articleMetadata++;
          reasons.push("articleFilename");
        }
      }
      const text = front
        .all(String(d.id))
        .map((r) => String(r.text))
        .join("\n");
      const candidates = extractIsbns(text);
      const normalized = compactTitle(text);
      const matches = candidates.flatMap((i) =>
        (owned.get(i) ?? []).filter(
          (ref) =>
            compatibleIsbn(b.isbn, ref.isbn) &&
            compactTitle(ref.title).length >= 4 &&
            (normalized.includes(compactTitle(ref.title)) ||
              sameTitle(b.title, ref.title)),
        ),
      );
      if (matches.length === 1) {
        const ref = matches[0];
        if (!b.isbn) {
          next.isbn = ref.isbn;
          summary.isbnMatches++;
          reasons.push("isbnAndTitle");
        }
        if (
          !b.author ||
          /NuriMedia|Adobe|Microsoft|Administrator|^admin$/i.test(b.author)
        )
          next.author = ref.author;
        if (!b.publisher) next.publisher = ref.publisher;
        if (!b.source_data?.cover && !b.cover_url && ref.source_data?.cover) {
          next.source_data = { ...b.source_data, cover: ref.source_data.cover };
          summary.covers++;
          reasons.push("sameEditionCover");
        }
      }
      if (candidates.length && !b.cover_url && !b.source_data?.cover)
        queriedIsbns.set(b.id, candidates);
      // Keep extracted candidates for online edition verification; do not assign an ISBN on extraction alone.
      if (!b.enrichment?.isbnCandidates && candidates.length) {
        next.enrichment = { ...next.enrichment, isbnCandidates: candidates };
        reasons.push("isbnCandidates");
      }
    }
    if (reasons.length) {
      next.enrichment = {
        ...next.enrichment,
        local: { at: new Date().toISOString(), methods: reasons },
        ...(reasons.includes("articleFilename") ? { article: true } : {}),
      };
      patches.push({ old: b, next });
    }
  }
  if (online) {
    // Human-requested ISBN lookup in small batches; no general corpus harvesting.
    const candidates = [...new Set([...queriedIsbns.values()].flat())];
    const remote = new Map<string, any>();
    let network = 0;
    for (let i = 0; i < candidates.length; i += 20) {
      const batch = candidates.slice(i, i + 20),
        missing: string[] = [];
      for (const isbn of batch) {
        try {
          remote.set(
            isbn,
            JSON.parse(await readFile(join(cacheDir, isbn + ".json"), "utf8")),
          );
        } catch {
          missing.push(isbn);
        }
      }
      if (!missing.length) continue;
      const url = new URL("https://openlibrary.org/api/books");
      url.searchParams.set(
        "bibkeys",
        missing.map((i) => "ISBN:" + i).join(","),
      );
      url.searchParams.set("format", "json");
      url.searchParams.set("jscmd", "data");
      try {
        const r = await fetch(url, {
          signal: AbortSignal.timeout(20000),
          headers: { "User-Agent": "PersonalKnowledgeLibrary/0.1" },
        });
        if (r.status === 429) {
          console.log(
            JSON.stringify({
              online: "rate-limited; cached progress retained",
            }),
          );
          break;
        }
        if (!r.ok) throw Error("Metadata provider unavailable");
        const json = await r.json();
        network++;
        for (const isbn of missing) {
          const value = json["ISBN:" + isbn] ?? null;
          remote.set(isbn, value);
          await writeFile(
            join(cacheDir, isbn + ".json"),
            JSON.stringify(value),
          );
        }
      } catch {
        console.log(
          JSON.stringify({
            online: "provider unavailable; remaining lookups deferred",
          }),
        );
        break;
      }
      if (network % 5 === 0)
        console.log(
          JSON.stringify({
            onlineLookups: Math.min(i + 20, candidates.length),
            total: candidates.length,
          }),
        );
      await new Promise((r) => setTimeout(r, 1100));
    }
    for (const [id, isbnCandidates] of queriedIsbns) {
      const b = books.find((b) => b.id === id)!;
      const knownIsbn =
        patches.find((p) => p.old.id === id)?.next.isbn || b.isbn;
      const text = front
        .all(b.source_data.recordId)
        .map((r) => String(r.text))
        .join("\n");
      const normalized = compactTitle(text);
      const matches = isbnCandidates.flatMap((i) => {
        const r = remote.get(i);
        return r &&
          compatibleIsbn(knownIsbn, i) &&
          r.title &&
          compactTitle(r.title).length >= 5 &&
          (sameTitle(b.title, r.title) ||
            normalized.includes(compactTitle(r.title)))
          ? [{ ...r, isbn: i }]
          : [];
      });
      const unique = [...new Map(matches.map((m) => [m.isbn, m])).values()];
      if (unique.length !== 1) continue;
      const ref = unique[0];
      if (b.enrichment?.online?.isbn === ref.isbn) continue;
      const existing = patches.find((p) => p.old.id === id),
        next = existing?.next ?? { ...b };
      if (!next.isbn) next.isbn = ref.isbn;
      if (!next.publisher)
        next.publisher = (ref.publishers ?? [])
          .map((p: any) => p.name)
          .join(", ")
          .slice(0, 300);
      if (
        !next.author ||
        /NuriMedia|Adobe|Microsoft|Administrator|^admin$/i.test(next.author)
      )
        next.author = (ref.authors ?? [])
          .map((a: any) => a.name)
          .join(", ")
          .slice(0, 300);
      if (
        !next.cover_url &&
        !next.source_data?.cover &&
        ref.cover?.large?.startsWith("https://")
      ) {
        next.cover_url = ref.cover.large;
        summary.covers++;
      }
      next.enrichment = {
        ...next.enrichment,
        online: {
          provider: "Open Library",
          url: ref.url,
          isbn: ref.isbn,
          matchedBy: "ISBN + 원문 제목",
          at: new Date().toISOString(),
        },
      };
      if (!existing) patches.push({ old: b, next });
      summary.onlineMatches++;
    }
  }
  if (apply) {
    for (let offset = 0; offset < patches.length; offset += 200) {
      const batch = patches
        .slice(offset, offset + 200)
        .map((p) => ({ ...p.next, before: p.old, revision: randomUUID() }));
      const result = await pool.query(
        `WITH changed AS (UPDATE library_books b SET title=p.title,author=p.author,publisher=p.publisher,isbn=p.isbn,total_pages=p.total_pages,category=p.category,classification=p.classification,source_data=p.source_data,cover_url=p.cover_url,enrichment=p.enrichment,version=b.version+1 FROM jsonb_to_recordset($2::jsonb) AS p(id uuid,title text,author text,publisher text,isbn text,total_pages integer,category text,classification jsonb,source_data jsonb,cover_url text,enrichment jsonb,version integer) WHERE b.owner_id=$1 AND b.id=p.id AND b.version=p.version RETURNING b.*) INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) SELECT p.revision,$1,c.id,'enrichBibliography',p.before,to_jsonb(c) FROM changed c JOIN jsonb_to_recordset($2::jsonb) AS p(id uuid,revision uuid,before jsonb) ON c.id=p.id RETURNING entity_id`,
        [owner, JSON.stringify(batch)],
      );
      summary.books += result.rowCount ?? 0;
      summary.conflicts += batch.length - (result.rowCount ?? 0);
    }
  }
  const byId = new Map(books.map((b) => [b.id, b]));
  const notes = (
    await pool.query("SELECT * FROM library_notes WHERE owner_id=$1", [owner])
  ).rows;
  const db: Database = {
    query: (sql, params = []) => pool.query(sql, params),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const value = await fn({ query: (s, p = []) => client.query(s, p) });
        await client.query("COMMIT");
        return value;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
  };
  const curation = createCurationStore(db);
  const tagItems = notes.flatMap((n) => {
    if (!n.content.trim()) return [];
    const tags = suggestNoteTags(
      n.title + " " + n.content,
      byId.get(n.book_id)?.tags ?? [],
    );
    if (!tags.length) return [];
    return [
      {
        id: randomUUID(),
        source: { kind: "note" as const, id: n.id, version: String(n.version) },
        kind: "tag" as const,
        proposedValue: tags,
        evidence: { quote: n.content.slice(0, 1000) },
        coverage: "partial" as const,
        origin: "rule" as const,
        generator: "note-keywords-v1",
      },
    ];
  });
  if (apply && tagItems.length) {
    const run = await curation.begin(owner, "legacy-enrichment-tags", "rule");
    for (let offset = 0; offset < tagItems.length; offset += 100)
      summary.notesTagged += (
        await curation.apply(owner, run, tagItems.slice(offset, offset + 100))
      ).applied;
    await curation.seal(owner, run);
  } else summary.notesTagged = tagItems.length;
  const report = {
    ...summary,
    apply,
    online,
    proposedBooks: patches.length,
    pdfIsbnCandidates: queriedIsbns.size,
    classification: "suggested, not library-verified",
  };
  console.log(JSON.stringify(report));
  if (apply)
    await writeFile(
      join(cacheDir, "last-run.json"),
      JSON.stringify(report, null, 2),
    );
} finally {
  local.close();
  await pool.end();
}
