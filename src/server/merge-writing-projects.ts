import { randomUUID } from "node:crypto";
import {
  mergeWritingBoards,
  mergeWritingProjectsSchema,
} from "../lib/merge-writing-boards";
import {
  boardSchema,
  buildScene,
  type Board,
  type WhiteboardSnapshot,
} from "../lib/whiteboard";
import { seedWritingBoard } from "../lib/writing-board";
import type { ResearchItem, ResearchPlacement } from "../lib/research";
import type { Note } from "../lib/domain";
import { noteContextId } from "../lib/note-context";
import { projectNote } from "../lib/replica/projections";
import { LibraryError, type Executor } from "./library-store";
import { saveWhiteboard } from "./whiteboard-store";

/** Called inside the knowledge command transaction; request idempotency belongs to its caller. */
export async function mergeWritingProjects(
  tx: Executor,
  owner: string,
  input: unknown,
  entityId?: string,
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const p = mergeWritingProjectsSchema.parse(input),
    ids = p.sources.map((s) => s.id).sort();
  const research = (
    await tx.query(
      "SELECT * FROM library_research WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
      [owner, ids],
    )
  ).rows;
  if (research.length !== ids.length)
    throw new LibraryError(404, "합칠 글감을 찾을 수 없습니다.");
  const boards = (
    await tx.query(
      "SELECT * FROM library_whiteboards WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
      [owner, ids],
    )
  ).rows;
  for (const selected of p.sources) {
    const project = research.find((r) => r.id === selected.id)!,
      board = boards.find((b) => b.id === selected.id);
    if (
      project.title !== selected.expectedTitle ||
      project.question !== selected.expectedQuestion
    )
      throw new LibraryError(
        409,
        "선택한 글감의 제목이나 내용이 바뀌었습니다. 목록을 새로 확인한 뒤 다시 합쳐 주세요.",
      );
    if ((board?.version ?? 0) !== selected.expectedBoardVersion)
      throw new LibraryError(
        409,
        "선택한 글감의 목차나 배치가 바뀌었습니다. 최신 글감을 확인한 뒤 다시 합쳐 주세요.",
      );
  }
  const items = (
    await tx.query(
      "SELECT * FROM library_research_items WHERE owner_id=$1 AND research_id=ANY($2::uuid[]) ORDER BY created_at,id FOR UPDATE",
      [owner, ids],
    )
  ).rows;
  const placements = (
    await tx.query(
      "SELECT p.* FROM library_research_placements p JOIN library_research_items i ON i.owner_id=p.owner_id AND i.id=p.id WHERE i.owner_id=$1 AND i.research_id=ANY($2::uuid[]) ORDER BY p.position,p.id FOR UPDATE OF p",
      [owner, ids],
    )
  ).rows;
  const source = await mergeSnapshot(tx, owner);
  const visible = new Set<string>();
  const retainedItems = items.filter(
    (item) => placements.find((p) => p.id === item.id)?.state !== "removed",
  );
  const sources = p.sources.map((selected) => {
    const project = research.find((r) => r.id === selected.id)!,
      saved = boards.find((b) => b.id === selected.id);
    const projectItems = retainedItems.filter(
      (i) => i.research_id === project.id,
    );
    const stored: Board =
      saved?.data ??
      seedWritingBoard(
        { question: project.question },
        projectItems as ResearchItem[],
        placements.filter((p) =>
          projectItems.some((item) => item.id === p.id),
        ) as ResearchPlacement[],
      );
    // Old project boards predate writing-only visibility. Ordinary whiteboard
    // hiding must not become an exclusion when those projects are combined.
    const data: Board = {
      ...stored,
      writing: {
        ...stored.writing,
        chapters: stored.writing?.chapters ?? [],
        excludedNoteIds: stored.writing?.excludedNoteIds ?? [],
      },
    };
    const snapshot = {
      ...source,
      notes: [
        ...source.notes,
        ...projectItems
          .filter(
            (item) =>
              !source.notes.some(
                (note) => note.id === (item.snapshot.note.id ?? item.id),
              ),
          )
          .map(legacyNote),
      ],
      board: saved ? { id: saved.id, data, version: saved.version } : null,
    };
    for (const node of buildScene(snapshot, data).nodes)
      visible.add(node.noteId);
    return { id: selected.id, data };
  });
  const data = mergeWritingBoards(sources);
  data.writing = {
    ...data.writing!,
    excludedNoteIds: [
      ...new Set([
        ...source.notes.map((n) => n.id),
        ...retainedItems.map((item) => item.snapshot.note.id ?? item.id),
      ]),
    ].filter((id) => !visible.has(id)),
  };
  data.hiddenNoteIds = [];
  boardSchema.parse(data); // Reject oversized combined layouts before inserting any destination row.
  const id = entityId ?? randomUUID();
  const after = (
    await tx.query(
      "INSERT INTO library_research(id,owner_id,title,kind,question) VALUES($1,$2,$3,'thesis','') RETURNING *",
      [id, owner, p.title],
    )
  ).rows[0];
  const copiedNotes = new Set<string>();
  for (const selected of p.sources)
    for (const item of retainedItems.filter(
      (item) => item.research_id === selected.id,
    )) {
      if (copiedNotes.has(item.note_id)) continue;
      copiedNotes.add(item.note_id);
      const itemId = noteContextId(id, "merged-material:" + item.id, 0);
      const snapshot = structuredClone(item.snapshot);
      snapshot.note.id ??= item.id;
      await tx.query(
        "INSERT INTO library_research_items(id,owner_id,research_id,note_id,snapshot) VALUES($1,$2,$3,$4,$5)",
        [itemId, owner, id, item.note_id, JSON.stringify(snapshot)],
      );
      const placement = placements.find((p) => p.id === item.id);
      if (placement)
        await tx.query(
          "INSERT INTO library_research_placements(id,owner_id,role,section,position,comment,state) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            itemId,
            owner,
            placement.role,
            placement.section,
            placement.position,
            placement.comment,
            placement.state,
          ],
        );
    }
  await tx.query(
    "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'mergeWritingProjects',$4,$5)",
    [
      randomUUID(),
      owner,
      id,
      null,
      JSON.stringify({ research: after, sources: p.sources }),
    ],
  );
  return saveWhiteboard(tx, owner, {
    boardId: id,
    expectedVersion: 0,
    data,
    includeVisibility: true,
  });
}

