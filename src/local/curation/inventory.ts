import { mkdir, realpath, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Database } from "../../server/library-store";
import { contentHash } from "../../server/curation-store";
import type { SourceRef } from "../../lib/curation";
export interface InventoryRecord {
  source: SourceRef;
  title: string;
  text: string;
  isbn: string;
  eligible: boolean;
  coverage: "metadata" | "toc" | "partial" | "full";
  missing: string[];
  ambiguous: boolean;
  pdf?: {
    signature: string;
    sha256: string | null;
    status: string;
    textPages: number;
    pages: number;
  };
}
export interface InventoryManifest {
  schemaVersion: 1;
  owner: string;
  createdAt: string;
  snapshotHash: string;
  records: InventoryRecord[];
  references: Record<string, any>[];
  counts: { books: number; notes: number; eligible: number; basicOnly: number };
}
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
async function prospectivePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    return resolve(await prospectivePath(dirname(path)), basename(path));
  }
}
export async function buildCurationInventory(
  db: Database,
  input: {
    owner: string;
    pdfRoot: string;
    outputDir: string;
    indexPath?: string;
  },
): Promise<InventoryManifest> {
  if (!input.owner) throw Error("소유자가 필요합니다.");
  const root = await realpath(input.pdfRoot),
    output = await prospectivePath(resolve(input.outputDir));
  if (within(root, output) || output.split(/[\\/]/).includes("sources"))
    throw Error("원본 폴더에는 정비 결과를 저장할 수 없습니다.");
  const data = await db.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const books = (
      await tx.query(
        "SELECT id,title,author,publisher,isbn,tags,version,source_data FROM library_books WHERE owner_id=$1 ORDER BY id",
        [input.owner],
      )
    ).rows;
    const notes = (
      await tx.query(
        "SELECT id,title,content,kind,version,source_data FROM library_active_notes WHERE owner_id=$1 ORDER BY id",
        [input.owner],
      )
    ).rows;
    const docs = (
      await tx.query(
        "SELECT id,book_id,path,processing_scope FROM library_documents WHERE owner_id=$1",
        [input.owner],
      )
    ).rows;
    const references = (
      await tx.query(
        "SELECT * FROM library_reference_sources WHERE owner_id=$1 ORDER BY id",
        [input.owner],
      )
    ).rows;
    return { books, notes, docs, references };
  });
  const locals = new Map<string, any>();
  if (input.indexPath) {
    const local = new DatabaseSync(input.indexPath, { readOnly: true });
    try {
      for (const d of local
        .prepare(
          "SELECT id,signature,sha256,status,text_pages,page_count FROM documents",
        )
        .all())
        locals.set(String(d.id), d);
    } finally {
      local.close();
    }
  }
  const documents = new Map(data.docs.map((d) => [d.book_id, d]));
  const records: InventoryRecord[] = [];
  for (const b of data.books) {
    const d = documents.get(b.id),
      local = d && locals.get(d.id);
    let eligible =
      b.source_data?.app !== "Local PDF" ||
      (!!d && d.processing_scope === "full");
    if (d) {
      try {
        eligible = eligible && within(root, await realpath(d.path));
      } catch {
        eligible = false;
      }
    }
    records.push({
      source: { kind: "book", id: b.id, version: String(b.version) },
      title: b.title,
      text: [b.title, b.author, b.publisher, b.isbn, ...(b.tags ?? [])]
        .filter(Boolean)
        .join("\n"),
      isbn: b.isbn ?? "",
      eligible,
      coverage: "metadata",
      missing: ["author", "publisher", "isbn"].filter((k) => !b[k]),
      ambiguous: !b.author || !eligible,
      pdf: local
        ? {
            signature: local.signature,
            sha256: local.sha256,
            status: local.status,
            textPages: Number(local.text_pages),
            pages: Number(local.page_count),
          }
        : undefined,
    });
  }
  for (const n of data.notes)
    records.push({
      source: { kind: "note", id: n.id, version: String(n.version) },
      title: n.title,
      text: n.content,
      isbn: "",
      eligible: true,
      coverage: "full",
      missing: [],
      ambiguous: n.kind === "highlight" || !!n.source_data?.app,
    });
  const snapshotHash = contentHash(
    JSON.stringify({ records, references: data.references }),
  );
  const manifest: InventoryManifest = {
    schemaVersion: 1,
    owner: input.owner,
    createdAt: new Date().toISOString(),
    snapshotHash,
    records,
    references: data.references,
    counts: {
      books: data.books.length,
      notes: data.notes.length,
      eligible: records.filter((r) => r.eligible).length,
      basicOnly: records.filter((r) => !r.eligible).length,
    },
  };
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, "inventory.json"),
    JSON.stringify(manifest, null, 2),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return manifest;
}
export function selectCurationSample(inventory: InventoryManifest) {
  const eligible = inventory.records.filter((r) => r.eligible),
    selected = new Set<string>();
  const key = (r: InventoryRecord) => r.source.kind + ":" + r.source.id;
  const take = (rows: InventoryRecord[], n: number) =>
    rows
      .filter((r) => !selected.has(key(r)))
      .slice(0, n)
      .map((r) => {
        selected.add(key(r));
        return r;
      });
  const books = eligible.filter((r) => r.source.kind === "book");
  const ambiguous = take(
    books.filter((r) => r.ambiguous),
    10,
  );
  ambiguous.push(
    ...take(
      books.filter((r) => r.missing.length > 0),
      10 - ambiguous.length,
    ),
  );
  const bibliography = take(books, 30),
    notes = take(
      eligible.filter((r) => r.source.kind === "note"),
      20,
    );
  const hashes = new Map<string, string[]>();
  for (const r of eligible) {
    if (r.pdf?.sha256) {
      const list = hashes.get(r.pdf.sha256) ?? [];
      list.push(r.source.id);
      hashes.set(r.pdf.sha256, list);
    }
  }
  return {
    snapshotHash: inventory.snapshotHash,
    items: [...bibliography, ...notes, ...ambiguous],
    groups: {
      bibliography: bibliography.length,
      notes: notes.length,
      ambiguous: ambiguous.length,
    },
    duplicateCandidates: [...hashes.values()].filter((x) => x.length > 1),
    humanReview: "pending" as const,
  };
}
