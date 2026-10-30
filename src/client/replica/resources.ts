import { z } from "zod";
import { containsSearchField } from "../../lib/search-fields";
import type { ReplicaStorage } from "./storage";
import type { SyncEntity } from "../../lib/replica/entities";
import type { RawRecord } from "../../lib/replica/projections";
import {
  binaryCompare,
  iso,
  projectBook,
  projectNote,
  timestampKey,
} from "../../lib/replica/projections";
import { defaultAiPolicy } from "../../lib/library-ai-policy";
import { resolveThoughtRecord, withEvent } from "../../lib/thought-map/records";
import { ReplicaQueryError } from "./queries";
import type { LocalIndex } from "./queries";
import { createWhiteboardReader } from "./whiteboard-reader";
import { WHITEBOARD_ID, boardSaveSchema } from "../../lib/whiteboard";
import {
  planThoughtBoxPromotion,
  sharedBoxSummaries,
} from "../../lib/shared-thought-boxes";
import {
  noteVisibilitySchema,
  whiteboardNoteVisible,
} from "../../lib/whiteboard-visibility";
type Reader = {
  raw(e: SyncEntity, id: string, g?: string): Promise<RawRecord | undefined>;
  records(e: SyncEntity, g: string): AsyncGenerator<RawRecord>;
  index(): Promise<LocalIndex>;
};
const order = (a: RawRecord, b: RawRecord) =>
  binaryCompare(timestampKey(a.created_at), timestampKey(b.created_at)) ||
  binaryCompare(a.id, b.id);
const dateRow = (row: RawRecord) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      v && /(_at|last_seen)$/.test(k) ? iso(v) : v,
    ]),
  );
const camel = (row: RawRecord) =>
  Object.fromEntries(
    Object.entries(dateRow(row)).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      v,
    ]),
  );
const fields = (row: RawRecord, keys: string[]) =>
  Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
