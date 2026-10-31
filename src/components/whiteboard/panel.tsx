"use client";
import type { ModalAnchor } from "@/lib/modal-placement";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Library } from "@/lib/domain";
import { categories } from "@/lib/catalog";
import { relationNames, type Relation } from "@/lib/knowledge";
import { libraryRequest } from "@/client/replica/request";
import { useReplicaOptional } from "../replica/provider";
import { usePagedResource } from "../use-paged-resource";
import { FacetPicker } from "./facet-picker";
import { WhiteboardCanvas } from "./canvas";
import { HiddenWhiteboardNotes } from "./hidden-notes";
import { connectedMemoGroups } from "@/lib/memo-box";
import { connectionGroupsForView } from "@/lib/whiteboard-workflows";
import { MemoGroupDetail } from "../memo-box/group-detail";
import {
  boardDisplaySelection,
  arrangePlainMemos,
} from "@/lib/whiteboard-display";
import {
  putBoxNotes,
  flattenBox,
  type ThoughtBoxSummary,
} from "@/lib/thought-boxes";
import { WritingAssist } from "./writing-assist";
import { useSharedBoxEdits } from "./use-shared-box-edits";
import {
  LegacyThoughtReview,
  type LegacyThoughtReviewState,
} from "./legacy-thought-review";
import {
  projectSharedBoxes,
  referenceThoughtBox,
  sharedBoxSummaries,
  arrangeThoughtBoard,
} from "@/lib/shared-thought-boxes";
import {
  chapterAt,
  moveChapter,
  placeChapterMaterials,
  exportWritingBoard,
  type WritingChapter,
} from "@/lib/writing-board";
import {
  boardSchema,
  boardStamp,
  WHITEBOARD_ID,
  emptyBoard,
  buildScene,
  moveNote,
  moveGroup,
  mergeNotes,
  connectionForPair,
  seedBoard,
  arrangeSearchResults,
  repairSparseSearchLayout,
  type Board,
  type BoardFilter,
  type BoardConnection,
  type BoardNode,
  type BoardGroup,
  type Point,
  type WhiteboardSnapshot,
  type dropTarget,
} from "@/lib/whiteboard";
type LinkUndo = {
  id: string;
  version: number;
  status: string;
  relation: string;
  reason: string;
};
const NO_LEGACY_NOTES: WhiteboardSnapshot["notes"] = [];
export function WhiteboardPanel({
  library,
  onOpen,
  ownerId,
  revision = 0,
  boardId = WHITEBOARD_ID,
  writingTitle,
  initialBoard,
  legacyNotes = NO_LEGACY_NOTES,
  suspended = false,
  onRegisterFlush,
}: {
  library: Library;
  onOpen: (kind: string, id: string, anchor?: ModalAnchor) => void;
  ownerId: string;
  revision?: number;
  boardId?: string;
  writingTitle?: string;
  initialBoard?: Board;
  legacyNotes?: WhiteboardSnapshot["notes"];
  suspended?: boolean;
  onRegisterFlush?: (flush: (() => Promise<void>) | null) => void;
}) {
  const replica = useReplicaOptional(),
    runtime = replica?.runtime;
  const refresh = useMemo(
    () => ({ notes: library.notes, revision }),
    [library.notes, revision],
  );
  const resource = usePagedResource<WhiteboardSnapshot>(
    boardId === WHITEBOARD_ID
      ? "/api/whiteboard"
      : "/api/whiteboard?boardId=" + boardId,
    true,
    refresh,
    { keepPreviousData: true },
  );
  const boxesResource = usePagedResource<
    LegacyThoughtReviewState & {
      items: ThoughtBoxSummary[];
      pendingLegacy?: boolean;
    }
  >("/api/thought-boxes", true, refresh, { keepPreviousData: true });
  const [board, setBoard] = useState<Board>(emptyBoard),
    [filter, setFilter] = useState<BoardFilter>(emptyBoard().filter),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [saving, setSaving] = useState(false),
    [linkBusy, setLinkBusy] = useState(false),
    [conflict, setConflict] = useState(false),
    [searchRevision, setSearchRevision] = useState(0),
    [selectedNote, setSelectedNote] = useState<string | null>(null),
    [selectedGroup, setSelectedGroup] = useState<string | null>(null),
    [connectionView, setConnectionView] = useState<string[] | "all" | null>(
      null,
    ),
    [overviewOnFit, setOverviewOnFit] = useState(false),
    [boxVisibility, setBoxVisibility] = useState<Record<string, boolean>>({}),
    [plainBoard, setPlainBoard] = useState(false),
    [checkedConnections, setCheckedConnections] = useState<string[]>([]),
    [checkedBoxes, setCheckedBoxes] = useState<string[]>([]),
    [linkSource, setLinkSource] = useState<{
      kind: "note" | "group";
      id: string;
    } | null>(null),
    [undo, setUndo] = useState<{
      board: Board;
      link?: LinkUndo;
      bundle?: { type: string; payload: unknown };
      shared?: {
        id: string;
        title: string;
        description: string;
        noteIds: string[];
      }[];
    } | null>(null),
    [localConnections, setLocalConnections] = useState<BoardConnection[]>([]);
  const sharedFlush = useRef<() => Promise<void>>(async () => {}),
    promoting = useRef(false);
  const current = useRef(board),
    suspendedRef = useRef(suspended),
    version = useRef(0),
    initialized = useRef(false),
    pending = useRef<Board | null>(null),
    writing = useRef(false),
    observed = useRef<string | null>(null),
    observedLayout = useRef(""),
    observedResolution = useRef(""),
    acknowledged = useRef(new Set<string>()),
    needsChoice = useRef(false),
    criteriaEdited = useRef(false),
    dirty = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    alive = useRef(true),
    lastDraft = useRef<string | null>(null),
    runSave = useRef<() => Promise<void>>(async () => {}),
    saveTask = useRef<Promise<void> | null>(null);
  suspendedRef.current = suspended;
  const key = ownerId
    ? `library:whiteboard-draft:${ownerId}${boardId === WHITEBOARD_ID ? "" : ":" + boardId}`
    : "";
  const viewKey = ownerId
    ? `library:whiteboard-view:${ownerId}:${boardId}`
    : "";
  function localView(value: Board) {
    if (writingTitle)
      value = {
        ...value,
        writing: {
          chapters: value.writing?.chapters ?? [],
          ...value.writing,
          excludedNoteIds: value.writing?.excludedNoteIds ?? [],
        },
      };
    if (!viewKey) return value;
    try {
      const view = JSON.parse(localStorage.getItem(viewKey) ?? "null");
      if (
        view &&
        Number.isFinite(view.x) &&
        Number.isFinite(view.y) &&
        Number.isFinite(view.zoom) &&
        view.zoom >= 0.1 &&
        view.zoom <= 1.8
      )
        return {
          ...value,
          writing: {
            chapters: value.writing?.chapters ?? [],
            ...value.writing,
            viewport: { x: view.x, y: view.y, zoom: view.zoom },
          },
        };
    } catch {}
    return value;
  }
  function rememberView(view: { x: number; y: number; zoom: number }) {
    if (suspendedRef.current) return;
    const before = current.current;
    if (JSON.stringify(before.writing?.viewport) === JSON.stringify(view))
      return;
    const next = {
      ...before,
      writing: {
        chapters: before.writing?.chapters ?? [],
        ...before.writing,
        viewport: view,
      },
    };
    current.current = next;
    if (alive.current) setBoard(next);
    if (pending.current)
      pending.current = { ...pending.current, writing: { ...next.writing } };
    try {
      if (viewKey) localStorage.setItem(viewKey, JSON.stringify(view));
    } catch {}
    if (dirty.current) remember(next, true);
  }
  function layoutStamp(data: Board | undefined) {
    return boardStamp({
      id: boardId,
      version: 0,
      data: { ...(data ?? emptyBoard()), hiddenNoteIds: [] },
    });
  }
  function remember(data: Board, unsaved: boolean) {
    if (!key) return;
    try {
      // A response from a closed view must not clear a newer view's draft.
      if (!alive.current && localStorage.getItem(key) !== lastDraft.current)
        return;
      const serialized = JSON.stringify({
        data,
        version: version.current,
        dirty: unsaved,
        resolutionToken: observedResolution.current,
        needsChoice: needsChoice.current,
      });
      localStorage.setItem(key, serialized);
      lastDraft.current = serialized;
    } catch {
      setError(
        "기기 저장 공간을 확인해 주세요. 현재 배치는 화면에 유지됩니다.",
      );
    }
  }
  async function send(
    type: string,
    payload: unknown,
    requestId = crypto.randomUUID(),
  ) {
    const body = { requestId, type, payload };
    if (runtime) {
      if (runtime.owner !== ownerId || !runtime.getSnapshot().ready)
        throw Error("기기 자료를 먼저 준비해 주세요. 현재 배치는 유지됩니다.");
      return runtime.queue("/api/knowledge", body);
    }
    const r = await libraryRequest("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      }),
      data = await r.json();
    if (!r.ok) throw Error(data.error ?? "저장하지 못했습니다.");
    return data;
  }
  runSave.current = () => {
    if (suspendedRef.current) return Promise.resolve();
    if (saveTask.current) return saveTask.current;
    saveTask.current = (async () => {
      if (writing.current || needsChoice.current) return;
      writing.current = true;
      if (alive.current) setSaving(true);
      try {
        while (pending.current && !suspendedRef.current) {
          const value = pending.current;
          pending.current = null;
          try {
            const result = await send("saveWhiteboard", {
              boardId,
              data: value,
              expectedVersion: version.current,
            });
            version.current = result.version;
            observedLayout.current = layoutStamp(value);
            acknowledged.current.add(
              boardStamp({
                id: boardId,
                data: value,
                version: result.version,
              }),
            );
            if (acknowledged.current.size > 16)
              acknowledged.current.delete(
                acknowledged.current.values().next().value!,
              );
            dirty.current = !!pending.current;
            remember(current.current, dirty.current);
            if (alive.current) {
              setError("");
              setMessage(result.queued ? "기기에 저장됨" : "저장됨");
            }
          } catch (e) {
            pending.current = pending.current ?? current.current;
            dirty.current = true;
            remember(current.current, true);
            if (alive.current) setError((e as Error).message);
            break;
          }
        }
      } finally {
        writing.current = false;
        if (alive.current) setSaving(false);
      }
    })().finally(() => {
      saveTask.current = null;
    });
    return saveTask.current;
  };
  function update(next: Board, before?: Board) {
    next = {
      ...next,
      hiddenNoteIds: current.current.hiddenNoteIds,
      links: next.links.filter(
        (l) =>
          !(l.source.startsWith("bundle:") && l.target.startsWith("bundle:")),
      ),
    };
    current.current = next;
    setBoard(next);
    dirty.current = true;
    pending.current = next;
    remember(next, true);
    if (before) setUndo({ board: before });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void runSave.current(), 350);
  }
  useEffect(() => {
    onRegisterFlush?.(async () => {
      if (timer.current) clearTimeout(timer.current);
      await sharedFlush.current();
      await runSave.current();
      if (dirty.current || needsChoice.current)
        throw Error(
          "현재 글감의 저장을 먼저 완료해 주세요. 입력한 내용은 유지됩니다.",
        );
    });
    return () => onRegisterFlush?.(null);
  }, [onRegisterFlush]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (pending.current && !suspendedRef.current) void runSave.current();
    };
  }, []);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!suspended && pending.current)
      timer.current = setTimeout(() => void runSave.current(), 350);
  }, [suspended]);
  useEffect(() => {
    const data = resource.data;
    if (!data) return;
    const v = data.board?.version ?? 0;
    const stamp = boardStamp(data.board),
      resolution = data.resolutionToken ?? "";
    if (!initialized.current) {
      initialized.current = true;
      observed.current = stamp;
      observedLayout.current = layoutStamp(data.board?.data);
      observedResolution.current = resolution;
      version.current = v;
      let value = data.board?.data ?? initialBoard ?? emptyBoard();
      if (!data.board && initialBoard?.writing?.chapters.length) {
        dirty.current = true;
        pending.current = value;
      }
      if (key)
        try {
          const saved = JSON.parse(localStorage.getItem(key) ?? "null");
          if (saved?.dirty && boardSchema.safeParse(saved.data).success) {
            value = saved.data;
            dirty.current = true;
            if (
              saved.version === v &&
              (saved.resolutionToken ?? "") === resolution &&
              !saved.needsChoice
            )
              pending.current = value;
            else {
              needsChoice.current = true;
              setConflict(true);
            }
          }
        } catch {}
      const initialSource = {
        ...data,
        notes: [
          ...new Map(
            [...legacyNotes, ...data.notes].map((n) => [n.id, n]),
          ).values(),
        ],
      };
      if (!data.board && value.writing?.chapters.length)
        value = value.writing.chapters.reduce(
          (b, c) => placeChapterMaterials(b, c.id, initialSource),
          value,
        );
      value = seedBoard(initialSource, value);
      if (!needsChoice.current) {
        const repaired = repairSparseSearchLayout(data, value);
        if (repaired !== value) {
          value = repaired;
          dirty.current = true;
          pending.current = value;
        }
      }
      value = localView(value);
      current.current = value;
      setBoard(value);
      setFilter(value.filter);
      if (needsChoice.current || pending.current) remember(value, true);
      if (pending.current) {
        pending.current = value;
        timer.current = setTimeout(() => void runSave.current(), 350);
      }
      return;
    }
    // Only an explicit, durably recorded resolution can reset a version. Ignore
    // delayed echoes of our own saves while a newer edit is waiting or saved.
    if (!writing.current) {
      const resolved = resolution !== observedResolution.current;
      if (stamp === observed.current && !resolved) return;
      observed.current = stamp;
      observedResolution.current = resolution;
      if (resolved) acknowledged.current.clear();
      if (!resolved && v < version.current) return;
      const layout = layoutStamp(data.board?.data),
        sameLayout = layout === observedLayout.current;
      observedLayout.current = layout;
      if (!resolved && acknowledged.current.has(stamp)) return;
      if (
        !resolved &&
        !needsChoice.current &&
        sameLayout &&
        JSON.stringify(current.current.hiddenNoteIds ?? []) !==
          JSON.stringify(data.board?.data.hiddenNoteIds ?? [])
      ) {
        // Visibility is a separate command. Retain materialized default positions,
        // pending layout edits and the canvas/filter state when only that bit changed.
        const value = {
          ...current.current,
          hiddenNoteIds: data.board?.data.hiddenNoteIds ?? [],
        };
        version.current = v;
        current.current = value;
        setBoard(value);
        if (pending.current)
          pending.current = {
            ...pending.current,
            hiddenNoteIds: value.hiddenNoteIds,
          };
        remember(value, dirty.current);
        return;
      }
      if (dirty.current) {
        needsChoice.current = true;
        setConflict(true);
        remember(current.current, true);
      } else {
        const value = localView(
          seedBoard(data, data.board?.data ?? emptyBoard()),
        );
        version.current = v;
        current.current = value;
        setBoard(value);
        if (!criteriaEdited.current) setFilter(value.filter);
        remember(value, false);
      }
    }
  }, [resource.data, key, saving]);
  const shared = useSharedBoxEdits(
    ownerId,
    resource.data?.bundles,
    send,
    resource.reload,
  );
  sharedFlush.current = shared.flush;
  useEffect(() => {
    if (
      !boxesResource.data?.pendingLegacy ||
      boxesResource.data?.legacyConflicts?.length ||
      promoting.current ||
      dirty.current
    )
      return;
    promoting.current = true;
    setLinkBusy(true);
    void send("promoteThoughtBoxes", {})
      .then(() => {
        resource.reload();
        boxesResource.reload();
      })
      .catch((e) => setError(e.message))
      .finally(() => {
        promoting.current = false;
        setLinkBusy(false);
      });
  }, [boxesResource.data, saving]);
  const source = useMemo(() => {
    if (!resource.data) return null;
    const map = new Map(resource.data.connections.map((c) => [c.id, c]));
    for (const c of localConnections) {
      const old = map.get(c.id);
      if (!old || c.version > old.version) map.set(c.id, c);
    }
    const notes = new Map(legacyNotes.map((n) => [n.id, n]));
    for (const note of resource.data.notes) notes.set(note.id, note);
    return {
      ...resource.data,
      bundles: shared.bundles,
      notes: [...notes.values()],
      connections: [...map.values()],
    };
  }, [resource.data, localConnections, legacyNotes, shared.bundles]);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const canvasHost = useRef<HTMLDivElement>(null);
  const memoGroups = useMemo(
    () => (source ? connectedMemoGroups(source) : []),
    [source],
  );
  const availableConnections = useMemo(
    () => memoGroups.flatMap((g) => g.connections),
    [memoGroups],
  );
  const selectedConnectionIds = checkedConnections.filter((id) =>
    availableConnections.some((c) => c.id === id),
  );
  const focusGroups = useMemo(
    () =>
      source && connectionView !== null
        ? connectionGroupsForView(source, connectionView)
        : [],
    [source, connectionView],
  );
  const hasFocus = connectionView !== null;
  const connectionComponents = useMemo(
    () =>
      new Map(
        memoGroups.flatMap((g) => g.notes.map((n) => [n.id, g.id] as const)),
      ),
    [memoGroups],
  );
  const display = useMemo(
    () =>
      source
        ? boardDisplaySelection(
            source,
            board,
            {
              connections: connectionView,
              boxes: boxVisibility,
              plain: plainBoard,
            },
            !!writingTitle,
            { components: connectionComponents, groups: focusGroups },
          )
        : null,
    [
      source,
      board,
      connectionView,
      boxVisibility,
      plainBoard,
      writingTitle,
      connectionComponents,
      focusGroups,
    ],
  );
  const displaySource = display?.source ?? source;
  const displayBoard = display?.board ?? board;
  const boxes = sharedBoxSummaries(source?.bundles ?? []);
  function showConnection(c: BoardConnection) {
    const ids =
      connectionView === "all"
        ? availableConnections.map((c) => c.id)
        : (connectionView ?? []);
    showConnections(
      ids.includes(c.id) ? ids.filter((id) => id !== c.id) : [...ids, c.id],
      false,
      checkedBoxes,
    );
  }
  function toggleBox(id: string) {
    const next = checkedBoxes.includes(id)
      ? checkedBoxes.filter((value) => value !== id)
      : [...checkedBoxes, id];
    showConnections(connectionView ?? [], false, next);
  }
  function showConnections(
    ids: string[] | "all",
    overview = false,
    boxIds: string[] = [],
  ) {
    const valid = boxIds.filter(
      (id) => !boxesResource.data?.legacyConflicts?.some((c) => c.id === id),
    );
    setBoxVisibility((old) => ({
      ...old,
      ...Object.fromEntries(
        checkedBoxes
          .filter((id) => !valid.includes(id))
          .map((id) => [id, false]),
      ),
      ...Object.fromEntries(valid.map((id) => [id, true])),
    }));
    setCheckedBoxes(valid);
    setCheckedConnections(
      ids === "all" ? availableConnections.map((c) => c.id) : ids,
    );
    setPlainBoard(false);
    setSelectedGroup(null);
    setSelectedNote(null);
    setLinkSource(null);
    setConnectionView(ids);
    setOverviewOnFit(overview);
    setSearchRevision((n) => n + 1);
    if (overview)
      canvasHost.current?.scrollIntoView({
        behavior: "auto",
        block: "nearest",
      });
  }
  function download(format: "md" | "txt") {
    const content = exportWritingBoard(
      writingTitle ?? "글감",
      projectSharedBoxes(current.current, sourceRef.current!),
      sourceRef.current!,
      format,
    );
    const url = URL.createObjectURL(
      new Blob([content], {
        type:
          format === "md"
            ? "text/markdown;charset=utf-8"
            : "text/plain;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download =
      (writingTitle ?? "글감").replace(/[<>:"/\\|?*]/g, "_") + "." + format;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function withVisibleChapter(value: Board, id: string) {
    if (value.writing?.chapters.some((c) => c.id === id)) return value;
    const chapter = displayBoard.writing?.chapters.find((c) => c.id === id);
    return chapter
      ? {
          ...value,
          writing: {
            ...value.writing,
            chapters: [...(value.writing?.chapters ?? []), chapter],
          },
        }
      : value;
  }
  function changeChapter(chapter: WritingChapter) {
    const before = current.current;
    const base = withVisibleChapter(before, chapter.id);
    const original = sourceRef.current?.bundles?.find(
      (b) => b.id === chapter.bundleId,
    );
    const members = new Set(chapter.items.flatMap((i) => i.noteIds));
    const noteIds = original
      ? [
          ...original.note_ids.filter((id) => members.has(id)),
          ...[...members].filter((id) => !original.note_ids.includes(id)),
        ]
      : [...members];
    const changedShared =
      original &&
      (chapter.title !== original.title ||
        chapter.text !== original.description ||
        JSON.stringify(noteIds) !== JSON.stringify(original.note_ids));
    if (
      original &&
      (chapter.title !== original.title ||
        chapter.text !== original.description ||
        JSON.stringify(noteIds) !== JSON.stringify(original.note_ids))
    )
      shared.patch(original.id, {
        title: chapter.title,
        description: chapter.text,
        noteIds,
      });
    update(
      {
        ...before,
        writing: {
          ...base.writing!,
          chapters: base.writing!.chapters.map((c) =>
            c.id === chapter.id ? chapter : c,
          ),
        },
      },
      before,
    );
    if (changedShared)
      setUndo({
        board: before,
        shared: [
          {
            id: original.id,
            title: original.title,
            description: original.description,
            noteIds: original.note_ids,
          },
        ],
      });
  }
  function commitMaterialBoard(next: Board, before: Board) {
    const inverse: {
      id: string;
      title: string;
      description: string;
      noteIds: string[];
    }[] = [];
    for (const c of next.writing?.chapters ?? []) {
      const original = sourceRef.current?.bundles?.find(
        (b) => b.id === c.bundleId,
      );
      if (!original) continue;
      const members = new Set(c.items.flatMap((i) => i.noteIds));
      const noteIds = [
        ...original.note_ids.filter((id) => members.has(id)),
        ...[...members].filter((id) => !original.note_ids.includes(id)),
      ];
      if (
        JSON.stringify(noteIds) !== JSON.stringify(original.note_ids) ||
        c.title !== original.title ||
        c.text !== original.description
      ) {
        inverse.push({
          id: original.id,
          title: original.title,
          description: original.description,
          noteIds: original.note_ids,
        });
        shared.patch(original.id, {
          title: c.title,
          description: c.text,
          noteIds,
        });
      }
    }
    update(next, before);
    if (inverse.length) setUndo({ board: before, shared: inverse });
  }
  function selectedNoteIds() {
    return selectedNote
      ? [selectedNote]
      : (buildScene(displaySource!, displayBoard)
          .groups.find((g) => g.id === selectedGroup)
          ?.allNodes.map((n) => n.noteId) ?? []);
  }
  async function editSelectedConnection(payload: unknown) {
    if (linkBusy) return null;
    const p = payload as Pick<
      BoardConnection,
      "id" | "relation" | "reason" | "status"
    > & { expectedVersion: number };
    const old = sourceRef.current?.connections.find((c) => c.id === p.id);
    if (!old) return null;
    setLinkBusy(true);
    setError("");
    try {
      const result = await send("editConnection", p);
      patchConnection({
        ...old,
        relation: p.relation,
        reason: p.reason,
        ...(Object.hasOwn(p, "title") ? { title: (p as any).title } : {}),
        status: p.status,
        version: result.version,
      });
      setMessage(result.queued ? "기기에 저장됨" : "저장됨");
      return result;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setLinkBusy(false);
    }
  }
  async function showHiddenNotes(noteIds: string[]) {
    if (linkBusy) return false;
    setLinkBusy(true);
    setError("");
    try {
      if (timer.current) clearTimeout(timer.current);
      await runSave.current();
      if (dirty.current || needsChoice.current)
        throw Error(
          "먼저 배치의 저장 오류를 해결해 주세요. 메모와 선택은 유지됩니다.",
        );
      const result = await send("setWhiteboardNotesVisibility", {
        boardId,
        noteIds,
        visible: true,
      });
      version.current = result.version;
      const updated = {
        ...current.current,
        hiddenNoteIds: (current.current.hiddenNoteIds ?? []).filter(
          (id) => !noteIds.includes(id),
        ),
      };
      current.current = updated;
      setBoard(updated);
      remember(updated, false);
      resource.reload();
      setMessage(
        result.queued ? "기기에 저장됨" : "선택한 메모를 보이게 했습니다.",
      );
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setLinkBusy(false);
    }
  }
  function patchConnection(c: BoardConnection) {
    setLocalConnections((old) => [...old.filter((x) => x.id !== c.id), c]);
  }
  async function pair(a: string, b: string) {
    const s = sourceRef.current!;
    const old = connectionForPair(s.connections, a, b);
    if (old?.status === "accepted") return undefined;
    const result = await send("connectWhiteboardNotes", {
      sourceId: a,
      targetId: b,
    });
    const c: BoardConnection =
      result.connection ??
      (old
        ? { ...old, status: "accepted", version: result.version }
        : {
            id: result.id,
            source_kind: "note",
            source_id: [a, b].sort()[0],
            target_kind: "note",
            target_id: [a, b].sort()[1],
            relation: "related",
            status: "accepted",
            reason: "화이트보드에서 직접 연결",
            version: result.version,
          });
    patchConnection(c);
    if (result.changed === false) return undefined;
    return {
      id: c.id,
      version: c.version,
      status: result.previousStatus ?? old?.status ?? "rejected",
      relation: c.relation,
      reason: c.reason,
    };
  }
  async function drop(
    node: BoardNode,
    p: Point,
    target: ReturnType<typeof dropTarget>,
    groupOrigin?: Point,
  ) {
    const before = withVisibleChapter(
        projectSharedBoxes(current.current, sourceRef.current!),
        node.chapterId ?? "",
      ),
      moved = moveNote(before, node, p);
    const chapter = chapterAt(displayBoard, p.x + 110, p.y + 83);
    if (chapter && sourceRef.current) {
      if (chapter.items.some((item) => item.noteIds.includes(node.noteId))) {
        if (!node.chapterId || node.chapterId === chapter.id)
          update(moved, before);
        return;
      }
      commitMaterialBoard(
        putBoxNotes(
          withVisibleChapter(node.chapterId ? before : moved, chapter.id),
          chapter.id,
          [node.noteId],
          sourceRef.current,
        ),
        before,
      );
      return;
    }
    update(moved, before);
    if (!target) return;
    if (target.overlap && target.node.groupId?.startsWith("bundle:")) {
      const bundle = sourceRef.current?.bundles?.find(
        (b) => b.id === target.node.groupId!.slice(7),
      );
      if (bundle) {
        setLinkBusy(true);
        try {
          const result = await send("saveMemoBundle", {
            id: bundle.id,
            title: bundle.title,
            description: bundle.description,
            noteIds: [...new Set([...bundle.note_ids, node.noteId])],
            expectedVersion: bundle.version,
          });
          setUndo({
            board: before,
            bundle: {
              type: "saveMemoBundle",
              payload: {
                id: bundle.id,
                title: bundle.title,
                description: bundle.description,
                noteIds: bundle.note_ids,
                expectedVersion: result.version,
              },
            },
          });
          resource.reload();
          setMessage("생각 묶음에 메모를 담았습니다.");
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setLinkBusy(false);
        }
      }
      return;
    }
    setLinkBusy(true);
    setError("");
    try {
      const link = await pair(node.noteId, target.node.noteId);
      const next = target.overlap
        ? mergeNotes(
            current.current,
            { ...node, ...p },
            target.node,
            `manual:${crypto.randomUUID()}`,
            groupOrigin,
          )
        : current.current;
      update(next);
      setUndo({ board: before, link });
      setMessage(
        target.overlap ? "메모를 연결하고 묶었습니다." : "메모를 연결했습니다.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinkBusy(false);
    }
  }
  function selectNote(id: string) {
    if (linkBusy) return;
    setSelectedNote(id);
    setSelectedGroup(null);
    if (linkSource?.kind !== "note") return;
    const from = linkSource.id;
    setLinkSource(null);
    if (from === id) return;
    setLinkBusy(true);
    void pair(from, id)
      .then((link) => {
        setUndo({ board: current.current, link });
        setMessage("메모를 연결했습니다.");
      })
      .catch((e) => setError(e.message))
      .finally(() => setLinkBusy(false));
  }
  function selectGroup(id: string) {
    if (linkBusy) return;
    setSelectedGroup(id);
    setSelectedNote(null);
    if (linkSource?.kind === "group") {
      void connectNamedGroups(linkSource.id, id);
      setLinkSource(null);
    }
  }
  function groupDrop(
    group: BoardGroup,
    dx: number,
    dy: number,
    near: string | null,
  ) {
    if (linkBusy) return;
    const before = projectSharedBoxes(current.current, sourceRef.current!);
    let next = moveGroup(before, group, dx, dy);
    const chapter = chapterAt(
      displayBoard,
      group.x + dx + group.width / 2,
      group.y + dy + 60,
    );
    if (chapter && sourceRef.current) {
      commitMaterialBoard(
        putBoxNotes(
          withVisibleChapter(next, chapter.id),
          chapter.id,
          group.allNodes.map((n) => n.noteId),
          sourceRef.current,
        ),
        before,
      );
      return;
    }
    update(next, before);
    if (near) void connectNamedGroups(group.id, near, before);
  }
  async function connectNamedGroups(
    a: string,
    b: string,
    undoBoard = current.current,
  ) {
    if (a === b || linkBusy) return;
    if (!a.startsWith("bundle:") || !b.startsWith("bundle:")) {
      const before = current.current;
      if (
        !before.links.some(
          (l) =>
            (l.source === a && l.target === b) ||
            (l.source === b && l.target === a),
        )
      )
        update(
          { ...before, links: [...before.links, { source: a, target: b }] },
          undoBoard,
        );
      return;
    }
    const ids = [a.slice(7), b.slice(7)].sort();
    const old = sourceRef.current?.bundleLinks?.find(
      (l) => l.source_id === ids[0] && l.target_id === ids[1],
    );
    if (old?.status === "accepted") {
      setMessage("이미 연결된 묶음입니다.");
      return;
    }
    setLinkBusy(true);
    setError("");
    try {
      const result = await send("saveBundleLink", {
        ...(old ? { id: old.id } : {}),
        sourceId: ids[0],
        targetId: ids[1],
        expectedVersion: old?.version ?? 0,
        relation: old?.relation ?? "related",
        reason: old?.reason ?? "",
        status: "accepted",
      });
      setUndo({
        board: undoBoard,
        bundle: {
          type: "saveBundleLink",
          payload: {
            id: result.id,
            sourceId: ids[0],
            targetId: ids[1],
            relation: old?.relation ?? "related",
            reason: old?.reason ?? "",
            status: old?.status ?? "rejected",
            expectedVersion: result.version,
          },
        },
      });
      resource.reload();
      setMessage("생각 묶음을 연결했습니다.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinkBusy(false);
    }
  }
  async function undoLast() {
    if (!undo || linkBusy) return;
    setLinkBusy(true);
    try {
      if (undo.shared)
        for (const value of undo.shared) shared.patch(value.id, value);
      if (undo.bundle) {
        await send(undo.bundle.type, undo.bundle.payload);
        resource.reload();
      }
      if (undo.link) {
        const l = undo.link;
        const c = sourceRef.current?.connections.find((c) => c.id === l.id);
        const result = await send("editConnection", {
          id: l.id,
          expectedVersion: l.version,
          status: l.status,
          relation: l.relation,
          reason: l.reason,
        });
        if (c)
          patchConnection({ ...c, status: l.status, version: result.version });
      }
      update({ ...undo.board, hiddenNoteIds: current.current.hiddenNoteIds });
      criteriaEdited.current = false;
      setFilter(undo.board.filter);
      setUndo(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinkBusy(false);
    }
  }
  async function removeConnection(c: BoardConnection) {
    if (linkBusy) return;
    setLinkBusy(true);
    setError("");
    try {
      const result = await send("editConnection", {
        id: c.id,
        expectedVersion: c.version,
        status: "rejected",
        relation: c.relation,
        reason: c.reason,
      });
      patchConnection({ ...c, status: "rejected", version: result.version });
      setMessage("연결을 끊었습니다.");
      setUndo({
        board: current.current,
        link: {
          id: c.id,
          version: result.version,
          status: c.status,
          relation: c.relation,
          reason: c.reason,
        },
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinkBusy(false);
    }
  }
  async function removeGroupConnection(sourceId: string, targetId: string) {
    if (linkBusy) return;
    if (sourceId.startsWith("bundle:") && targetId.startsWith("bundle:")) {
      const ids = [sourceId.slice(7), targetId.slice(7)].sort(),
        link = sourceRef.current?.bundleLinks?.find(
          (l) => l.source_id === ids[0] && l.target_id === ids[1],
        );
      if (!link) return;
      setLinkBusy(true);
      try {
        const result = await send("saveBundleLink", {
          id: link.id,
          sourceId: link.source_id,
          targetId: link.target_id,
          relation: link.relation,
          reason: link.reason,
          status: "rejected",
          expectedVersion: link.version,
        });
        setUndo({
          board: current.current,
          bundle: {
            type: "saveBundleLink",
            payload: {
              id: link.id,
              sourceId: link.source_id,
              targetId: link.target_id,
              relation: link.relation,
              reason: link.reason,
              status: "accepted",
              expectedVersion: result.version,
            },
          },
        });
        resource.reload();
        setMessage("묶음 연결을 끊었습니다.");
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLinkBusy(false);
      }
      return;
    }
    setLinkBusy(true);
    setError("");
    if (timer.current) clearTimeout(timer.current);
    try {
      // Complete earlier local edits before issuing the versioned removal.
      // In replica mode this only waits for the durable device queue.
      await runSave.current();
      if (dirty.current || needsChoice.current)
        throw Error(
          "먼저 배치의 저장 오류를 해결해 주세요. 연결은 유지됩니다.",
        );
      const before = current.current;
      const links = before.links.filter(
        (l) =>
          !(
            (l.source === sourceId && l.target === targetId) ||
            (l.source === targetId && l.target === sourceId)
          ),
      );
      if (links.length === before.links.length) return;
      const next = { ...before, links };
      writing.current = true;
      const result = await send("saveWhiteboard", {
        boardId,
        data: next,
        expectedVersion: version.current,
      });
      version.current = result.version;
      observedLayout.current = layoutStamp(next);
      acknowledged.current.add(
        boardStamp({ id: boardId, data: next, version: result.version }),
      );
      current.current = next;
      setBoard(next);
      remember(next, false);
      setUndo({ board: before });
      setMessage("묶음 연결을 끊었습니다.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      writing.current = false;
      setLinkBusy(false);
    }
  }
  const derived = useMemo(() => {
    if (!source || !displaySource) return null;
    return {
      scene: buildScene(displaySource, displayBoard, { plain: display?.plain }),
      labels: new Map(
        source.notes.map((n) => [n.id, n.title || n.content.slice(0, 30)]),
      ),
    };
  }, [source, displaySource, displayBoard, display?.plain]);
  const facets = useMemo(
    () =>
      source
        ? {
            topics: [
              { value: "unclassified", label: "미분류" },
              ...source.topics.map((t) => ({ value: t.id, label: t.name })),
            ],
            tags: [...new Set(source.notes.flatMap((n) => n.tags ?? []))]
              .sort()
              .map((t) => ({ value: t, label: t })),
            categories: [
              ...categories.map(([value, label]) => ({ value, label })),
              { value: "unclassified", label: "미분류" },
            ],
            books: source.books.map((b) => ({
              value: b.id,
              label: `${b.title}${b.author ? " · " + b.author : ""}`,
            })),
          }
        : null,
    [source?.notes, source?.books, source?.topics],
  );
  if (!source || !derived || !facets || !initialized.current)
    return (
      <div className="panel">
        {resource.error ? (
          <p role="alert">
            {resource.error}
            <button onClick={resource.reload}>다시 조회</button>
          </p>
        ) : (
          <p role="status">화이트보드를 여는 중…</p>
        )}
      </div>
    );
  const { scene, labels } = derived;
  const selected = board.groups.find((g) => g.id === selectedGroup);
  return (
    <section
      className="whiteboard-panel"
      aria-label={
        writingTitle ? "글감묶음 화이트보드" : "사유의 지도 화이트보드"
      }
    >
      <form
        className="wb-search"
        onSubmit={(e) => {
          e.preventDefault();
          const before = current.current;
          criteriaEdited.current = false;
          setSearchRevision((n) => n + 1);
          update(
            arrangeSearchResults(
              source,
              seedBoard(source, { ...before, filter }),
            ),
            before,
          );
          setSelectedGroup(null);
          setConnectionView(null);
          setOverviewOnFit(false);
          setSelectedNote(null);
        }}
      >
        {(
          [
            ["topics", "주제"],
            ["tags", "태그"],
            ["categories", "분야"],
            ["books", "도서"],
          ] as const
        ).map(([field, label]) => (
          <FacetPicker
            key={field}
            label={label}
            multiple
            selectAll={field !== "books"}
            options={facets[field]}
            values={filter[field]}
            onChange={(values) => {
              criteriaEdited.current = true;
              setFilter((f) => ({ ...f, [field]: values }));
            }}
          />
        ))}
        <input
          type="search"
          className="wb-keyword"
          aria-label="메모 제목·내용 검색"
          placeholder="메모 제목·내용"
          value={filter.q}
          maxLength={500}
          onChange={(e) => {
            criteriaEdited.current = true;
            setFilter((f) => ({ ...f, q: e.target.value }));
          }}
        />
        <button className="primary" disabled={linkBusy}>
          검색
        </button>
      </form>
      <div className="wb-actions">
        <button
          type="button"
          disabled={linkBusy}
          onClick={async () => {
            if (linkBusy) return;
            setLinkBusy(true);
            try {
              const title = "생각묶음 " + (boxes.length + 1);
              const result = await send("saveMemoBundle", {
                title,
                description: "",
                noteIds: [],
                expectedVersion: 0,
              });
              const bundle = {
                id: result.id,
                title,
                description: "",
                note_ids: [],
                version: result.version,
                archived_at: null,
              };
              shared.accept(bundle);
              const before = current.current;
              if (plainBoard) {
                setBoxVisibility({
                  ...Object.fromEntries(
                    (before.writing?.chapters ?? []).map((c) => [
                      c.bundleId ?? c.id,
                      false,
                    ]),
                  ),
                  [bundle.id]: true,
                });
                setCheckedBoxes([bundle.id]);
              }
              setPlainBoard(false);
              update(
                referenceThoughtBox(before, bundle, sourceRef.current!),
                before,
              );
              setConnectionView(null);
              setSearchRevision((n) => n + 1);
              boxesResource.reload();
              resource.reload();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setLinkBusy(false);
            }
          }}
        >
          상자 추가
        </button>
        {writingTitle && (
          <>
            <button type="button" onClick={() => download("txt")}>
              TXT 내보내기
            </button>
            <button type="button" onClick={() => download("md")}>
              MD 내보내기
            </button>
          </>
        )}
        <strong>{new Set(scene.nodes.map((n) => n.noteId)).size}개 메모</strong>
        {([false, true] as const).map((collapse) => (
          <button
            key={String(collapse)}
            type="button"
            disabled={
              linkBusy || !scene.groups.some((g) => g.collapsed !== collapse)
            }
            onClick={() => {
              const before = current.current;
              const ids = new Set(scene.groups.map((g) => g.id));
              update(
                {
                  ...before,
                  collapsed: collapse
                    ? [...new Set([...before.collapsed, ...ids])]
                    : before.collapsed.filter((id) => !ids.has(id)),
                },
                before,
              );
            }}
          >
            {collapse ? "전체 접음" : "전체 펼침"}
          </button>
        ))}
        <button
          type="button"
          disabled={linkBusy || (!selectedNote && !selectedGroup)}
          className={linkSource ? "primary" : ""}
          onClick={() =>
            setLinkSource(
              selectedNote
                ? { kind: "note", id: selectedNote }
                : selectedGroup
                  ? { kind: "group", id: selectedGroup }
                  : null,
            )
          }
        >
          선택한 {selectedGroup ? "묶음" : "메모"} 연결
        </button>
        {linkSource && (
          <button type="button" onClick={() => setLinkSource(null)}>
            연결 취소
          </button>
        )}
        <button
          type="button"
          disabled={!undo || linkBusy}
          onClick={() => void undoLast()}
        >
          되돌리기
        </button>
        {selected && (
          <>
            <input
              className="wb-group-name"
              aria-label="묶음 이름"
              disabled={linkBusy}
              key={selected.id}
              defaultValue={selected.title}
              maxLength={80}
              onBlur={(e) => {
                if (linkBusy) return;
                const title = e.target.value.trim();
                if (title && title !== selected.title) {
                  const before = current.current;
                  update(
                    {
                      ...before,
                      groups: before.groups.map((g) =>
                        g.id === selected.id ? { ...g, title } : g,
                      ),
                    },
                    before,
                  );
                }
              }}
            />
            <button
              type="button"
              disabled={linkBusy}
              onClick={() => {
                const before = current.current;
                update(
                  {
                    ...before,
                    groups: before.groups.filter((g) => g.id !== selected.id),
                    links: before.links.filter(
                      (l) =>
                        l.source !== selected.id && l.target !== selected.id,
                    ),
                  },
                  before,
                );
                setSelectedGroup(null);
              }}
            >
              묶음 해제
            </button>
          </>
        )}
        <small role="status">
          {linkSource
            ? "연결할 다른 메모·묶음을 선택하세요."
            : linkBusy
              ? "연결 저장 중…"
              : saving
                ? "기기에 저장 중…"
                : message}
        </small>
      </div>
      <LegacyThoughtReview
        state={boxesResource.data}
        busy={linkBusy || saving}
        onMerge={(token) => {
          setLinkBusy(true);
          void send("promoteThoughtBoxes", { legacyToken: token })
            .catch((e) => setError(e.message))
            .finally(() => {
              setLinkBusy(false);
              resource.reload();
              boxesResource.reload();
            });
        }}
      />
      {(error || resource.error || shared.error) && (
        <p className="error wb-error" role="alert">
          {error || resource.error || shared.error}{" "}
          <button
            type="button"
            disabled={linkBusy}
            onClick={() => {
              void shared
                .flush()
                .then(() => runSave.current())
                .catch(() => {});
            }}
          >
            다시 저장
          </button>
        </p>
      )}
      {!!shared.conflicts.length && (
        <div className="notice">
          {shared.conflicts.map((b) => (
            <details key={b.id}>
              <summary>최신 원본: {b.title}</summary>
              <p className="preserve-text">{b.description}</p>
              <p>{b.note_ids.length}개 메모</p>
            </details>
          ))}
          <button type="button" onClick={shared.rebase}>
            최신 원본을 확인하고 내 입력 저장
          </button>
        </div>
      )}
      {conflict && (
        <div className="notice">
          다른 곳의 배치와 현재 배치가 다릅니다.{" "}
          <button
            disabled={linkBusy}
            onClick={() => {
              version.current = source.board?.version ?? 0;
              current.current = {
                ...current.current,
                hiddenNoteIds: source.board?.data.hiddenNoteIds,
              };
              setBoard(current.current);
              needsChoice.current = false;
              setConflict(false);
              pending.current = current.current;
              remember(current.current, true);
              setTimeout(() => void runSave.current(), 0);
            }}
          >
            현재 배치로 저장
          </button>
          <button
            disabled={linkBusy}
            onClick={() => {
              const next = seedBoard(
                source,
                source.board?.data ?? emptyBoard(),
              );
              version.current = source.board?.version ?? 0;
              current.current = next;
              setBoard(next);
              criteriaEdited.current = false;
              setFilter(next.filter);
              pending.current = null;
              dirty.current = false;
              needsChoice.current = false;
              remember(next, false);
              setConflict(false);
            }}
          >
            저장된 배치 사용
          </button>
        </div>
      )}
      {hasFocus && (
        <div className="wb-focus-toolbar">
          <strong>
            {connectionView === "all" ? "전체 연결" : "선택한 연결"} ·{" "}
            {new Set(scene.nodes.map((n) => n.noteId)).size}개 메모
          </strong>
          <button
            type="button"
            onClick={() => {
              setConnectionView(null);
              setBoxVisibility({});
              setCheckedBoxes([]);
              setCheckedConnections([]);
              setPlainBoard(true);
              setOverviewOnFit(false);
              setSearchRevision((n) => n + 1);
            }}
          >
            전체 보드 보기
          </button>
        </div>
      )}
      <div
        ref={canvasHost}
        className={linkBusy ? "wb-saving-link" : ""}
        aria-busy={linkBusy}
      >
        <WhiteboardCanvas
          source={displaySource!}
          board={displayBoard}
          suppliedScene={scene}
          saving={saving || shared.busy}
          onSave={
            writingTitle
              ? () => {
                  if (timer.current) clearTimeout(timer.current);
                  pending.current = current.current;
                  void shared
                    .flush()
                    .then(() => runSave.current())
                    .catch(() => {});
                }
              : undefined
          }
          numbered={!!writingTitle}
          onChapterChange={changeChapter}
          onChapterMove={(id, dx, dy) =>
            update(
              moveChapter(withVisibleChapter(current.current, id), id, dx, dy),
              current.current,
            )
          }
          onChapterRemove={(id) => {
            const before = current.current;
            const chapter = displayBoard.writing?.chapters.find(
              (c) => c.id === id,
            );
            const bundleId = chapter?.bundleId ?? id;
            setBoxVisibility((old) => ({ ...old, [bundleId]: false }));
            setCheckedBoxes((old) => old.filter((value) => value !== bundleId));
            if (!before.writing?.chapters.some((c) => c.id === id)) return;
            update(
              {
                ...before,
                writing: {
                  ...before.writing!,
                  chapters: before.writing!.chapters.filter((c) => c.id !== id),
                },
              },
              before,
            );
          }}
          canAddSelected={!!(selectedNote || selectedGroup)}
          onChapterAddSelected={(id) => {
            const ids = selectedNoteIds();
            if (ids.length)
              commitMaterialBoard(
                putBoxNotes(
                  withVisibleChapter(
                    projectSharedBoxes(current.current, sourceRef.current!),
                    id,
                  ),
                  id,
                  ids,
                  sourceRef.current!,
                ),
                current.current,
              );
          }}
          onNoteOrder={(chapterId, itemId, order) => {
            const chapter = displayBoard.writing?.chapters.find(
              (c) => c.id === chapterId,
            );
            if (!chapter) return;
            const flat = flattenBox(chapter, sourceRef.current!);
            changeChapter({
              ...flat,
              items: flat.items.map((i) =>
                i.id === itemId ? { ...i, order } : i,
              ),
            });
          }}
          onRemoveLooseNote={
            writingTitle
              ? (id) => {
                  const before = current.current;
                  update(
                    {
                      ...before,
                      writing: {
                        chapters: before.writing?.chapters ?? [],
                        ...before.writing,
                        excludedNoteIds: [
                          ...new Set([
                            ...(before.writing?.excludedNoteIds ?? []),
                            id,
                          ]),
                        ],
                      },
                    },
                    before,
                  );
                }
              : undefined
          }
          onChapterRemoveNote={(chapterId, itemId) => {
            const chapter = displayBoard.writing?.chapters.find(
              (c) => c.id === chapterId,
            );
            if (!chapter) return;
            const flat = flattenBox(chapter, sourceRef.current!);
            changeChapter({
              ...flat,
              items: flat.items.filter((i) => i.id !== itemId),
            });
          }}
          onViewChange={writingTitle ? rememberView : undefined}
          onDrop={(...args) => {
            if (!linkBusy) void drop(...args);
          }}
          onGroupDrop={groupDrop}
          onToggle={(id) => {
            if (linkBusy) return;
            const before = current.current;
            update(
              {
                ...before,
                collapsed: before.collapsed.includes(id)
                  ? before.collapsed.filter((x) => x !== id)
                  : [...before.collapsed, id],
              },
              before,
            );
          }}
          onOpen={(id, anchor) =>
            onOpen(
              "note",
              id,
              anchor ? { ...anchor, whiteboardId: WHITEBOARD_ID } : undefined,
            )
          }
          onSelectNote={selectNote}
          onSelectGroup={selectGroup}
          selectedNote={selectedNote}
          selectedGroup={selectedGroup}
          fitKey={JSON.stringify([
            board.filter,
            searchRevision,
            connectionView,
          ])}
          overviewOnFit={overviewOnFit}
          busy={linkBusy}
          onSelectLine={() => {
            setSelectedNote(null);
            setSelectedGroup(null);
            setLinkSource(null);
          }}
          onRemoveConnection={removeConnection}
          onRemoveGroupConnection={removeGroupConnection}
          onArrange={() => {
            if (linkBusy) return;
            const before = current.current;
            if (display?.plain)
              update(
                arrangePlainMemos(displaySource!, displayBoard, before),
                before,
              );
            else {
              const arranged = arrangeThoughtBoard(
                displayBoard,
                displaySource!,
              );
              const displayed = new Set(
                displayBoard.writing?.chapters.map((c) => c.id) ?? [],
              );
              update(
                {
                  ...before,
                  positions: { ...before.positions, ...arranged.positions },
                  groupPositions: {
                    ...before.groupPositions,
                    ...arranged.groupPositions,
                  },
                  writing: {
                    ...before.writing,
                    chapters: [
                      ...(before.writing?.chapters.filter(
                        (c) => !displayed.has(c.id),
                      ) ?? []),
                      ...(arranged.writing?.chapters ?? []),
                    ],
                  },
                },
                before,
              );
            }
            setSearchRevision((n) => n + 1);
          }}
        />
      </div>
      {!!focusGroups.length && (
        <section
          className="panel wb-relationship-detail"
          aria-label="연결된 메모 내용"
        >
          {focusGroups.map((group) => (
            <MemoGroupDetail
              key={group.id}
              compact
              group={group}
              onOpen={onOpen}
              busy={linkBusy}
              onSave={editSelectedConnection}
              onRemove={(c) => void removeConnection(c)}
            />
          ))}
        </section>
      )}
      <details className="wb-connection-list">
        <summary>
          <span className="wb-connection-counts">
            연결 관리 · 연결된 메모 {availableConnections.length} · 생각 묶음{" "}
            {boxes.length}
          </span>
          <span className="wb-connection-actions">
            <button
              type="button"
              disabled={
                linkBusy ||
                (!selectedConnectionIds.length &&
                  !checkedBoxes.some((id) => boxes.some((c) => c.id === id)))
              }
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void showConnections(selectedConnectionIds, true, checkedBoxes);
              }}
            >
              선택보기
            </button>
            <button
              type="button"
              disabled={
                linkBusy || (!availableConnections.length && !boxes.length)
              }
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void showConnections(
                  "all",
                  true,
                  boxes.map((c) => c.id),
                );
              }}
            >
              전체보기
            </button>
          </span>
        </summary>
        {availableConnections.map((c) => (
          <div key={c.id}>
            <label className="wb-connection-check">
              <input
                type="checkbox"
                aria-label={`${labels.get(c.source_id)} ↔ ${labels.get(c.target_id)} 선택`}
                checked={checkedConnections.includes(c.id)}
                onChange={() => showConnection(c)}
              />
            </label>
            <span className="wb-entry-badge" aria-label="연결된 메모">
              메
            </span>
            <button
              className="wb-connection-select"
              type="button"
              disabled={linkBusy}
              aria-pressed={checkedConnections.includes(c.id)}
              onClick={() => showConnection(c)}
              aria-label={`${labels.get(c.source_id)} ↔ ${labels.get(c.target_id)} 보드에서 보기`}
            >
              {c.title?.trim() ||
                `${labels.get(c.source_id)} ↔ ${labels.get(c.target_id)}`}{" "}
              <small>{relationNames[c.relation as Relation] ?? "관련"}</small>
            </button>
            <button
              type="button"
              disabled={linkBusy}
              onClick={() => void removeConnection(c)}
            >
              연결 해제
            </button>
          </div>
        ))}
        {boxes.map((box) => (
          <div key={box.id}>
            <label className="wb-connection-check">
              <input
                type="checkbox"
                aria-label={`${box.title} 생각 묶음 선택`}
                checked={checkedBoxes.includes(box.id)}
                onChange={() => toggleBox(box.id)}
              />
            </label>
            <span className="wb-entry-badge" aria-label="생각 묶음">
              생
            </span>
            <button
              type="button"
              className="wb-connection-select"
              disabled={linkBusy}
              onClick={() => toggleBox(box.id)}
              aria-pressed={checkedBoxes.includes(box.id)}
            >
              {box.title || "제목 없는 상자"}{" "}
              <small>
                {box.boardTitle} · {box.noteCount}개
              </small>
            </button>
          </div>
        ))}
        {boxesResource.error && (
          <p role="alert">
            {boxesResource.error}{" "}
            <button type="button" onClick={boxesResource.reload}>
              목록 다시 조회
            </button>
          </p>
        )}
      </details>
      {writingTitle && (
        <WritingAssist
          library={library}
          board={projectSharedBoxes(board, source)}
          source={source}
          boardId={boardId}
          title={writingTitle}
          ownerId={ownerId}
          onOpen={onOpen}
          onChange={(next) => commitMaterialBoard(next, current.current)}
        />
      )}
      {!writingTitle && (
        <HiddenWhiteboardNotes
          notes={source.notes.filter((n) =>
            (board.hiddenNoteIds ?? []).includes(n.id),
          )}
          busy={linkBusy}
          onOpen={(id) => onOpen("note", id)}
          onShow={showHiddenNotes}
        />
      )}
    </section>
  );
}
