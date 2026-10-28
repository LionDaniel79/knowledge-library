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
import { connectedMemoGroups, buildMemoBox } from "@/lib/memo-box";
import {
  revealMemoGroup,
  connectionGroupsForView,
} from "@/lib/whiteboard-workflows";
import { MemoGroupDetail } from "../memo-box/group-detail";
import { WritingTools } from "./writing-tools";
import { WritingAssist } from "./writing-assist";
import {
  addChapterMaterial,
  chapterAt,
  moveChapter,
  placeChapterMaterials,
  type WritingChapter,
} from "@/lib/writing-board";
import {
  boardSchema,
  boardStamp,
  WHITEBOARD_ID,
  emptyBoard,
  buildScene,
  filterNotes,
  moveNote,
  moveGroup,
  mergeNotes,
  connectGroups,
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
}: {
  library: Library;
  onOpen: (kind: string, id: string, anchor?: ModalAnchor) => void;
  ownerId: string;
  revision?: number;
  boardId?: string;
  writingTitle?: string;
  initialBoard?: Board;
  legacyNotes?: WhiteboardSnapshot["notes"];
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
    [checkedConnections, setCheckedConnections] = useState<string[]>([]),
    [linkSource, setLinkSource] = useState<{
      kind: "note" | "group";
      id: string;
    } | null>(null),
    [undo, setUndo] = useState<{ board: Board; link?: LinkUndo } | null>(null),
    [localConnections, setLocalConnections] = useState<BoardConnection[]>([]),
    [removedTopicLinks, setRemovedTopicLinks] = useState<string[]>([]);
  const current = useRef(board),
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
  const key = ownerId
    ? `library:whiteboard-draft:${ownerId}${boardId === WHITEBOARD_ID ? "" : ":" + boardId}`
    : "";
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
  async function send(type: string, payload: unknown) {
    const body = { requestId: crypto.randomUUID(), type, payload };
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
    if (saveTask.current) return saveTask.current;
    saveTask.current = (async () => {
      if (writing.current || needsChoice.current) return;
      writing.current = true;
      if (alive.current) setSaving(true);
      try {
        while (pending.current) {
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
    next = { ...next, hiddenNoteIds: current.current.hiddenNoteIds };
    current.current = next;
    setBoard(next);
    dirty.current = true;
    pending.current = next;
    remember(next, true);
    if (before) setUndo({ board: before });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void runSave.current(), 350);
  }
  async function updateRevealing(next: Board, before = current.current) {
    const hidden = new Set(next.hiddenNoteIds ?? []);
    const reveal = (before.hiddenNoteIds ?? []).filter((id) => !hidden.has(id));
    if (reveal.length && !(await showHiddenNotes(reveal))) return;
    update(next, before);
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) void runSave.current();
    };
  }, []);
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
        const value = seedBoard(data, data.board?.data ?? emptyBoard());
        version.current = v;
        current.current = value;
        setBoard(value);
        if (!criteriaEdited.current) setFilter(value.filter);
        remember(value, false);
      }
    }
  }, [resource.data, key, saving]);
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
      notes: [...notes.values()],
      connections: [...map.values()],
      topicLinks: resource.data.topicLinks?.filter(
        (l) => !removedTopicLinks.includes(l.id),
      ),
    };
  }, [resource.data, localConnections, legacyNotes, removedTopicLinks]);
  const topicModel = useMemo(
    () =>
      source
        ? buildMemoBox({
            ...source,
            board: { id: boardId, data: board, version: version.current },
          })
        : null,
    [source, board, boardId],
  );
  async function showTopicPair(
    pair: NonNullable<typeof topicModel>["topicPairs"][number],
  ) {
    if (!source || !topicModel) return;
    const ids = source.notes
      .filter((n) =>
        (topicModel.noteTopics.get(n.id) ?? []).some(
          (t) => t === pair.source || t === pair.target,
        ),
      )
      .map((n) => n.id);
    const before = current.current;
    const next = {
      ...before,
      hiddenNoteIds: (before.hiddenNoteIds ?? []).filter(
        (id) => !ids.includes(id),
      ),
      filter: { ...emptyBoard().filter, topics: [pair.source, pair.target] },
    };
    await updateRevealing(next, before);
    setFilter(next.filter);
    setConnectionView(null);
    setSearchRevision((n) => n + 1);
  }
  async function removeTopicPair(
    pair: NonNullable<typeof topicModel>["topicPairs"][number],
  ) {
    if (!source || linkBusy) return;
    setError("");
    setLinkBusy(true);
    try {
      for (const id of pair.topicLinkIds) {
        let link = source.topicLinks?.find((l) => l.id === id);
        if (!link?.version) {
          const r = await libraryRequest("/api/thought-map", {
              cache: "no-store",
            }),
            j = await r.json();
          if (!r.ok) throw Error(j.error);
          link = j.topicLinks.find((l: { id: string }) => l.id === id);
        }
        if (!link?.version) throw Error("주제 연결을 다시 불러와 주세요.");
        const r = await libraryRequest("/api/thought-map", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              requestId: crypto.randomUUID(),
              type: "decideTopicLink",
              payload: {
                id,
                expectedVersion: link.version,
                status: "rejected",
              },
            }),
          }),
          j = await r.json();
        if (!r.ok) throw Error(j.error);
        setRemovedTopicLinks((old) => [...old, id]);
      }
      for (const id of pair.connectionIds) {
        const c = source.connections.find((c) => c.id === id);
        if (!c || c.status !== "accepted") continue;
        const result = await send("editConnection", {
          id,
          expectedVersion: c.version,
          status: "rejected",
          relation: c.relation,
          reason: c.reason,
        });
        patchConnection({ ...c, version: result.version, status: "rejected" });
      }
      if (pair.board) {
        const before = current.current;
        update(
          {
            ...before,
            links: before.links.filter(
              (l) =>
                !(
                  [l.source, l.target].includes("topic:" + pair.source) &&
                  [l.source, l.target].includes("topic:" + pair.target)
                ),
            ),
          },
          before,
        );
      }
      setMessage("주제 연결을 해제했습니다.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinkBusy(false);
    }
  }
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
  const focusNotes = useMemo(
    () => focusGroups.flatMap((g) => g.notes),
    [focusGroups],
  );
  const hasFocus = connectionView !== null;
  const displaySource = useMemo(
    () => (source && hasFocus ? { ...source, notes: focusNotes } : source),
    [source, hasFocus, focusNotes],
  );
  const displayBoard = useMemo(
    () => (hasFocus ? { ...board, filter: emptyBoard().filter } : board),
    [board, hasFocus],
  );
  function showConnection(c: BoardConnection) {
    const group = memoGroups.find((g) =>
      g.connections.some((edge) => edge.id === c.id),
    );
    if (group) showConnections(group.connections.map((edge) => edge.id));
  }
  function showConnections(ids: string[] | "all", overview = false) {
    const s = sourceRef.current;
    if (!s || linkBusy) return;
    const groups = connectionGroupsForView(s, ids);
    if (!groups.length) return;
    const before = current.current;
    let next = groups.reduce(
      (b, g) =>
        revealMemoGroup(
          b,
          g.notes.map((n) => n.id),
          "manual:" + g.id,
        ),
      before,
    );
    if (groups.length > 1) {
      next = arrangeSearchResults(
        { ...s, notes: groups.flatMap((g) => g.notes) },
        { ...next, filter: emptyBoard().filter },
      );
      next = { ...next, filter: before.filter };
    }
    update(next, before);
    setSelectedGroup(groups.length === 1 ? "manual:" + groups[0].id : null);
    setSelectedNote(null);
    setLinkSource(null);
    setConnectionView(ids);
    setOverviewOnFit(overview);
    setSearchRevision((n) => n + 1);
    canvasHost.current?.scrollIntoView({ behavior: "smooth", block: "start" });
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
    const before = current.current,
      moved = moveNote(before, node, p);
    const chapter = writingTitle
      ? chapterAt(before, p.x + 110, p.y + 83)
      : undefined;
    if (chapter && sourceRef.current) {
      if (chapter.items.some((item) => item.noteIds.includes(node.noteId))) {
        update(moved, before);
        return;
      }
      update(
        addChapterMaterial(
          moved,
          chapter.id,
          {
            id: crypto.randomUUID(),
            order: Math.max(0, ...chapter.items.map((i) => i.order)) + 1,
            kind: "note",
            label: node.note.title || node.note.content.slice(0, 40),
            noteIds: [node.noteId],
            groupIds: [],
          },
          sourceRef.current,
        ),
        before,
      );
      return;
    }
    update(moved, before);
    if (!target) return;
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
      const before = current.current;
      update(connectGroups(before, linkSource.id, id), before);
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
    const before = current.current;
    let next = moveGroup(before, group, dx, dy);
    const chapter = writingTitle
      ? chapterAt(before, group.x + dx + group.width / 2, group.y + dy + 60)
      : undefined;
    if (chapter && sourceRef.current) {
      if (chapter.items.some((item) => item.groupIds.includes(group.id))) {
        update(next, before);
        return;
      }
      update(
        addChapterMaterial(
          next,
          chapter.id,
          {
            id: crypto.randomUUID(),
            order: Math.max(0, ...chapter.items.map((i) => i.order)) + 1,
            kind: group.id.startsWith("topic:") ? "topics" : "notes",
            label: group.title,
            noteIds: group.allNodes.map((n) => n.noteId),
            groupIds: [group.id],
          },
          sourceRef.current,
        ),
        before,
      );
      return;
    }
    if (near) next = connectGroups(next, group.id, near);
    update(next, before);
  }
  async function undoLast() {
    if (!undo || linkBusy) return;
    setLinkBusy(true);
    try {
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
      filtered: filterNotes(displaySource, displayBoard.filter).filter(
        (n) => !(board.hiddenNoteIds ?? []).includes(n.id),
      ),
      scene: buildScene(displaySource, displayBoard),
      labels: new Map(
        source.notes.map((n) => [n.id, n.title || n.content.slice(0, 30)]),
      ),
    };
  }, [source, displaySource, displayBoard, board]);
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
  const { filtered, scene, labels } = derived;
  const selected = board.groups.find((g) => g.id === selectedGroup);
  return (
    <section
      className="whiteboard-panel"
      aria-label={
        writingTitle ? "글감엮기 화이트보드" : "사유의 지도 화이트보드"
      }
    >
      {writingTitle && (
        <WritingTools
          title={writingTitle}
          board={board}
          source={source}
          selectedNote={selectedNote}
          selectedGroup={selectedGroup}
          onChange={(next) => void updateRevealing(next)}
        />
      )}
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
        <strong>
          {writingTitle
            ? new Set(scene.nodes.map((n) => n.noteId)).size
            : filtered.length}
          개 메모
        </strong>
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
      {(error || resource.error) && (
        <p className="error wb-error" role="alert">
          {error || resource.error}{" "}
          <button
            type="button"
            disabled={linkBusy}
            onClick={() => void runSave.current()}
          >
            다시 저장
          </button>
        </p>
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
            {focusNotes.length}개 메모
          </strong>
          <button
            type="button"
            onClick={() => {
              setConnectionView(null);
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
          saving={saving}
          onSave={
            writingTitle
              ? () => {
                  if (timer.current) clearTimeout(timer.current);
                  pending.current = current.current;
                  void runSave.current();
                }
              : undefined
          }
          onChapterChange={
            writingTitle
              ? (chapter: WritingChapter) => {
                  const before = current.current;
                  update(
                    {
                      ...before,
                      writing: {
                        ...before.writing!,
                        chapters: before.writing!.chapters.map((c) =>
                          c.id === chapter.id ? chapter : c,
                        ),
                      },
                    },
                    before,
                  );
                }
              : undefined
          }
          onChapterMove={
            writingTitle
              ? (id, dx, dy) =>
                  update(
                    moveChapter(current.current, id, dx, dy),
                    current.current,
                  )
              : undefined
          }
          onChapterRemove={
            writingTitle
              ? (id) => {
                  const before = current.current;
                  update(
                    {
                      ...before,
                      writing: {
                        ...before.writing!,
                        chapters: before.writing!.chapters.filter(
                          (c) => c.id !== id,
                        ),
                      },
                    },
                    before,
                  );
                }
              : undefined
          }
          onViewChange={
            writingTitle
              ? (view) => {
                  const before = current.current;
                  if (
                    JSON.stringify(before.writing?.viewport) ===
                    JSON.stringify(view)
                  )
                    return;
                  update({
                    ...before,
                    writing: {
                      chapters: before.writing?.chapters ?? [],
                      viewport: view,
                    },
                  });
                }
              : undefined
          }
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
              anchor ? { ...anchor, whiteboardId: boardId } : undefined,
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
            update(arrangeSearchResults(source, before), before);
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
            연결 관리 · 메모 {availableConnections.length} · 묶음{" "}
            {board.links.length} · 주제 {topicModel?.topicPairs.length ?? 0}
          </span>
          <span className="wb-connection-actions">
            <button
              type="button"
              disabled={linkBusy || !selectedConnectionIds.length}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                showConnections(selectedConnectionIds, true);
              }}
            >
              선택보기
            </button>
            <button
              type="button"
              disabled={linkBusy || !availableConnections.length}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                showConnections("all", true);
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
                onChange={(e) =>
                  setCheckedConnections((old) =>
                    e.target.checked
                      ? [...old, c.id]
                      : old.filter((id) => id !== c.id),
                  )
                }
              />
            </label>
            <button
              className="wb-connection-select"
              type="button"
              disabled={linkBusy}
              onClick={() => showConnection(c)}
              aria-label={`${labels.get(c.source_id)} ↔ ${labels.get(c.target_id)} 보드에서 보기`}
            >
              {labels.get(c.source_id)} ↔ {labels.get(c.target_id)}{" "}
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
        {board.links.map((l) => (
          <div key={l.source + ":" + l.target}>
            <span>
              {scene.groups.find((g) => g.id === l.source)?.title ?? "묶음"} ↔{" "}
              {scene.groups.find((g) => g.id === l.target)?.title ?? "묶음"}
            </span>
            <button
              type="button"
              disabled={linkBusy}
              onClick={() => removeGroupConnection(l.source, l.target)}
            >
              묶음 연결 해제
            </button>
          </div>
        ))}
        {topicModel?.topicPairs.map((p) => (
          <div key={"topic:" + p.id}>
            <button
              type="button"
              className="wb-connection-select"
              disabled={linkBusy}
              onClick={() => showTopicPair(p)}
            >
              {topicModel.topics.get(p.source)?.name} ↔{" "}
              {topicModel.topics.get(p.target)?.name} <small>주제 연결</small>
            </button>
            <button
              type="button"
              disabled={linkBusy}
              onClick={() => void removeTopicPair(p)}
            >
              주제 연결 해제
            </button>
          </div>
        ))}
      </details>
      {writingTitle && (
        <WritingAssist
          library={library}
          board={board}
          source={source}
          boardId={boardId}
          title={writingTitle}
          ownerId={ownerId}
          onOpen={onOpen}
          onChange={(next) => void updateRevealing(next)}
        />
      )}
      <HiddenWhiteboardNotes
        notes={source.notes.filter((n) =>
          (board.hiddenNoteIds ?? []).includes(n.id),
        )}
        busy={linkBusy}
        onOpen={(id) => onOpen("note", id)}
        onShow={showHiddenNotes}
      />
    </section>
  );
}
