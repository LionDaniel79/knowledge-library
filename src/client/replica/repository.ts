import { z } from "zod";
import { defaultShelves } from "../../lib/catalog";
import type { Book, BookPage, Library, Note, Revision } from "../../lib/domain";
import { isbn13 } from "../../lib/bibliography";
import {
  binaryCompare,
  iso,
  jsonbText,
  projectBook,
  projectNote,
  projectCycle,
  projectRevision,
  serialized,
  sqlTimestamp,
  timestampKey,
  type RawRecord,
} from "../../lib/replica/projections";
import {
  entityDefinition,
  syncEntities,
  type SyncEntity,
} from "../../lib/replica/entities";
import type { ReplicaStorage } from "./storage";
import { readReplicaValue } from "./values";
import {
  activeBooks,
  activeNotes,
  activeCycles,
  readingSummary,
  ReplicaQueryError,
  type LocalIndex,
  type QueryKind,
  type SearchEntry,
} from "./queries";
import { createQueryWorker } from "./query-worker";
import { createResourceReader } from "./resources";
export class UnsupportedLocalRoute extends Error {}
const indexEntities: SyncEntity[] = [
  "library_books",
  "library_notes",
  "library_cycles",
  "library_book_exclusions",
  "library_note_trash",
  "library_shelves",
  "library_annual_metrics",
  "library_topics",
  "library_topic_links",
  "library_topic_memberships",
  "library_thought_events",
  "library_curation_items",
  "library_reference_sources",
  "library_documents",
  "library_connections",
  "library_evolution_candidates",
  "library_analysis_feedback",
  "library_cover_mirrors",
];
const indexStamp = (state: {
  entityRevisions?: Partial<Record<SyncEntity, string>>;
}) =>
  JSON.stringify(
    indexEntities.map((e) => [e, state.entityRevisions?.[e] ?? "0"]),
  );