export function createResourceReader(storage: ReplicaStorage, reader: Reader) {
  const readWhiteboard = createWhiteboardReader(storage, {
    raw: reader.raw,
    all: (e) => all(e),
  });
  // Only compact lookup fields are indexed; large review originals are read on demand.
  async function selected(
    e: SyncEntity,
    predicate: (r: RawRecord) => boolean = () => true,
  ): Promise<RawRecord[]> {
    const cp = await storage.checkpoint();
    if (!cp?.complete)
      throw new ReplicaQueryError(503, "기기 자료를 준비하고 있습니다.");
    const key = "resource-index-v1:" + e,
      stamp =
        (cp.entityRevisions?.[e] ?? "0") +
        ":" +
        (cp.localEntityRevisions?.[e] ?? 0) +
        ":" +
        (cp.entityWrites?.[e] ?? 0);
    let saved = await storage.readIndex(key, cp.generation);
    if (saved?.stamp !== stamp) {
      const rows = [];
      for await (const r of reader.records(e, cp.generation)) {
        const value = {
          ...fields(r, [
            "id",
            "book_id",
            "source_kind",
            "source_id",
            "state",
            "entity_id",
            "created_at",
            "retrieved_at",
            "status",
          ]),
          id: String(r.id ?? r.request_id ?? r.year ?? ""),
        };
        if (e === "library_catalog_reviews")
          Object.assign(value, {
            title: r.book_snapshot?.title ?? null,
            candidate_title: r.record?.title ?? null,
            isbn: r.record?.isbn ?? null,
            author: r.record?.facts?.author ?? null,
            publisher: r.record?.facts?.publisher ?? null,
            version: r.version,
            precheck: r.decision?.precheck ?? null,
          });
        if (e === "library_book_exclusions")
          Object.assign(value, fields(r, ["kind", "reason", "version"]));
        if (e === "library_documents")
          Object.assign(value, fields(r, ["relative_path"]));
        rows.push(value);
      }
      const latest = await storage.checkpoint();
      if (
        latest?.generation !== cp.generation ||
        (latest.entityRevisions?.[e] ?? "0") +
          ":" +
          (latest.localEntityRevisions?.[e] ?? 0) +
          ":" +
          (latest.entityWrites?.[e] ?? 0) !==
          stamp
      )
        throw new ReplicaQueryError(
          409,
          "자료를 갱신하고 있습니다. 다시 시도해 주세요.",
        );
      saved = { stamp, rows };
      await storage.transaction((tx) => tx.putIndex(cp.generation, key, saved));
    }
    const result = [];
    for (const row of saved.rows as RawRecord[])
      if (predicate(row)) {
        const full = await reader.raw(e, row.id, cp.generation);
        if (full) result.push(dateRow(full));
      }
    return result;
  }
  async function current(kind: string, id: string) {
    z.enum(["book", "note"]).parse(kind);
    z.string().uuid().parse(id);
    const row = await reader.raw(
      kind === "book" ? "library_books" : "library_notes",
      id,
    );
    const hidden = await reader.raw(
      kind === "book" ? "library_book_exclusions" : "library_note_trash",
      id,
    );
    if (
      !row ||
      (kind === "book"
        ? hidden?.state === "excluded"
        : hidden?.restored_at === null)
    )
      throw new ReplicaQueryError(404, "자료를 찾을 수 없습니다.");
    if (
      kind === "book" &&
      row.source_data?.app === "Local PDF" &&
      !(await selected("library_documents", (d) => d.book_id === id)).some(
        (d) => d.processing_scope === "full",
      )
    )
      throw new ReplicaQueryError(409, "정비 대상 도서가 아닙니다.");
    return row;
  }
  async function all(e: SyncEntity) {
    const cp = await storage.checkpoint();
    if (!cp?.complete)
      throw new ReplicaQueryError(503, "기기 자료를 준비하고 있습니다.");
    const stamp = (state: typeof cp) =>
      `${state?.entityRevisions?.[e] ?? "0"}:${state?.localEntityRevisions?.[e] ?? 0}:${state?.entityWrites?.[e] ?? 0}`;
    const rows = [];
    for await (const row of reader.records(e, cp.generation))
      rows.push(dateRow(row));
    const latest = await storage.checkpoint();
    if (latest?.generation !== cp.generation || stamp(latest) !== stamp(cp))
      throw new ReplicaQueryError(
        409,
        "자료를 갱신하고 있습니다. 다시 시도해 주세요.",
      );
    return rows;
  }
  async function compact(e: SyncEntity) {
    await selected(e, () => false);
    const cp = (await storage.checkpoint())!;
    return (await storage.readIndex("resource-index-v1:" + e, cp.generation))
      .rows as RawRecord[];
  }
  async function curation(kind: string, id: string) {
    const source = await current(kind, id),
      cs = (
        await selected(
          "library_curation_items",
          (r) =>
            r.source_kind === kind &&
            r.source_id === id &&
            r.state !== "rolled_back",
        )
      ).sort(order),
      docs =
        kind === "book"
          ? await selected("library_documents", (d) => d.book_id === id)
          : [];
    const items = cs.map((c) => {
      const document_current =
        !(
          c.kind === "toc" &&
          [
            "embedded_outline",
            "edited_outline",
            "printed_toc_excerpt",
          ].includes(c.value?.method)
        ) ||
        docs.some(
          (d) =>
            d.id === c.value?.documentId &&
            d.processing_scope === "full" &&
            `${d.bytes}:${d.mtime_ns}` === c.value?.signature,
        );
      return {
        ...fields(c, [
          "id",
          "kind",
          "value",
          "evidence",
          "coverage",
          "origin",
          "generator",
          "state",
          "version",
          "reviewed_by",
          "source_version",
        ]),
        document_current,
        source_stale:
          c.source_version !== String(source.version) || !document_current,
      };
    });
    const references = (
      await selected(
        "library_reference_sources",
        (r) => r.source_kind === kind && r.source_id === id,
      )
    )
      .sort((a, b) => binaryCompare(b.retrieved_at, a.retrieved_at))
      .slice(0, 100)
      .map((r) =>
        fields(r, [
          "id",
          "url",
          "provider",
          "title",
          "retrieved_at",
          "edition_match",
        ]),
      );
    const ids = new Set(cs.map((c) => c.id));
    const history = (
      await selected("library_field_origins", (r) => ids.has(r.entity_id))
    )
      .sort((a, b) => -order(a, b))
      .slice(0, 100)
      .map((r) =>
        fields(r, [
          "entity_id",
          "origin",
          "generator",
          "reviewer",
          "created_at",
        ]),
      );
    return { items, references, history, version: String(source.version) };
  }
  async function buildThoughtMap() {
    const trash = new Set(
        (await all("library_note_trash"))
          .filter((t) => t.restored_at === null)
          .map((t) => t.id),
      ),
      excluded = new Set(
        (await all("library_book_exclusions"))
          .filter((t) => t.state === "excluded")
          .map((t) => t.id),
      );
    const notes = (await all("library_notes")).filter((n) => !trash.has(n.id)),
      saved = (await all("library_thought_events")).map(camel),
      records = new Map(),
      events = [];
    for (const n of notes) {
      const base = resolveThoughtRecord(projectNote(n));
      const event = saved.find((e) => e.noteId === n.id) ?? {
        id: n.id,
        noteId: n.id,
        occurredOn: base.occurredOn,
        dateSource: base.dateSource,
        voice: base.voice,
        version: 0,
      };
      events.push(event);
      records.set(n.id, withEvent(base, event as any));
    }
    const same = (a: any, b: any) =>
      !!b &&
      [
        "id",
        "version",
        "eventVersion",
        "contentHash",
        "voice",
        "occurredOn",
      ].every((k) => a?.[k] === b[k]);
    const allTopics = await all("library_topics");
    return {
      notes: notes.map((n) => projectNote(n)),
      topics: allTopics.filter((t) => !t.archived_at).map(camel),
      archivedTopics: allTopics.filter((t) => !!t.archived_at).map(camel),
      memberships: (await all("library_topic_memberships"))
        .filter((m) =>
          m.source_kind === "note"
            ? records.has(m.source_id)
            : m.source_kind !== "book" || !excluded.has(m.source_id),
        )
        .map(camel),
      topicLinks: (await all("library_topic_links")).map(camel),
      events,
      candidates: (await all("library_evolution_candidates"))
        .filter((r) => records.has(r.before_id) && records.has(r.after_id))
        .map((r) => ({
          id: r.id,
          comparison: r.comparison,
          before: r.before_record,
          after: r.after_record,
          topicId: r.topic_id,
          provenance: r.provenance,
          context: r.context,
          status: r.status,
          version: r.version,
          createdAt: r.created_at,
          pairKey: r.pair_key,
          outdated:
            !same(r.before_record, records.get(r.before_id)) ||
            !same(r.after_record, records.get(r.after_id)),
        })),
      feedback: (await all("library_analysis_feedback")).map(camel),
    };
  }
  async function thoughtMap() {
    const tables: SyncEntity[] = [
      "library_notes",
      "library_note_trash",
      "library_book_exclusions",
      "library_thought_events",
      "library_topics",
      "library_topic_memberships",
      "library_topic_links",
      "library_evolution_candidates",
      "library_analysis_feedback",
    ];
    const cp = await storage.checkpoint();
    if (!cp?.complete)
      throw new ReplicaQueryError(503, "기기 자료를 준비하고 있습니다.");
    const stamp = (state: typeof cp) =>
      JSON.stringify(
        tables.map((e) => [
          e,
          state?.entityRevisions?.[e] ?? "0",
          state?.localEntityRevisions?.[e] ?? 0,
          state?.entityWrites?.[e] ?? 0,
        ]),
      );
    const token = stamp(cp),
      key = "thought-map-view-v1";
    const cached = await storage.readIndex(key, cp.generation);
    if (cached?.stamp === token) return cached.value;
    const value = await buildThoughtMap();
    const latest = await storage.checkpoint();
    if (latest?.generation !== cp.generation || stamp(latest) !== token)
      throw new ReplicaQueryError(
        409,
        "자료를 갱신하고 있습니다. 다시 시도해 주세요.",
      );
    await storage.transaction((tx) =>
      tx.putIndex(cp.generation, key, { stamp: token, value }),
    );
    return value;
  }
  async function assist() {
    const policy = (await all("library_ai_policy"))[0],
      results = await all("library_assist_results"),
      usage = await all("library_ai_usage"),
      groups = new Map<
        string,
        { phase: string; status: string; spent: bigint; reserved: bigint }
      >();
    const units = (v: any) => {
        const [a, b = ""] = String(v ?? 0).split(".");
        return BigInt(a) * 1000000n + BigInt(b.padEnd(6, "0").slice(0, 6));
      },
      money = (v: bigint) =>
        `${v / 1000000n}.${String(v % 1000000n).padStart(6, "0")}`;
    for (const u of usage) {
      const pending = ["reserved", "sending", "unknown"].includes(u.status);
      if (
        u.period !== new Date().toISOString().slice(0, 7) &&
        u.phase !== "development" &&
        !pending
      )
        continue;
      const key = u.phase + ":" + u.status,
        g = groups.get(key) ?? {
          phase: u.phase,
          status: u.status,
          spent: 0n,
          reserved: 0n,
        };
      g.spent += units(u.cost_usd);
      if (pending) g.reserved += units(u.max_cost_usd);
      groups.set(key, g);
    }
    const cp = await storage.checkpoint(),
      cap = cp
        ? await storage.readIndex("online-capabilities", cp.generation)
        : null;
    return {
      policy: policy
        ? {
            runtimeMode: "manual_only",
            requestsEnabled: policy.requests_enabled,
            developmentLimitUsd: policy.development_limit_usd,
            runtimeMonthlyLimitUsd: policy.runtime_monthly_limit_usd,
            requestLimitUsd: policy.request_limit_usd,
            version: policy.version,
          }
        : { ...defaultAiPolicy },
      requests: (await all("library_assist_requests"))
        .filter((r) => !r.hidden_at)
        .sort(
          (a, b) =>
            binaryCompare(b.created_at, a.created_at) ||
            binaryCompare(a.id, b.id),
        )
        .slice(0, 30)
        .map((r) => ({
          ...fields(r, [
            "id",
            "purpose",
            "status",
            "error_code",
            "created_at",
            "updated_at",
          ]),
          id: r.id,
          scope: {
            model: r.task?.model ?? "gpt-6-luna",
            focus: r.task?.payload?.focus,
            sources: r.task?.payload?.sources?.map((s: any) => s.source) ?? [],
          },
          result: results.find((s) => s.request_id === r.id)?.result ?? null,
          adoption:
            results.find((s) => s.request_id === r.id)?.adoption ?? null,
        })),
      usage: [...groups.values()].map((g) => ({
        ...g,
        spent: money(g.spent),
        reserved: money(g.reserved),
      })),
      workers: cap?.workers ?? [],
      execution: cap?.execution ?? "unavailable",
      comparisonEnabled: cap?.comparisonEnabled ?? false,
    };
  }
  return {
    async read(
      path: string,
      p: URLSearchParams,
    ): Promise<{ handled: true; value: unknown } | { handled: false }> {
      let value: unknown;
      if (path === "/api/thought-boxes") {
        const projects = await all("library_research"),
          boards = (await all("library_whiteboards")).filter(
            (b) =>
              b.id === WHITEBOARD_ID || projects.some((p) => p.id === b.id),
          ),
          bundles = await all("library_memo_bundles");
        const pendingLegacy = boards.some((b) =>
          b.data.writing?.chapters.some((c: any) => !c.bundleId),
        );
        const plan = pendingLegacy
          ? planThoughtBoxPromotion(boards as any, bundles as any)
          : null;
        value = {
          pendingLegacy,
          items: sharedBoxSummaries((plan?.bundles ?? bundles) as any),
          ...(plan
            ? { legacyConflicts: plan.conflicts, legacyToken: plan.legacyToken }
            : {}),
        };
      } else if (path === "/api/whiteboard") {
        const boardId =
          boardSaveSchema.shape.boardId.parse(p.get("boardId") ?? undefined) ??
          WHITEBOARD_ID;
        if (p.get("view") === "summary") {
          if (
            boardId !== WHITEBOARD_ID &&
            !(await reader.raw("library_research", boardId))
          )
            throw new ReplicaQueryError(404, "글감 묶음을 찾을 수 없습니다.");
          value = {
            id: boardId,
            version:
              (await reader.raw("library_whiteboards", boardId))?.version ?? 0,
          };
        } else if (p.get("view") === "visibility") {
          if (
            boardId !== WHITEBOARD_ID &&
            !(await reader.raw("library_research", boardId))
          )
            throw new ReplicaQueryError(404, "글감 묶음을 찾을 수 없습니다.");
          const id = noteVisibilitySchema.shape.noteId.parse(p.get("noteId"));
          const n = await reader.raw("library_notes", id),
            trash = await reader.raw("library_note_trash", id);
          if (!n || trash?.restored_at === null)
            throw new ReplicaQueryError(404, "메모를 찾을 수 없습니다.");
          const board = await reader.raw("library_whiteboards", boardId);
          value = { visible: whiteboardNoteVisible(board?.data, id) };
        } else value = await readWhiteboard(boardId);
      } else if (path === "/api/knowledge") {
        const notes = new Set((await all("library_notes")).map((n) => n.id)),
          books = new Set((await all("library_books")).map((b) => b.id));
        for (const t of await all("library_note_trash"))
          if (t.restored_at === null) notes.delete(t.id);
        for (const e of await all("library_book_exclusions"))
          if (e.state === "excluded") books.delete(e.id);
        const active = (k: string, id: string) =>
          (k === "note" ? notes : books).has(id);
        value = {
          connections: (await all("library_connections"))
            .filter(
              (c) =>
                active(c.source_kind, c.source_id) &&
                active(c.target_kind, c.target_id),
            )
            .sort(
              (a, b) =>
                binaryCompare(b.created_at, a.created_at) ||
                binaryCompare(a.id, b.id),
            ),
          research: (await all("library_research")).sort(
            (a, b) =>
              binaryCompare(b.created_at, a.created_at) ||
              binaryCompare(a.id, b.id),
          ),
          items: (await all("library_research_items")).sort(order),
          placements: (await all("library_research_placements")).sort(
            (a, b) => a.position - b.position || binaryCompare(a.id, b.id),
          ),
        };
      } else if (path === "/api/thought-map") value = await thoughtMap();
      else if (path === "/api/thought-devices")
        value = (await all("library_analysis_devices"))
          .sort((a, b) => -order(a, b))
          .map(camel);
      else if (path === "/api/assist") {
        const assistState = await assist();
        value = p.has("id")
          ? {
              ...assistState,
              requests: assistState.requests.filter(
                (r) => r.id === z.string().uuid().parse(p.get("id")),
              ),
            }
          : assistState;
      } else if (path === "/api/curation")
        value = await curation(p.get("kind") ?? "", p.get("id") ?? "");
      else if (path === "/api/book-introduction") {
        const id = z.string().uuid().parse(p.get("id")),
          b = await current("book", id),
          row = (
            await selected(
              "library_book_introductions",
              (r) => r.book_id === id,
            )
          )[0],
          cs = (
            await selected(
              "library_curation_items",
              (r) =>
                r.source_kind === "book" &&
                r.source_id === id &&
                r.state === "active",
            )
          )
            .filter(
              (c) =>
                c.source_version === String(b.version) &&
                c.kind === "publisher_intro",
            )
            .sort((a, b) => -order(a, b)),
          references = [];
        for (const c of cs) {
          const r = await reader.raw(
            "library_reference_sources",
            c.evidence?.referenceId ?? "",
          );
          if (r)
            references.push({
              id: c.id,
              value: c.value,
              url: r.url,
              provider: r.provider,
            });
          if (references.length === 10) break;
        }
        value = {
          introduction: row
            ? {
                ...fields(row, ["text", "sources", "version"]),
                bookVersion: row.book_version,
                updatedAt: row.updated_at,
              }
            : null,
          references,
          bookVersion: b.version,
        };
      } else if (path === "/api/book-exclusions") {
        const q = (p.get("q") ?? "").toLowerCase(),
          limit = z.coerce
            .number()
            .int()
            .min(1)
            .max(50)
            .parse(p.get("limit") ?? 30),
          offset = z.coerce
            .number()
            .int()
            .nonnegative()
            .parse(p.get("offset") ?? 0),
          items = [];
        const books = new Map(
            (await reader.index()).books.map((b) => [b.book.id, b.book]),
          ),
          paths = new Map<string, string>();
        for (const d of await compact("library_documents")) {
          const old = paths.get(d.book_id);
          if (!old || binaryCompare(d.relative_path, old) < 0)
            paths.set(d.book_id, d.relative_path);
        }
        for (const e of (await compact("library_book_exclusions")).filter(
          (r) => r.state === "excluded",
        )) {
          const b = books.get(e.id);
          if (
            !b ||
            !containsSearchField([b.title, b.author, b.isbn].join(" "), q)
          )
            continue;
          items.push({
            id: e.id,
            title: b.title,
            author: b.author,
            kind: e.kind,
            reason: e.reason,
            relativePath: paths.get(e.id) ?? "",
            excludedAt: e.created_at,
            version: e.version,
          });
        }
        items.sort(
          (a, b) =>
            binaryCompare(a.title, b.title) || binaryCompare(a.id, b.id),
        );
        value = {
          total: items.length,
          items: items.slice(offset, offset + limit),
        };
      } else if (path === "/api/book-relations") {
        const id = z.string().uuid().parse(p.get("bookId"));
        const source = await current("book", id);
        const index = await reader.index();
        const normalizedIsbn = (v: string) =>
          v.replace(/[^0-9Xx]/g, "").toUpperCase();
        const isbn = normalizedIsbn(source.isbn ?? "");
        value = {
          source,
          localAvailable: false,
          candidates: isbn
            ? index.books
                .map((r) => r.book)
                .filter(
                  (b) =>
                    b.id !== id &&
                    !index.excluded.includes(b.id) &&
                    normalizedIsbn(b.isbn) === isbn,
                )
                .slice(0, 50)
            : [],
          relations: [],
        };
        for (const r of (await all("library_book_relations"))
          .filter((r) => r.left_id === id || r.right_id === id)
          .sort(order)) {
          let a, b;
          try {
            a = await current("book", r.left_id);
            b = await current("book", r.right_id);
          } catch {
            continue;
          }
          let freshness =
            r.state !== "accepted"
              ? "not_applicable"
              : [a, b].some(
                    (v) =>
                      r.evidence?.books?.find((s: any) => s.id === v.id)
                        ?.version !== v.version,
                  )
                ? "stale"
                : r.relation === "same_file"
                  ? "unavailable"
                  : "current";
          if (
            freshness === "unavailable" &&
            r.evidence?.file?.documents?.length === 2
          ) {
            const docs = await all("library_documents");
            if (
              r.evidence.file.documents.some(
                (d: any) =>
                  !docs.some(
                    (c) =>
                      c.id === d.id &&
                      `${c.bytes}:${c.mtime_ns}` === d.signature,
                  ),
              )
            )
              freshness = "stale";
          }
          (value as { relations: any[] }).relations.push({
            ...r,
            left_title: a.title,
            right_title: b.title,
            left_version: a.version,
            right_version: b.version,
            freshness,
          });
        }
      } else if (path === "/api/catalog-review") {
        const status = z
            .enum(["pending", "deferred", "rejected", "applied", "superseded"])
            .parse(p.get("status") ?? "pending"),
          q = (p.get("q") ?? "").toLowerCase(),
          offset = z.coerce
            .number()
            .int()
            .nonnegative()
            .parse(p.get("offset") ?? 0),
          limit = z.coerce
            .number()
            .int()
            .min(1)
            .max(50)
            .parse(p.get("limit") ?? 20),
          id = p.get("id"),
          group = p.get("groupBy") ?? "candidate";
        if (id) {
          z.string().uuid().parse(id);
          const r = await reader.raw("library_catalog_reviews", id),
            b = r ? await reader.raw("library_books", r.book_id) : null;
          if (!r || !b)
            throw new ReplicaQueryError(404, "후보를 찾을 수 없습니다.");
          const alternatives = (
            await selected(
              "library_catalog_reviews",
              (c) => c.book_id === b.id && c.status === r.status,
            )
          )
            .sort(
              (a, c) =>
                Number(c.record?.isbn === b.isbn) -
                  Number(a.record?.isbn === b.isbn) || order(a, c),
            )
            .map((c) => ({
              id: c.id,
              title: c.record?.title ?? null,
              isbn: c.record?.isbn ?? null,
              author: c.record?.facts?.author ?? null,
              publisher: c.record?.facts?.publisher ?? null,
            }));
          const book = projectBook(b);
          value = {
            ...dateRow(r),
            current_version: b.version,
            current: fields(book, [
              "id",
              "title",
              "author",
              "publisher",
              "isbn",
              "coverUrl",
              "version",
            ]),
            alternatives,
          };
        } else {
          // Read compact projections, not full provider payloads for every page.
          const cp = (await storage.checkpoint())!;
          await selected("library_catalog_reviews", () => false);
          let rows = (
            (
              await storage.readIndex(
                "resource-index-v1:library_catalog_reviews",
                cp.generation,
              )
            ).rows as RawRecord[]
          )
            .filter(
              (r) =>
                r.status === status &&
                (containsSearchField(String(r.title ?? ""), q) ||
                  containsSearchField(String(r.candidate_title ?? ""), q)),
            )
            .sort(order);
          if (group === "book") {
            const books = new Map(
              (await reader.index()).books.map((b) => [b.book.id, b.book]),
            );
            const groups = new Map<string, RawRecord[]>();
            for (const r of rows)
              groups.set(r.book_id, [...(groups.get(r.book_id) ?? []), r]);
            rows = [];
            for (const [bookId, rs] of groups) {
              const b = books.get(bookId);
              if (!b) continue;
              rs.sort(
                (a, c) =>
                  Number(c.isbn === b.isbn) - Number(a.isbn === b.isbn) ||
                  order(a, c),
              );
              rows.push({ ...rs[0], candidateCount: rs.length });
            }
            rows.sort(order);
          }
          const items = rows.slice(offset, offset + limit).map((r) => ({
            ...fields(r, [
              "id",
              "book_id",
              "title",
              "candidate_title",
              "isbn",
              "status",
              "version",
              "precheck",
            ]),
            ...(group === "book" ? { candidateCount: r.candidateCount } : {}),
          }));
          value = {
            items,
            total: rows.length,
            nextOffset:
              offset + items.length < rows.length
                ? offset + items.length
                : null,
          };
        }
      } else return { handled: false };
      return { handled: true, value };
    },
  };
}
