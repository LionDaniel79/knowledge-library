import { z } from "zod";
import { noteContextId } from "../../lib/note-context";
import { introductionSchema } from "../../lib/book-introduction";
import { reviewDecisionSchema } from "../../lib/catalog-review";
import {
  bookInput,
  noteInput,
  dateInput,
  commandInput,
} from "../../lib/domain";
import type { RawRecord } from "../../lib/replica/projections";
import { projectNote } from "../../lib/replica/projections";
import type { SyncEntity } from "../../lib/replica/entities";
import { syncKey } from "../../lib/replica/entities";
import { ReplicaQueryError } from "./queries";
import type { ReplicaRepository } from "./repository";
import {
  resolveThoughtRecord,
  withEvent,
  contentHash,
} from "../../lib/thought-map/records";
import {
  eventCommand,
  topicCommand,
  assignmentCommand,
  linkCommand,
  decideLinkCommand,
  connectCommand,
  decisionCommand,
  thoughtCommand,
} from "../../lib/thought-map/commands";
import type { OutboxEntry } from "../../lib/replica/contracts";
import { editableFields } from "../../lib/replica/command-envelope";
import { researchSource } from "../../lib/replica/research-source";
import { deleteResearchSchema } from "../../lib/research";
import {
  planThoughtBoxPromotion,
  thoughtPromotionInput,
} from "../../lib/shared-thought-boxes";
import {
  mergeWritingBoards,
  mergeWritingProjectsSchema,
} from "../../lib/merge-writing-boards";
import { buildScene } from "../../lib/whiteboard";
import { seedWritingBoard } from "../../lib/writing-board";
import {
  memoBundleInput,
  archiveBundleInput,
  bundleLinkInput,
} from "../../lib/thought-bundles";
import {
  WHITEBOARD_ID,
  boardSaveSchema,
  boardNoteLinkSchema,
  connectionForPair,
  publicBoardConnection,
  emptyBoard,
} from "../../lib/whiteboard";
import {
  noteVisibilitySchema,
  notesVisibilitySchema,
  withWhiteboardNotesVisibility,
  whiteboardSaveData,
} from "../../lib/whiteboard-visibility";
export interface OptimisticEffect {
  entity: SyncEntity;
  key: string;
  after: RawRecord | null;
}
export interface QueuedChange {
  path: string;
  body: any;
  at: string;
  base: any;
  effects: OptimisticEffect[];
  result: any;
  ack?: unknown;
  error?: string;
  inputHash: string;
}
export function commandFamily(path: string): OutboxEntry["family"] | null {
  return path === "/api/library"
    ? "library"
    : path === "/api/knowledge"
      ? "knowledge"
      : path === "/api/thought-map"
        ? "thought-map"
        : path === "/api/book-exclusions"
          ? "exclusions"
          : [
                "/api/catalog-review",
                "/api/curation",
                "/api/book-introduction",
                "/api/note-tags",
                "/api/book-relations",
              ].includes(path)
            ? "catalog"
            : null;
}
export async function prepareOptimistic(
  repository: ReplicaRepository,
  path: string,
  original: any,
  at: string,
) {
  const body = structuredClone(original),
    effects: OptimisticEffect[] = [],
    id = body.entityId ?? body.payload?.id ?? body.id ?? crypto.randomUUID();
  let entityId = id,
    base: any = null,
    result: any = { id, version: 1 };
  const put = (entity: SyncEntity, after: RawRecord) =>
    effects.push({ entity, key: syncKey(entity, after), after });
  const remove = (entity: SyncEntity, row: RawRecord) =>
    effects.push({ entity, key: syncKey(entity, row), after: null });
  const own = async (entity: SyncEntity, key: string) => {
    z.string().uuid().parse(key);
    const row = await repository.raw(entity, key);
    if (!row) throw new ReplicaQueryError(404, "자료를 찾을 수 없습니다.");
    return row;
  };
  const check = (row: RawRecord | undefined, v: number) => {
    if ((row?.version ?? 0) !== v)
      throw new ReplicaQueryError(
        409,
        "기기에 저장된 내용이 변경되었습니다. 입력을 확인해 주세요.",
      );
  };
  const edit = (entity: SyncEntity, row: RawRecord, value: RawRecord) => {
    base = row;
    entityId = row.id;
    const after = { ...row, ...value, version: (row.version ?? 0) + 1 };
    put(entity, after);
    result = { id: row.id, version: after.version };
    return after;
  };
  const note = async (noteId: string) => {
    const row = await own("library_notes", noteId),
      trash = await repository.raw("library_note_trash", noteId);
    if (trash?.restored_at === null)
      throw new ReplicaQueryError(409, "휴지통에 있는 기록입니다.");
    return row;
  };
  if (path === "/api/library") {
    const editBase = (
      entity: keyof typeof editableFields,
      old: RawRecord | null,
    ) =>
      old && body.editBase
        ? {
            ...old,
            ...Object.fromEntries(
              editableFields[entity]
                .filter((k) => Object.hasOwn(body.editBase, k))
                .map((k) => [k, body.editBase[k]]),
            ),
          }
        : old;
    const cmd = commandInput.parse(body),
      p: any = cmd.payload;
    body.entityId = id;
    if (cmd.type === "addBook" || cmd.type === "editBook") {
      const value = bookInput.parse(p),
        old = cmd.type === "editBook" ? await own("library_books", p.id) : null;
      if (old) check(old, p.expectedVersion);
      const after: RawRecord = {
        ...(old ?? {
          id,
          created_at: at,
          source_data: null,
          source_key: null,
          classification: {},
          enrichment: {},
        }),
        title: value.title,
        author: value.author,
        publisher: value.publisher,
        isbn: value.isbn,
        formats: value.formats,
        total_pages: value.totalPages,
        shelf: value.shelf,
        tags: value.tags,
        category: value.category,
        bookshelves: value.bookshelves,
        cover_url: value.coverUrl,
        version: (old?.version ?? 0) + 1,
      };
      base = editBase("library_books", old);
      put("library_books", after);
      result = { id: after.id, version: after.version };
      entityId = after.id;
    } else if (cmd.type === "addNote" || cmd.type === "editNote") {
      const value = noteInput.parse(p),
        old = cmd.type === "editNote" ? await note(p.id) : null;
      if (old) check(old, p.expectedVersion);
      if (value.bookId) await own("library_books", value.bookId);
      const after: RawRecord = {
        ...(old ?? { id, created_at: at, source_data: null, source_key: null }),
        book_id: value.bookId,
        title: value.title,
        content: value.content,
        kind: value.kind,
        page: value.page,
        tags: value.tags,
        updated_at: at,
        version: (old?.version ?? 0) + 1,
      };
      base = editBase("library_notes", old);
      put("library_notes", after);
      result = { id: after.id, version: after.version };
      entityId = after.id;
      const reviseContext = (
        kind: string,
        index: number,
        old: RawRecord | undefined,
        next: RawRecord,
      ) =>
        put("library_revisions", {
          id: noteContextId(body.requestId, `revision-${kind}`, index),
          entity_id: next.id,
          action: kind === "topic" ? "assignTopic" : "connectRelatedNote",
          before_data: old ?? null,
          after_data: next,
          created_at: at,
        });
      if (value.topicChanges?.length) {
        const memberships = await repository.all("library_topic_memberships");
        for (const [i, c] of value.topicChanges.entries()) {
          const t = await own("library_topics", c.topicId);
          if (t.archived_at && c.status === "accepted")
            throw new ReplicaQueryError(
              409,
              "삭제한 주제입니다. 주제를 다시 선택해 주세요.",
            );
          const previous = memberships.find(
            (m) =>
              m.topic_id === c.topicId &&
              m.source_kind === "note" &&
              m.source_id === after.id,
          );
          check(previous, c.expectedVersion);
          const next = {
            ...(previous ?? {
              id: noteContextId(body.requestId, "topic", i),
              topic_id: c.topicId,
              source_kind: "note",
              source_id: after.id,
              evidence: [],
            }),
            source_version: String(after.version),
            status: c.status,
            method: "manual",
            version: (previous?.version ?? 0) + 1,
          };
          put("library_topic_memberships", next);
          reviseContext("topic", i, previous, next);
        }
      }
      if (value.relatedNotes?.length) {
        const links = await repository.all("library_connections");
        for (const [i, c] of value.relatedNotes.entries()) {
          if (c.noteId === after.id)
            throw new ReplicaQueryError(
              400,
              "같은 기록을 자신에게 연결할 수 없습니다.",
            );
          await note(c.noteId);
          const [a, b] = [after.id, c.noteId].sort();
          const previous = links
            .filter(
              (l) =>
                l.source_kind === "note" &&
                l.target_kind === "note" &&
                ((l.source_id === a && l.target_id === b) ||
                  (l.source_id === b && l.target_id === a)),
            )
            .sort(
              (x, y) =>
                Number(y.status === "accepted") -
                  Number(x.status === "accepted") ||
                String(x.created_at).localeCompare(String(y.created_at)) ||
                x.id.localeCompare(y.id),
            )[0];
          if (previous?.status === "accepted") continue;
          const next = {
            ...(previous ?? {
              id: noteContextId(body.requestId, "link", i),
              source_kind: "note",
              source_id: a,
              target_kind: "note",
              target_id: b,
              created_at: at,
            }),
            status: "accepted",
            relation: "related",
            reason: "관련 기록으로 직접 연결",
            method: "manual",
            version: (previous?.version ?? 0) + 1,
          };
          put("library_connections", next);
          reviseContext("link", i, previous, next);
        }
      }
    } else if (cmd.type === "createShelf") {
      const name = z.string().trim().min(1).max(80).parse(p.name);
      if ((await repository.shelves()).includes(name))
        throw new ReplicaQueryError(409, "이미 있는 책장입니다.");
      put("library_shelves", { id, name, created_at: at });
    } else if (cmd.type === "startReading") {
      await own("library_books", p.bookId);
      put("library_cycles", {
        id,
        book_id: p.bookId,
        status: "reading",
        started_on: p.startedOn == null ? null : dateInput.parse(p.startedOn),
        completed_on: null,
        current_page: 0,
        version: 1,
        created_at: at,
      });
    } else if (
      ["updateProgress", "completeReading", "editCompletion"].includes(cmd.type)
    ) {
      const old = await own("library_cycles", p.id);
      check(old, p.expectedVersion);
      if (cmd.type === "updateProgress") {
        const current_page = z
          .number()
          .int()
          .min(0)
          .max(100000)
          .parse(p.currentPage);
        const b = await own("library_books", old.book_id);
        if (
          old.status !== "reading" ||
          (b.total_pages && current_page > b.total_pages)
        )
          throw new ReplicaQueryError(400, "읽는 쪽수를 확인해 주세요.");
        edit("library_cycles", old, { current_page });
      } else {
        const completed_on = dateInput.parse(p.completedOn),
          b = await own("library_books", old.book_id);
        if (
          (cmd.type === "completeReading"
            ? old.status !== "reading"
            : old.status !== "completed") ||
          (old.started_on && completed_on < old.started_on)
        )
          throw new ReplicaQueryError(409, "독서 상태와 날짜를 확인해 주세요.");
        edit("library_cycles", old, {
          status: "completed",
          completed_on,
          current_page: b.total_pages ?? old.current_page,
        });
      }
    } else if (cmd.type === "deleteNote" || cmd.type === "restoreNote") {
      const old = await own("library_notes", p.id);
      check(old, p.expectedVersion);
      const trash = await repository.raw("library_note_trash", p.id);
      if ((trash?.restored_at === null) !== (cmd.type === "restoreNote"))
        throw new ReplicaQueryError(409, "휴지통 상태가 변경되었습니다.");
      edit("library_notes", old, { updated_at: at });
      put("library_note_trash", {
        id: p.id,
        deleted_at: trash?.deleted_at ?? at,
        restored_at: cmd.type === "restoreNote" ? at : null,
      });
    } else if (cmd.type === "emptyNoteTrash") {
      const rows = z
        .array(
          z.object({
            id: z.string().uuid(),
            expectedVersion: z.number().int().positive(),
          }),
        )
        .min(1)
        .max(10000)
        .parse(p.notes);
      for (const n of rows) {
        const old = await own("library_notes", n.id);
        check(old, n.expectedVersion);
        const trash = await own("library_note_trash", n.id);
        if (trash.restored_at !== null)
          throw new ReplicaQueryError(409, "휴지통 상태가 변경되었습니다.");
        remove("library_notes", old);
        remove("library_note_trash", trash);
      }
      result = { id, version: 1 };
    }
  } else if (path === "/api/knowledge") {
    const p = body.payload;
    body.entityId = id;
    if (
      body.type === "setWhiteboardNoteVisibility" ||
      body.type === "setWhiteboardNotesVisibility"
    ) {
      const p =
        body.type === "setWhiteboardNotesVisibility"
          ? notesVisibilitySchema.parse(body.payload)
          : (() => {
              const v = noteVisibilitySchema.parse(body.payload);
              return { ...v, noteIds: [v.noteId] };
            })();
      const boardId = p.boardId ?? WHITEBOARD_ID;
      if (boardId !== WHITEBOARD_ID) await own("library_research", boardId);
      for (const id of p.noteIds) await note(id);
      const old = await repository.raw("library_whiteboards", boardId);
      base = old;
      entityId = boardId;
      body.entityId = boardId;
      const original = old?.data ?? emptyBoard(),
        data = withWhiteboardNotesVisibility(original, p.noteIds, p.visible);
      if (data !== original)
        put("library_whiteboards", {
          id: boardId,
          data,
          version: (old?.version ?? 0) + 1,
          updated_at: at,
        });
      result = {
        id: boardId,
        version: (old?.version ?? 0) + (data === original ? 0 : 1),
      };
    } else if (body.type === "promoteThoughtBoxes") {
      const value = thoughtPromotionInput.parse(p);
      const before = await repository.all("library_whiteboards");
      const projects = await repository.all("library_research");
      const boards = before.filter(
        (b) => b.id === WHITEBOARD_ID || projects.some((r) => r.id === b.id),
      );
      const plan = planThoughtBoxPromotion(
        boards as any,
        (await repository.all("library_memo_bundles")) as any,
        value.legacyToken,
      );
      if (plan.conflicts.length && value.legacyToken !== plan.legacyToken)
        throw new ReplicaQueryError(
          409,
          "이전 상자에만 있는 메모가 있습니다. 원본과 비교한 뒤 메모 합치기를 선택해 주세요.",
        );
      for (const bundle of plan.updated) {
        const old = await own("library_memo_bundles", bundle.id);
        put("library_memo_bundles", { ...old, ...bundle, updated_at: at });
        put("library_revisions", {
          id: crypto.randomUUID(),
          entity_id: bundle.id,
          action: "mergeLegacyThoughtBoxes",
          before_data: old,
          after_data: { ...old, ...bundle, updated_at: at },
          created_at: at,
        });
      }
      for (const bundle of plan.created)
        put("library_memo_bundles", {
          ...bundle,
          created_at: at,
          updated_at: at,
        });
      for (const board of plan.boards) {
        const old = before.find((b) => b.id === board.id)!;
        if (board.data !== old.data)
          put("library_whiteboards", {
            ...old,
            data: board.data,
            version: old.version + 1,
            updated_at: at,
          });
      }
      entityId = WHITEBOARD_ID;
      body.entityId = entityId;
      result = { count: plan.created.length };
    } else if (body.type === "mergeWritingProjects") {
      const value = mergeWritingProjectsSchema.parse(p),
        sources: { id: string; data: any }[] = [],
        visible = new Set<string>(),
        universe = new Set<string>();
      const oldItems = await repository.all("library_research_items"),
        placements = await repository.all("library_research_placements");
      for (const selected of value.sources) {
        const project = await own("library_research", selected.id),
          old = await repository.raw("library_whiteboards", selected.id);
        if (
          project.title !== selected.expectedTitle ||
          project.question !== selected.expectedQuestion
        )
          throw new ReplicaQueryError(
            409,
            "글감 제목이 변경되었습니다. 다시 확인해 주세요.",
          );
        check(old, selected.expectedBoardVersion);
        const items = oldItems.filter(
          (i) =>
            i.research_id === selected.id &&
            placements.find((p) => p.id === i.id)?.state !== "removed",
        );
        const snapshot: any = await repository.read(
          "/api/whiteboard?boardId=" + selected.id,
        );
        const notes = new Map(snapshot.notes.map((n: any) => [n.id, n]));
        for (const item of items) {
          const n = item.snapshot.note,
            noteId = n.id ?? item.id;
          if (!notes.has(noteId))
            notes.set(noteId, {
              ...n,
              id: noteId,
              bookId: item.snapshot.book?.id ?? null,
              tags: n.tags ?? [],
              createdAt: item.created_at,
              updatedAt: item.created_at,
            });
        }
        const original =
          old?.data ??
          seedWritingBoard(
            { question: project.question },
            items as any,
            placements.filter((p) => items.some((i) => i.id === p.id)) as any,
          );
        const data = {
          ...original,
          writing: {
            ...(original.writing ?? { chapters: [] }),
            excludedNoteIds: original.writing?.excludedNoteIds ?? [],
          },
        };
        for (const node of buildScene(
          { ...snapshot, notes: [...notes.values()] },
          data,
        ).nodes)
          visible.add(node.noteId);
        for (const key of notes.keys()) universe.add(key as string);
        sources.push({ id: selected.id, data });
      }
      const data = mergeWritingBoards(sources);
      data.writing!.excludedNoteIds = [...universe].filter(
        (id) => !visible.has(id),
      );
      boardSaveSchema.shape.data.parse(data);
      entityId = id;
      body.entityId = id;
      put("library_research", {
        id,
        title: value.title,
        kind: "thesis",
        question: "",
        created_at: at,
      });
      put("library_whiteboards", { id, data, version: 1, updated_at: at });
      const copied = new Set<string>();
      for (const selected of value.sources)
        for (const item of oldItems.filter(
          (i) => i.research_id === selected.id,
        )) {
          const placement = placements.find((p) => p.id === item.id);
          if (placement?.state === "removed" || copied.has(item.note_id))
            continue;
          copied.add(item.note_id);
          const itemId = noteContextId(id, "merged-material:" + item.id, 0),
            snapshot = structuredClone(item.snapshot);
          snapshot.note.id ??= item.id;
          put("library_research_items", {
            ...item,
            id: itemId,
            research_id: id,
            snapshot,
            created_at: at,
          });
          if (placement)
            put("library_research_placements", {
              ...placement,
              id: itemId,
              version: 1,
              updated_at: at,
            });
        }
      result = { id, version: 1 };
    } else if (body.type === "saveMemoBundle") {
      const v = memoBundleInput.parse(p),
        old = v.id ? await own("library_memo_bundles", v.id) : null;
      check(old ?? undefined, v.expectedVersion);
      if (old?.archived_at)
        throw new ReplicaQueryError(409, "보관해제된 생각 묶음입니다.");
      for (const n of v.noteIds)
        if (!(old?.note_ids ?? []).includes(n)) await note(n);
      entityId = old?.id ?? id;
      body.entityId = entityId;
      base = old;
      const after = {
        ...(old ?? { id: entityId, created_at: at, archived_at: null }),
        title: v.title,
        description: v.description,
        note_ids: v.noteIds,
        version: (old?.version ?? 0) + 1,
        updated_at: at,
      };
      put("library_memo_bundles", after);
      result = { id: entityId, version: after.version };
    } else if (body.type === "archiveMemoBundle") {
      const v = archiveBundleInput.parse(p),
        old = await own("library_memo_bundles", v.id);
      check(old, v.expectedVersion);
      edit("library_memo_bundles", old, { archived_at: at, updated_at: at });
    } else if (body.type === "saveBundleLink") {
      const v = bundleLinkInput.parse(p),
        [a, b] = [v.sourceId, v.targetId].sort();
      for (const key of [a, b]) {
        const bundle = await own("library_memo_bundles", key);
        if (bundle.archived_at)
          throw new ReplicaQueryError(409, "보관해제된 생각 묶음입니다.");
      }
      const old = v.id
        ? await own("library_bundle_links", v.id)
        : (await repository.all("library_bundle_links")).find(
            (l) => l.source_id === a && l.target_id === b,
          );
      check(old, v.expectedVersion);
      if (old && (old.source_id !== a || old.target_id !== b))
        throw new ReplicaQueryError(400, "연결할 생각 묶음이 변경됐습니다.");
      entityId = old?.id ?? id;
      body.entityId = entityId;
      base = old ?? null;
      const after = {
        ...(old ?? { id: entityId, created_at: at }),
        source_id: a,
        target_id: b,
        relation: v.relation,
        reason: v.reason,
        status: v.status,
        version: (old?.version ?? 0) + 1,
        updated_at: at,
      };
      put("library_bundle_links", after);
      result = { id: entityId, version: after.version };
    } else if (body.type === "saveWhiteboard") {
      const v = boardSaveSchema.parse(p),
        boardId = v.boardId ?? WHITEBOARD_ID;
      if (boardId !== WHITEBOARD_ID) await own("library_research", boardId);
      const old = await repository.raw("library_whiteboards", boardId);
      check(old, v.expectedVersion);
      base = old;
      entityId = boardId;
      body.entityId = boardId;
      put("library_whiteboards", {
        id: boardId,
        data: whiteboardSaveData(v.data, old?.data, v.includeVisibility),
        version: (old?.version ?? 0) + 1,
        updated_at: at,
      });
      result = { id: boardId, version: (old?.version ?? 0) + 1 };
    } else if (body.type === "connectWhiteboardNotes") {
      const v = boardNoteLinkSchema.parse(p);
      await note(v.sourceId);
      await note(v.targetId);
      const old = connectionForPair(
        (await repository.all("library_connections")) as any,
        v.sourceId,
        v.targetId,
      );
      if (old) {
        base = old;
        entityId = old.id;
        body.entityId = old.id;
        if (old.status !== "accepted")
          edit("library_connections", old, {
            status: "accepted",
            method: "manual",
          });
        else result = { id: old.id, version: old.version };
      } else {
        const [sourceId, targetId] = [v.sourceId, v.targetId].sort();
        put("library_connections", {
          id,
          source_kind: "note",
          source_id: sourceId,
          target_kind: "note",
          target_id: targetId,
          relation: "related",
          reason: "화이트보드에서 직접 연결",
          status: "accepted",
          method: "manual",
          version: 1,
          created_at: at,
        });
      }
    } else if (body.type === "createResearch") {
      put("library_research", {
        id,
        title: z.string().trim().min(1).max(300).parse(p.title),
        kind: z.enum(["sermon", "thesis"]).parse(p.kind),
        question: z.string().trim().max(2000).parse(p.question),
        created_at: at,
      });
    } else if (body.type === "deleteResearch") {
      const p = deleteResearchSchema.parse(body.payload);
      const research = await own("library_research", p.id);
      if (
        research.title !== p.expectedTitle ||
        research.question !== p.expectedQuestion
      )
        throw new ReplicaQueryError(
          409,
          "글감의 제목이나 내용이 바뀌었습니다. 목록을 새로 확인한 뒤 삭제해 주세요.",
        );
      const items = (await repository.all("library_research_items")).filter(
        (i) => i.research_id === p.id,
      );
      const ids = new Set(items.map((i) => i.id));
      const placements = (
        await repository.all("library_research_placements")
      ).filter((p) => ids.has(p.id));
      const board = await repository.raw("library_whiteboards", p.id);
      if ((board?.version ?? 0) !== p.expectedBoardVersion)
        throw new ReplicaQueryError(
          409,
          "글감의 목차나 배치가 변경됐습니다. 최신 글감을 확인한 뒤 다시 삭제해 주세요.",
        );
      entityId = p.id;
      base = { ...research, writingBoard: board ?? null };
      for (const row of placements) remove("library_research_placements", row);
      for (const row of items) remove("library_research_items", row);
      if (board) remove("library_whiteboards", board);
      remove("library_research", research);
      put("library_revisions", {
        id: body.requestId,
        entity_id: p.id,
        action: "deleteResearch",
        before_data: { research, items, placements, board: board ?? null },
        after_data: null,
        created_at: at,
      });
      result = { id: p.id, deleted: true };
    } else if (body.type === "updateResearch") {
      const old = await own("library_research", p.id);
      if (old.title !== p.expectedTitle || old.question !== p.expectedQuestion)
        throw new ReplicaQueryError(
          409,
          "목차나 제목이 다른 곳에서 변경됐습니다. 입력을 보관한 뒤 최신 내용과 비교해 주세요.",
        );
      base = old;
      entityId = p.id;
      put("library_research", {
        ...old,
        title: z.string().trim().min(1).max(300).parse(p.title),
        question: z.string().trim().max(2000).parse(p.question),
      });
      result = { id: p.id };
    } else if (body.type === "moveResearchItems") {
      const items = z
        .array(
          z.object({
            itemId: z.string().uuid(),
            expectedVersion: z.number().int().nonnegative(),
            position: z.number().int().min(1).max(100000),
          }),
        )
        .min(2)
        .max(2000)
        .parse(p.items);
      if (new Set(items.map((i) => i.itemId)).size !== items.length)
        throw new ReplicaQueryError(400, "서로 다른 두 자료를 선택해 주세요.");
      const rows = await Promise.all(
        items.map((i) => own("library_research_items", i.itemId)),
      );
      if (rows.some((r) => r.research_id !== rows[0].research_id))
        throw new ReplicaQueryError(
          400,
          "같은 글감 묶음 안에서만 순서를 바꿀 수 있습니다.",
        );
      for (const [i, item] of items.entries()) {
        const old = await repository.raw(
          "library_research_placements",
          item.itemId,
        );
        check(old, item.expectedVersion);
        const next = {
          id: item.itemId,
          role: "background",
          section: "",
          comment: "",
          state: "active",
          ...old,
          position: item.position,
          version: (old?.version ?? 0) + 1,
          updated_at: at,
        };
        put("library_research_placements", next);
        if (i === 0) {
          base = old;
          entityId = item.itemId;
          result = { id: entityId };
        } else
          put("library_revisions", {
            id: noteContextId(body.requestId, "research-move", i),
            entity_id: item.itemId,
            action: body.type,
            before_data: old ?? null,
            after_data: next,
            created_at: at,
          });
      }
    } else if (body.type === "addResearchNote") {
      await own("library_research", p.researchId);
      const n = await note(p.noteId),
        b = n.book_id ? await own("library_books", n.book_id) : null;
      if (
        p.expectedNoteVersion !== undefined &&
        p.expectedNoteVersion !== n.version
      )
        throw new ReplicaQueryError(
          409,
          "선택한 메모가 변경됐습니다. 다시 확인해 주세요.",
        );
      p.expectedNoteVersion = n.version;
      p.expectedBookVersion = b?.version ?? null;
      p.expectedSource = researchSource(n, b);
      put("library_research_items", {
        id,
        research_id: p.researchId,
        note_id: p.noteId,
        snapshot: {
          note: { ...projectNote(n), sourceData: n.source_data },
          book: b
            ? {
                id: b.id,
                title: b.title,
                author: b.author,
                publisher: b.publisher,
                isbn: b.isbn,
              }
            : null,
        },
        created_at: at,
      });
    } else if (body.type === "placeResearchItem") {
      await own("library_research_items", p.itemId);
      const old = await repository.raw("library_research_placements", p.itemId);
      check(old, p.expectedVersion);
      base = old;
      entityId = p.itemId;
      put("library_research_placements", {
        id: p.itemId,
        role: z
          .enum([
            "question",
            "claim",
            "evidence",
            "counterargument",
            "background",
          ])
          .parse(p.role),
        section: z.string().trim().max(300).parse(p.section),
        position: z.number().int().positive().max(100000).parse(p.position),
        comment: z.string().max(10000).parse(p.comment),
        state: z.enum(["active", "removed"]).parse(p.state),
        version: (old?.version ?? 0) + 1,
        updated_at: at,
      });
      result = { id: entityId, version: (old?.version ?? 0) + 1 };
    } else if (body.type === "connect" || body.type === "editConnection") {
      const relation = z
          .enum(["related", "supports", "challenges", "revises"])
          .parse(p.relation),
        reason = z.string().trim().max(2000).parse(p.reason);
      if (body.type === "editConnection") {
        const old = await own("library_connections", p.id);
        check(old, p.expectedVersion);
        edit("library_connections", old, {
          ...(p.title === undefined
            ? {}
            : { title: z.string().trim().max(300).parse(p.title) }),
          relation,
          reason,
          status: z.enum(["suggested", "accepted", "rejected"]).parse(p.status),
        });
      } else {
        await own(
          p.sourceKind === "book" ? "library_books" : "library_notes",
          p.sourceId,
        );
        await own(
          p.targetKind === "book" ? "library_books" : "library_notes",
          p.targetId,
        );
        if (p.sourceId === p.targetId && p.sourceKind === p.targetKind)
          throw new ReplicaQueryError(400, "다른 자료를 선택해 주세요.");
        put("library_connections", {
          id,
          source_kind: z.enum(["book", "note"]).parse(p.sourceKind),
          source_id: p.sourceId,
          target_kind: z.enum(["book", "note"]).parse(p.targetKind),
          target_id: p.targetId,
          relation,
          reason,
          status: "accepted",
          method: "manual",
          version: 1,
          created_at: at,
        });
      }
    } else if (body.type !== "suggest")
      throw new ReplicaQueryError(400, "허용하지 않은 변경입니다.");
  } else if (path === "/api/thought-map") {
    thoughtCommand.parse(body);
    body.entityId = id;
    const p = body.payload;
    if (body.type === "setThoughtEvent") {
      const v = eventCommand.parse(p);
      await note(v.noteId);
      const old = (await repository.all("library_thought_events")).find(
        (e) => e.note_id === v.noteId,
      );
      check(old, v.expectedVersion);
      base = old;
      entityId = old?.id ?? id;
      put("library_thought_events", {
        id: entityId,
        note_id: v.noteId,
        occurred_on: v.occurredOn,
        date_source: v.occurredOn ? "user" : "unknown",
        voice: v.voice,
        version: (old?.version ?? 0) + 1,
      });
      result = { id: entityId, version: (old?.version ?? 0) + 1 };
    } else if (body.type === "deleteTopic" || body.type === "restoreTopic") {
      const v = z
        .object({
          id: z.string().uuid(),
          expectedVersion: z.number().int().positive(),
        })
        .parse(p);
      const old = await own("library_topics", v.id);
      check(old, v.expectedVersion);
      if (
        body.type === "deleteTopic" &&
        (await repository.all("library_topics")).some(
          (t) => t.parent_id === v.id && !t.archived_at,
        )
      )
        throw new ReplicaQueryError(
          409,
          "하위 주제를 먼저 옮기거나 삭제해 주세요.",
        );
      if (
        body.type === "restoreTopic" &&
        old.parent_id &&
        (await own("library_topics", old.parent_id)).archived_at
      )
        throw new ReplicaQueryError(409, "상위 주제를 먼저 복원해 주세요.");
      edit("library_topics", old, {
        archived_at: body.type === "deleteTopic" ? at : null,
      });
    } else if (body.type === "upsertTopic") {
      const v = topicCommand.parse(p),
        old = v.id ? await own("library_topics", v.id) : null;
      if (old) check(old, v.expectedVersion ?? 0);
      base = old;
      entityId = old?.id ?? id;
      put("library_topics", {
        id: entityId,
        name: v.name,
        parent_id: v.parentId,
        aliases: v.aliases,
        description: v.description,
        kdc_codes: v.kdcCodes,
        confirmed: true,
        archived_at: old?.archived_at ?? null,
        version: (old?.version ?? 0) + 1,
        created_at: old?.created_at ?? at,
      });
      result = { id: entityId, version: (old?.version ?? 0) + 1 };
    } else if (body.type === "assignTopic") {
      const v = assignmentCommand.parse(p);
      if ((await own("library_topics", v.topicId)).archived_at)
        throw new ReplicaQueryError(409, "삭제한 주제는 먼저 복원해 주세요.");
      const old = (await repository.all("library_topic_memberships")).find(
        (m) =>
          m.topic_id === v.topicId &&
          m.source_kind === v.sourceKind &&
          m.source_id === v.sourceId,
      );
      check(old, v.expectedVersion ?? 0);
      base = old;
      entityId = old?.id ?? id;
      put("library_topic_memberships", {
        id: entityId,
        topic_id: v.topicId,
        source_kind: v.sourceKind,
        source_id: v.sourceId,
        source_version: v.sourceVersion,
        status: v.status,
        method: "manual",
        evidence: [],
        version: (old?.version ?? 0) + 1,
      });
      result = { id: entityId, version: (old?.version ?? 0) + 1 };
    } else if (body.type === "linkTopics") {
      const v = linkCommand.parse(p);
      put("library_topic_links", {
        id,
        source_topic_id: v.sourceTopicId,
        target_topic_id: v.targetTopicId,
        status: "suggested",
        supporting_pairs: v.supportingPairs,
        version: 1,
      });
    } else if (body.type === "decideTopicLink") {
      const v = decideLinkCommand.parse(p),
        old = await own("library_topic_links", v.id);
      check(old, v.expectedVersion);
      edit("library_topic_links", old, { status: v.status });
    } else if (body.type === "connectThoughts") {
      const v = connectCommand.parse(p),
        events = await repository.all("library_thought_events"),
        record = async (key: string) =>
          withEvent(
            resolveThoughtRecord(projectNote(await note(key))),
            events.find((e) => e.note_id === key)
              ? ({
                  ...events.find((e) => e.note_id === key)!,
                  occurredOn: events.find((e) => e.note_id === key)!
                    .occurred_on,
                  eventVersion: events.find((e) => e.note_id === key)!.version,
                } as any)
              : undefined,
          ),
        before = await record(v.beforeId),
        after = await record(v.afterId),
        evidence = (r: any) => {
          const quote = Array.from(r.content as string)
            .slice(0, 800)
            .join("");
          return {
            noteId: r.id,
            noteVersion: r.version,
            start: 0,
            end: quote.length,
            quote,
          };
        };
      if (v.topicId) {
        const topic = await own("library_topics", v.topicId);
        if (!topic.confirmed || topic.archived_at)
          throw new ReplicaQueryError(409, "먼저 주제를 확인해 주세요.");
        const memberships = await repository.all("library_topic_memberships");
        if (
          ![before, after].every((r) =>
            memberships.some(
              (m) =>
                m.topic_id === v.topicId &&
                m.source_kind === "note" &&
                m.source_id === r.id &&
                m.status === "accepted" &&
                String(m.source_version) === String(r.version),
            ),
          )
        )
          throw new ReplicaQueryError(
            409,
            "두 기록의 최신 주제 지정을 먼저 확인해 주세요.",
          );
      }
      body.payload.reviewedRecords ??= {
        before: { ...evidence(before), eventVersion: before.eventVersion },
        after: { ...evidence(after), eventVersion: after.eventVersion },
      };
      put("library_evolution_candidates", {
        id,
        before_id: before.id,
        after_id: after.id,
        topic_id: v.topicId ?? null,
        before_record: before,
        after_record: after,
        comparison: {
          relation: v.relation,
          before: v.reviewedRecords?.before ?? evidence(before),
          after: v.reviewedRecords?.after ?? evidence(after),
          explanation: v.explanation,
        },
        context: [],
        provenance: {
          modelDigest: "manual",
          promptVersion: "manual",
          retrievalVersion: "manual",
        },
        pair_key: contentHash([before.id, after.id, v.topicId ?? ""].join(":")),
        status: "accepted",
        version: 1,
        created_at: at,
      });
    } else if (body.type === "decideCandidate") {
      const v = decisionCommand.parse(p),
        old = await own("library_evolution_candidates", v.id);
      check(old, v.expectedVersion);
      edit("library_evolution_candidates", old, {
        status:
          v.decision === "accept"
            ? "accepted"
            : v.decision === "reject"
              ? "rejected"
              : "pending",
        comparison: {
          ...old.comparison,
          relation: v.relation,
          explanation: v.explanation,
        },
      });
    }
  } else if (path === "/api/curation") {
    const old = await own("library_curation_items", body.id);
    check(old, body.version);
    edit("library_curation_items", old, {
      value: body.value,
      state: z.enum(["active", "hidden"]).parse(body.state),
    });
  } else if (path === "/api/book-introduction") {
    introductionSchema.parse(body);
    body.entityId = id;
    await own("library_books", body.bookId);
    const old = (await repository.all("library_book_introductions")).find(
      (r) => r.book_id === body.bookId,
    );
    check(old, body.expectedVersion);
    base = old;
    entityId = old?.id ?? id;
    put("library_book_introductions", {
      id: entityId,
      book_id: body.bookId,
      book_version: body.bookVersion,
      text: body.text.trim(),
      sources: body.sources,
      version: (old?.version ?? 0) + 1,
      request_id: body.requestId,
      created_at: old?.created_at ?? at,
      updated_at: at,
    });
    result = { id: entityId, version: (old?.version ?? 0) + 1 };
  } else if (path === "/api/book-exclusions") {
    const old = await own("library_book_exclusions", body.id);
    check(old, body.expectedVersion);
    edit("library_book_exclusions", old, { state: "restored", updated_at: at });
  } else if (path === "/api/note-tags") {
    const tag = z.string().trim().min(1).max(40).parse(body.tag),
      all = await repository.all("library_notes");
    for (const n of all)
      if ((n.tags ?? []).includes(tag))
        put("library_notes", {
          ...n,
          tags: n.tags.filter((t: string) => t !== tag),
          version: n.version + 1,
          updated_at: at,
        });
    result = { removed: effects.length };
  } else if (path === "/api/catalog-review") {
    reviewDecisionSchema.parse(body);
    const old = await own("library_catalog_reviews", body.id);
    check(old, body.expectedVersion);
    edit("library_catalog_reviews", old, {
      status:
        body.action === "apply"
          ? "applied"
          : body.action === "reject"
            ? "rejected"
            : "deferred",
    });
    if (body.action === "apply") {
      if (!body.sameEdition || !body.fields.length)
        throw new ReplicaQueryError(400, "판본과 반영할 항목을 확인해 주세요.");
      const book = await own("library_books", old.book_id);
      check(book, old.source_version);
      const selected: any = {};
      for (const field of body.fields)
        selected[field === "coverUrl" ? "cover_url" : field] =
          old.record.facts[field];
      put("library_books", { ...book, ...selected, version: book.version + 1 });
    }
  } else if (path === "/api/book-relations") {
    if (body.relation === "same_file" && body.state === "accepted")
      throw new ReplicaQueryError(
        409,
        "파일 확인은 원본이 있는 PC에 연결해 주세요.",
      );
    body.entityId = id;
    const books = await Promise.all([
        own("library_books", body.leftId),
        own("library_books", body.rightId),
      ]),
      ids = [body.leftId, body.rightId].sort(),
      old = (await repository.all("library_book_relations")).find(
        (r) => r.left_id === ids[0] && r.right_id === ids[1],
      );
    check(old, body.expectedVersion);
    base = old;
    entityId = old?.id ?? id;
    put("library_book_relations", {
      id: entityId,
      left_id: ids[0],
      right_id: ids[1],
      relation: body.relation,
      state: body.state,
      reason: body.reason,
      evidence: { books, file: null, confirmedAt: at },
      version: (old?.version ?? 0) + 1,
      created_at: old?.created_at ?? at,
    });
    result = { id: entityId, version: (old?.version ?? 0) + 1 };
  } else throw new ReplicaQueryError(400, "허용하지 않은 변경입니다.");
  if (body.type === "connectWhiteboardNotes") {
    const changed = effects.find((e) => e.entity === "library_connections");
    const row =
      changed?.after ?? (await repository.raw("library_connections", entityId));
    result = {
      ...result,
      connection: publicBoardConnection(row!),
      changed: !!changed,
      previousStatus: base?.status ?? "rejected",
    };
  }
  const primary = effects.find((e) => e.after?.id === entityId);
  if (primary)
    put("library_revisions", {
      id: body.requestId,
      entity_id: path === "/api/book-introduction" ? body.bookId : entityId,
      action: body.type ?? path.slice(5),
      before_data: base ?? null,
      after_data: primary.after,
      created_at: at,
    });
  return {
    body,
    effects,
    entityId,
    base,
    result: { ...result, queued: true, connectionsReady: true },
  };
}