export function createReplicaRepository(storage: ReplicaStorage) {
  const worker = createQueryWorker(storage.owner);
  let cached: { token: string; data: LocalIndex } | undefined,
    loading: Promise<LocalIndex> | undefined;
  async function* records(entity: SyncEntity, generation: string) {
    let after: string | undefined;
    while (true) {
      const p = await storage.readPage(entity, {
        generation,
        after,
        limit: 200,
      });
      for (const row of p.rows)
        if (!row.deleted) {
          const value = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              await readReplicaValue(storage, row, generation),
            ),
          );
          yield value as RawRecord;
        }
      after = p.after;
      if (!p.hasMore) break;
    }
  }
  async function raw(entity: SyncEntity, id: string, generation?: string) {
    const row = await storage.readRow(
      entity,
      JSON.stringify(entityDefinition(entity).keys.length ? [id] : []),
      generation,
    );
    if (!row || row.deleted) return undefined;
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readReplicaValue(storage, row, generation),
      ),
    ) as RawRecord;
  }
  const sorted = (rows: RawRecord[]) =>
    rows.sort(
      (a, b) =>
        binaryCompare(timestampKey(a.created_at), timestampKey(b.created_at)) ||
        binaryCompare(a.id ?? a.name, b.id ?? b.name),
    );
  async function build(generation: string): Promise<LocalIndex> {
    const tables = {} as Partial<Record<SyncEntity, RawRecord[]>>;
    for (const entity of [
      "library_books",
      "library_notes",
      "library_cycles",
      "library_book_exclusions",
      "library_note_trash",
      "library_shelves",
      "library_annual_metrics",
      "library_topics",
      "library_topic_links",
      "library_topic_memberships",
      "library_thought_events",
      "library_curation_items",
      "library_reference_sources",
      "library_documents",
      "library_connections",
      "library_evolution_candidates",
      "library_analysis_feedback",
    ] as SyncEntity[]) {
      const values = [];
      for await (const row of records(entity, generation)) values.push(row);
      tables[entity] = values;
    }
    const get = (entity: SyncEntity) => tables[entity] ?? [];
    const books = sorted(get("library_books")).map((r) => ({
        book: projectBook(r, true),
        createdKey: timestampKey(r.created_at),
        createdSql: sqlTimestamp(r.created_at),
      })),
      notes = get("library_notes").map((r) => projectNote(r)),
      previews = Object.fromEntries(
        get("library_notes").map((r) => [r.id, projectNote(r, true)]),
      );
    const data: LocalIndex = {
      connectionBooks: get("library_connections").flatMap((c) => [
        ...(c.source_kind === "book" ? [c.source_id] : []),
        ...(c.target_kind === "book" ? [c.target_id] : []),
      ]),
      books,
      notes,
      previews,
      cycles: sorted(get("library_cycles")).map(projectCycle),
      excluded: get("library_book_exclusions")
        .filter((r) => r.state === "excluded")
        .map((r) => r.id),
      trash: Object.fromEntries(
        get("library_note_trash")
          .filter((r) => r.restored_at === null)
          .map((r) => [r.id, iso(r.deleted_at)]),
      ),
      shelves: [
        ...new Set([
          ...defaultShelves,
          ...sorted(get("library_shelves")).map((r) => r.name),
        ]),
      ],
      annualMetrics: get("library_annual_metrics")
        .sort((a, b) => a.year - b.year)
        .map((r) => ({
          year: r.year,
          reportedBooks: Number(r.reported_books),
          source: r.source,
          explanation: r.explanation,
        })),
      topics: get("library_topics"),
      topicLinks: get("library_topic_links"),
      memberships: get("library_topic_memberships"),
      entries: [],
    };
    const documents = get("library_documents"),
      curations = get("library_curation_items"),
      references = new Map(
        get("library_reference_sources").map((r) => [r.id, r]),
      ),
      mirrors = new Map<string, string>();
    for await (const row of records("library_cover_mirrors", generation))
      mirrors.set(row.source, "/api/book-covers/" + row.asset_id);
    const knownBooks = new Map(books.map((b) => [b.book.id, b.book]));
    for (const c of [...curations].sort(
      (a, b) =>
        binaryCompare(timestampKey(b.created_at), timestampKey(a.created_at)) ||
        binaryCompare(b.id, a.id),
    )) {
      const b = knownBooks.get(c.source_id),
        r = references.get(c.evidence?.referenceId);
      if (
        !b ||
        b.catalogCoverUrl ||
        c.source_kind !== "book" ||
        c.kind !== "bibliography" ||
        c.origin !== "provider" ||
        c.state !== "active" ||
        String(c.source_version) !== String(b.version) ||
        !r ||
        r.edition_match !== "isbn" ||
        r.source_kind !== c.source_kind ||
        r.source_id !== c.source_id ||
        String(r.source_version) !== String(c.source_version)
      )
        continue;
      if (
        b.sourceData?.app === "Local PDF" &&
        !documents.some(
          (d) => d.book_id === b.id && d.processing_scope === "full",
        )
      )
        continue;
      const isbn = isbn13(b.isbn);
      let url = "";
      try {
        const u = new URL(c.value?.coverUrl);
        if (
          u.protocol === "http:" &&
          u.hostname === "image.aladin.co.kr" &&
          !u.port
        )
          u.protocol = "https:";
        if (u.protocol === "https:" && !u.username && !u.password) url = u.href;
      } catch {}
      if (
        isbn &&
        isbn === isbn13(c.value?.isbn ?? "") &&
        isbn === isbn13(r.facts?.isbn ?? "") &&
        url
      )
        b.catalogCoverUrl = url;
    }
    for (const { book: b } of books) {
      b.storedCoverUrl = b.coverUrl ? mirrors.get(b.coverUrl) : undefined;
      const sha = b.sourceData?.cover?.sha256;
      b.storedImportedCoverUrl = sha ? mirrors.get("import:" + sha) : undefined;
      if (b.catalogCoverUrl) b.catalogCoverUrl = mirrors.get(b.catalogCoverUrl);
      Object.assign(b, serialized(b));
    }
    const visibleBooks = new Map(
        activeBooks(data).map((b) => [b.book.id, b.book]),
      ),
      visibleNotes = new Map(activeNotes(data).map((n) => [n.id, n])),
      events = new Map(
        get("library_thought_events").map((e) => [e.note_id, e]),
      );
    const entry = (
      kind: string,
      r: { id: string; title: string; version: number },
      body: string,
      voice: string,
      extra: Partial<SearchEntry> = {},
    ): SearchEntry => ({
      id: (kind === "book" ? "b:" : "n:") + r.id,
      kind,
      source_id: r.id,
      version: String(r.version),
      title: r.title,
      body,
      voice,
      coverage: kind === "book" ? "metadata" : "full",
      origin: "original",
      tags: "tags" in r ? ((r as any).tags ?? []).join(" ") : "",
      aux: 0,
      ...extra,
    });
    for (const b of visibleBooks.values())
      data.entries.push(
        entry("book", b, [b.author, b.publisher, b.isbn].join(" "), "source"),
      );
    for (const n of visibleNotes.values())
      data.entries.push(
        entry(
          "note",
          n,
          n.content,
          n.kind === "highlight"
            ? "quote"
            : (events.get(n.id)?.voice ??
                (!n.sourceData && ["thought", "reflection"].includes(n.kind)
                  ? "self"
                  : "unconfirmed")),
        ),
      );
    const source = (kind: string, id: string) =>
      kind === "book" ? visibleBooks.get(id) : visibleNotes.get(id);
    for (const c of curations) {
      const s = source(c.source_kind, c.source_id);
      if (
        !s ||
        c.state !== "active" ||
        String(c.source_version) !== String(s.version)
      )
        continue;
      const value = c.value,
        method = value?.method;
      if (
        c.kind === "toc" &&
        ["embedded_outline", "edited_outline", "printed_toc_excerpt"].includes(
          method,
        ) &&
        !documents.some(
          (d) =>
            c.source_kind === "book" &&
            d.book_id === c.source_id &&
            d.id === value.documentId &&
            d.processing_scope === "full" &&
            String(d.bytes) + ":" + d.mtime_ns === value.signature,
        )
      )
        continue;
      if (
        c.source_kind === "book" &&
        (s as Book).sourceData?.app === "Local PDF" &&
        !documents.some(
          (d) => d.book_id === s.id && d.processing_scope === "full",
        )
      )
        continue;
      const body =
        c.kind === "toc" && Array.isArray(value?.entries)
          ? value.entries.map((e: any) => e.title).join("\n")
          : c.kind === "toc" && method === "printed_toc_excerpt"
            ? (value.editedText ?? value.text)
            : typeof value === "string"
              ? value
              : jsonbText(value);
      data.entries.push(
        entry(c.source_kind, s, body ?? "", "auxiliary", {
          id: "c:" + c.id,
          coverage: c.coverage,
          origin: c.origin,
          aux: 1,
          tags: "",
        }),
      );
    }
    for (const c of get("library_connections")) {
      const s = source(c.source_kind, c.source_id);
      if (c.status !== "accepted" || !s || !source(c.target_kind, c.target_id))
        continue;
      data.entries.push(
        entry(c.source_kind, s, c.reason, "self", {
          id: "j:" + c.id,
          title: "내 판단 · " + s.title,
          coverage: "full",
          origin: "human",
          tags: "",
        }),
      );
    }
    for (const c of get("library_evolution_candidates")) {
      const s = visibleNotes.get(c.after_id);
      if (
        !s ||
        !visibleNotes.has(c.before_id) ||
        c.status !== "accepted" ||
        !(
          c.provenance?.modelDigest === "manual" ||
          get("library_analysis_feedback").some(
            (f) =>
              f.candidate_id === c.id &&
              f.decision === "accept" &&
              f.corrected_output?.explanation === c.comparison?.explanation &&
              f.corrected_output?.explanation !==
                f.original_output?.explanation,
          )
        )
      )
        continue;
      data.entries.push(
        entry("note", s, c.comparison?.explanation ?? "", "self", {
          id: "e:" + c.id,
          title: "내 생각 연결 · " + s.title,
          coverage: "full",
          origin: "human",
          tags: "",
        }),
      );
    }
    return serialized(data);
  }
  async function load(): Promise<LocalIndex> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const cp = await storage.checkpoint();
      if (!cp?.complete)
        throw new ReplicaQueryError(503, "기기 자료를 준비하고 있습니다.");
      const stamp = indexStamp(cp),
        token = cp.generation + "\0" + stamp;
      if (cached?.token === token) return cached.data;
      const persisted = await storage.readIndex(
        "query-index-v1",
        cp.generation,
      );
      let data: LocalIndex;
      if (persisted?.stamp === stamp) data = persisted.data;
      else {
        data = await build(cp.generation);
        const latest = await storage.checkpoint();
        if (
          latest?.generation !== cp.generation ||
          indexStamp(latest) !== stamp
        )
          continue;
        await storage.transaction((tx) =>
          tx.putIndex(cp.generation, "query-index-v1", {
            stamp,
            data,
          }),
        );
      }
      await worker.initialize(data);
      cached = { token, data };
      return data;
    }
    throw new ReplicaQueryError(
      409,
      "기기 자료를 갱신하고 있습니다. 다시 시도해 주세요.",
    );
  }
  const index = () =>
    (loading ??= load().finally(() => {
      loading = undefined;
    }));
  async function query<T>(kind: QueryKind, input: unknown): Promise<T> {
    await index();
    return worker.query(kind, input);
  }
  async function detailBook(id: string): Promise<Book> {
    z.string().uuid().parse(id);
    const data = await index();
    const compact = data.books.find((b) => b.book.id === id)?.book;
    if (!compact || data.excluded.includes(id))
      throw new ReplicaQueryError(404, "책을 찾을 수 없습니다.");
    const value = await raw("library_books", id);
    if (!value) throw new ReplicaQueryError(404, "책을 찾을 수 없습니다.");
    return serialized({
      ...projectBook(value),
      catalogCoverUrl: compact.catalogCoverUrl,
      storedCoverUrl: compact.storedCoverUrl,
      storedImportedCoverUrl: compact.storedImportedCoverUrl,
    });
  }
  const resources = createResourceReader(storage, { raw, records, index });
  const repository = {
    books: (input: unknown = {}) => query<BookPage>("books", input),
    notes: (input: unknown = {}) => query<any>("notes", input),
    reading: (input: unknown = {}) => query<any>("reading", input),
    calendar: (month: string) => query<any>("calendar", month),
    search: (input: unknown) => query<any>("search", input),
    book: detailBook,
    async note(id: string, trash = false): Promise<Note> {
      z.string().uuid().parse(id);
      const data = await index();
      if (
        trash ? !Object.hasOwn(data.trash, id) : Object.hasOwn(data.trash, id)
      )
        throw new ReplicaQueryError(404, "기록을 찾을 수 없습니다.");
      const r = await raw("library_notes", id);
      if (!r) throw new ReplicaQueryError(404, "기록을 찾을 수 없습니다.");
      return projectNote(r);
    },
    async overview(): Promise<Library> {
      const data = await index(),
        firstPage = await repository.books(),
        ids = new Set([
          ...firstPage.items.map((b) => b.id),
          ...(data.connectionBooks ?? []),
          ...data.cycles.map((c) => c.bookId),
          ...activeNotes(data).flatMap((n) => (n.bookId ? [n.bookId] : [])),
        ]),
        all = activeBooks(data),
        formatCounts = { paper: 0, pdf: 0, ebook: 0, unknown: 0 },
        categoryCounts: Record<string, number> = {};
      for (const { book: b } of all) {
        categoryCounts[b.category ?? ""] =
          (categoryCounts[b.category ?? ""] ?? 0) + 1;
        for (const f of b.formats) formatCounts[f]++;
      }
      return serialized({
        books: all.filter((b) => ids.has(b.book.id)).map((b) => b.book),
        cycles: activeCycles(data).filter((c) => c.status === "reading"),
        notes: activeNotes(data)
          .sort(
            (a, b) =>
              binaryCompare(b.updatedAt, a.updatedAt) ||
              binaryCompare(a.id, b.id),
          )
          .map((n) => data.previews[n.id]),
        deletedNotes: data.notes
          .filter((n) => Object.hasOwn(data.trash, n.id))
          .sort(
            (a, b) =>
              binaryCompare(b.updatedAt, a.updatedAt) ||
              binaryCompare(a.id, b.id),
          )
          .map((n) => ({
            ...data.previews[n.id],
            deletedAt: data.trash[n.id],
          })),
        shelves: data.shelves,
        annualMetrics: data.annualMetrics,
        readingSummary: readingSummary(data),
        catalog: { total: all.length, formatCounts, categoryCounts, firstPage },
      });
    },
    async history(id: string): Promise<Revision[]> {
      z.string().uuid().parse(id);
      const cp = await storage.checkpoint();
      if (!cp) throw new ReplicaQueryError(503, "기기 자료가 없습니다.");
      const stamp = cp.entityRevisions?.library_revisions ?? "0";
      let indexed = (await storage.readIndex(
        "revision-index-v1",
        cp.generation,
      )) as { stamp: string; entities: Record<string, string[]> } | undefined;
      if (indexed?.stamp !== stamp) {
        const compact: Record<string, { id: string; created: string }[]> =
          Object.create(null);
        for await (const row of records("library_revisions", cp.generation))
          (compact[row.entity_id] ??= []).push({
            id: row.id,
            created: timestampKey(row.created_at),
          });
        indexed = {
          stamp,
          entities: Object.fromEntries(
            Object.entries(compact).map(([entity, rows]) => [
              entity,
              rows
                .sort(
                  (a, b) =>
                    binaryCompare(a.created, b.created) ||
                    binaryCompare(a.id, b.id),
                )
                .map((r) => r.id),
            ]),
          ),
        };
        const latest = await storage.checkpoint();
        if (
          latest?.generation !== cp.generation ||
          (latest.entityRevisions?.library_revisions ?? "0") !== stamp
        )
          throw new ReplicaQueryError(
            409,
            "수정 이력을 갱신하고 있습니다. 다시 시도해 주세요.",
          );
        await storage.transaction((tx) =>
          tx.putIndex(cp.generation, "revision-index-v1", indexed),
        );
      }
      const result: Revision[] = [];
      for (const revisionId of indexed.entities[id] ?? []) {
        const value = await raw("library_revisions", revisionId, cp.generation);
        if (value) result.push(projectRevision(value));
      }
      return result;
    },
    async read(route: string): Promise<unknown> {
      const url = new URL(route, "https://local.invalid"),
        p = url.searchParams,
        path = url.pathname;
      if (path === "/api/library") return repository.overview();
      if (path === "/api/library-materials") {
        const q = Object.fromEntries(p),
          offset = Number(p.get("offset") ?? 0),
          limit = Number(p.get("limit") ?? 30);
        const notes = await repository.notes(q),
          books = await repository.books({
            ...q,
            sort: "title",
            offset: Math.max(0, offset - notes.total),
            limit: Math.max(1, limit - notes.items.length),
          });
        return {
          total: notes.total + books.total,
          items: [
            ...notes.items.map((n: any) => ({
              id: n.id,
              kind: "note",
              title: n.title,
              text: n.content,
              category: n.bookCategory ?? "",
              version: n.version,
            })),
            ...books.items
              .slice(0, limit - notes.items.length)
              .map((b) => ({
                id: b.id,
                kind: "book",
                title: b.title,
                text: [b.author, b.publisher].filter(Boolean).join(" · "),
                category: b.category ?? "",
                version: b.version,
              })),
          ],
        };
      }
      if (path === "/api/library-search/topics") {
        const data = await index();
        return {
          topics: data.topics
            .filter((t) => t.confirmed)
            .sort(
              (a, b) =>
                binaryCompare(a.name, b.name) || binaryCompare(a.id, b.id),
            )
            .map((t) => ({
              id: t.id,
              name: t.name,
              parentId: t.parent_id,
              aliases: t.aliases,
            })),
        };
      }
      if (path === "/api/note-tags") {
        const data = await index(),
          groups = new Map<string, Note[]>();
        for (const note of data.notes)
          for (const tag of note.tags ?? [])
            groups.set(tag, [...(groups.get(tag) ?? []), note]);
        const result = [];
        for (const [tag, notes] of [...groups].sort(([a], [b]) =>
          a.localeCompare(b, "ko"),
        )) {
          const text = JSON.stringify(
            notes
              .map((n) => [n.id, n.version])
              .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          );
          const { sha256Bytes } = await import("../../lib/replica/codec");
          result.push({
            tag,
            count: notes.length,
            activeCount: notes.filter((n) => !Object.hasOwn(data.trash, n.id))
              .length,
            fingerprint: await sha256Bytes(new TextEncoder().encode(text)),
          });
        }
        return result;
      }
      if (path === "/api/books") {
        if (p.has("ids")) {
          const data = await index(),
            ids = new Set(p.get("ids")!.split(","));
          const items = activeBooks(data)
            .filter((b) => ids.has(b.book.id))
            .sort(
              (a, b) =>
                binaryCompare(a.book.title, b.book.title) ||
                binaryCompare(a.book.id, b.book.id),
            )
            .map((b) => b.book);
          return { items, total: items.length, nextCursor: null };
        }
        return repository.books(Object.fromEntries(p));
      }
      if (/^\/api\/books\/[^/]+$/.test(path))
        return repository.book(path.split("/").at(-1)!);
      if (path === "/api/notes") return repository.notes(Object.fromEntries(p));
      if (/^\/api\/notes\/[^/]+$/.test(path))
        return repository.note(
          path.split("/").at(-1)!,
          p.get("trash") === "true",
        );
      if (path === "/api/reading")
        return p.has("month")
          ? repository.calendar(p.get("month")!)
          : repository.reading(Object.fromEntries(p));
      if (path.startsWith("/api/revisions/"))
        return repository.history(path.split("/").at(-1)!);
      if (path === "/api/library-search")
        return repository.search({
          text: p.get("text") ?? "",
          layer: p.get("layer") ?? "all",
          topicId: p.get("topicId") ?? undefined,
          topicScope: p.get("topicScope") ?? "exact",
          expandAliases: p.get("expandAliases") === "true",
          limit: p.has("limit") ? Number(p.get("limit")) : undefined,
          offset: p.has("offset") ? Number(p.get("offset")) : undefined,
          cursor: p.get("cursor") ?? undefined,
        });
      const resource = await resources.read(path, p);
      if (resource.handled) return resource.value;
      throw new UnsupportedLocalRoute(path);
    },
    async index() {
      return index();
    },
    async raw(entity: SyncEntity, id: string) {
      return raw(entity, id);
    },
    async all(entity: SyncEntity) {
      const cp = await storage.checkpoint();
      if (!cp) throw new ReplicaQueryError(503, "기기 자료가 없습니다.");
      const values = [];
      for await (const row of records(entity, cp.generation)) values.push(row);
      return values;
    },
    async exportData() {
      const cp = await storage.checkpoint();
      if (!cp?.complete)
        throw new ReplicaQueryError(503, "기기 자료를 준비하고 있습니다.");
      const tables: Partial<Record<SyncEntity, RawRecord[]>> = {};
      for (const entity of Object.keys(syncEntities) as SyncEntity[]) {
        const values = [];
        for await (const r of records(entity, cp.generation)) values.push(r);
        tables[entity] = values;
      }
      const latest = await storage.checkpoint();
      if (latest?.generation !== cp.generation || latest.cursor !== cp.cursor)
        throw new ReplicaQueryError(
          409,
          "동기화 중입니다. 완료 후 다시 내려받으세요.",
        );
      return {
        format: "knowledge-library-device-export-v1",
        createdAt: new Date().toISOString(),
        owner: storage.owner,
        checkpoint: cp,
        tables,
        outbox: await storage.listOutbox(),
        conflicts: await storage.listConflicts(),
      };
    },
    invalidate() {
      cached = undefined;
    },
    close() {
      worker.close();
      cached = undefined;
    },
  };
  return repository;
}
export type ReplicaRepository = ReturnType<typeof createReplicaRepository>;