function legacyNote(item: Record<string, any>): Note {
  return {
    ...item.snapshot.note,
    id: item.snapshot.note.id ?? item.id,
    bookId: item.snapshot.book?.id ?? null,
    tags: item.snapshot.note.tags ?? [],
    createdAt:
      typeof item.created_at === "string"
        ? item.created_at
        : (item.created_at?.toISOString() ?? ""),
    updatedAt:
      typeof item.created_at === "string"
        ? item.created_at
        : (item.created_at?.toISOString() ?? ""),
    sourceData: null,
  };
}

async function mergeSnapshot(
  tx: Executor,
  owner: string,
): Promise<WhiteboardSnapshot> {
  const notes = (
    await tx.query(
      "SELECT * FROM library_active_notes WHERE owner_id=$1 ORDER BY created_at,id",
      [owner],
    )
  ).rows.map((row) => projectNote(row));
  const books = (
    await tx.query(
      "SELECT id,title,author,category FROM library_active_books WHERE owner_id=$1",
      [owner],
    )
  ).rows;
  const topics = (
    await tx.query(
      "SELECT id,name,version FROM library_topics WHERE owner_id=$1 AND archived_at IS NULL",
      [owner],
    )
  ).rows;
  const memberships = (
    await tx.query(
      "SELECT topic_id,source_kind,source_id,status FROM library_topic_memberships WHERE owner_id=$1",
      [owner],
    )
  ).rows.map((r) => ({
    topicId: r.topic_id,
    sourceKind: r.source_kind,
    sourceId: r.source_id,
    status: r.status,
  }));
  const bundles = (
    await tx.query(
      "SELECT id,title,description,note_ids,version,archived_at FROM library_memo_bundles WHERE owner_id=$1",
      [owner],
    )
  ).rows;
  return {
    board: null,
    notes,
    books: books as WhiteboardSnapshot["books"],
    topics: topics as WhiteboardSnapshot["topics"],
    memberships,
    bundles: bundles as WhiteboardSnapshot["bundles"],
    connections: [],
  };
}
