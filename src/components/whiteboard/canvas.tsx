"use client";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  buildScene,
  dropTarget,
  NOTE_WIDTH,
  NOTE_HEIGHT,
  type Board,
  type BoardGroup,
  type BoardNode,
  type Point,
  type WhiteboardSnapshot,
} from "@/lib/whiteboard";
import { relationNames, type Relation } from "@/lib/knowledge";
type Drag = {
  kind: "note" | "group" | "pan";
  id: string;
  start: Point;
  dx: number;
  dy: number;
  moved: boolean;
  pointer: number;
};
export function WhiteboardCanvas({
  source,
  board,
  onDrop,
  onGroupDrop,
  onToggle,
  onOpen,
  onSelectNote,
  onSelectGroup,
  selectedNote,
  selectedGroup,
  fitKey,
}: {
  source: WhiteboardSnapshot;
  board: Board;
  onDrop: (
    node: BoardNode,
    p: Point,
    target: ReturnType<typeof dropTarget>,
  ) => void;
  onGroupDrop: (
    group: BoardGroup,
    dx: number,
    dy: number,
    near: string | null,
  ) => void;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onSelectNote: (id: string) => void;
  onSelectGroup: (id: string) => void;
  selectedNote: string | null;
  selectedGroup: string | null;
  fitKey: string;
}) {
  const viewport = useRef<HTMLDivElement>(null),
    active = useRef<Drag | null>(null),
    [drag, setDrag] = useState<Drag | null>(null),
    [view, setView] = useState({ x: 18, y: 18, zoom: 0.85 }),
    viewRef = useRef(view),
    frame = useRef(0);
  viewRef.current = view;
  const scene = useMemo(() => buildScene(source, board), [source, board]);
  const collapsed = new Set(
    scene.groups.filter((g) => g.collapsed).map((g) => g.id),
  );
  const visible = scene.nodes.filter(
    (n) => !n.groupId || !collapsed.has(n.groupId),
  );
  const delta = (id: string, groupId?: string | null) =>
    drag &&
    ((drag.kind === "note" && drag.id === id) ||
      (drag.kind === "group" && drag.id === groupId))
      ? { x: drag.dx, y: drag.dy }
      : { x: 0, y: 0 };
  const pointOf = (n: BoardNode) => {
    const d = delta(n.id, n.groupId);
    return { x: n.x + d.x, y: n.y + d.y };
  };
  const groupPoint = (g: BoardGroup) => {
    const d = delta("", g.id);
    return { x: g.x + d.x, y: g.y + d.y };
  };
  const moving =
    drag?.kind === "note"
      ? scene.nodes.find((n) => n.id === drag.id)
      : undefined;
  const near =
    moving && drag?.moved ? dropTarget(visible, moving, pointOf(moving)) : null;
  function fit(overview = true) {
    const el = viewport.current;
    if (!el) return;
    const rects = [
      ...scene.groups,
      ...scene.nodes
        .filter((n) => !n.groupId)
        .map((n) => ({ ...n, width: NOTE_WIDTH, height: NOTE_HEIGHT })),
    ];
    if (!rects.length) {
      setView({ x: 18, y: 18, zoom: 0.85 });
      return;
    }
    const x = Math.min(...rects.map((r) => r.x)),
      y = Math.min(...rects.map((r) => r.y)),
      w = Math.max(...rects.map((r) => r.x + r.width)) - x,
      h = Math.max(...rects.map((r) => r.y + r.height)) - y,
      zoom = Math.max(
        overview ? 0.1 : 0.9,
        Math.min(1, (el.clientWidth - 36) / w, (el.clientHeight - 36) / h),
      );
    setView({ x: 18 - x * zoom, y: 18 - y * zoom, zoom });
  }
  useEffect(() => {
    fit(false);
  }, [fitKey]); // Fit only after an explicit search, not after a drag/save.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) =>
        e.ctrlKey
          ? {
              ...v,
              zoom: Math.min(
                1.8,
                Math.max(0.1, v.zoom * (e.deltaY < 0 ? 1.1 : 0.9)),
              ),
            }
          : { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY },
      );
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", wheel);
      cancelAnimationFrame(frame.current);
    };
  }, []);
  function start(e: ReactPointerEvent, kind: Drag["kind"], id: string) {
    if (e.button !== 0 || (e.target as Element).closest("button,input,a"))
      return;
    e.preventDefault();
    e.stopPropagation();
    const state = {
      kind,
      id,
      start: { x: e.clientX, y: e.clientY },
      dx: 0,
      dy: 0,
      moved: false,
      pointer: e.pointerId,
    };
    active.current = state;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(state);
  }
  function move(e: ReactPointerEvent) {
    const d = active.current;
    if (!d || e.pointerId !== d.pointer) return;
    const scale = d.kind === "pan" ? 1 : viewRef.current.zoom;
    const dx = (e.clientX - d.start.x) / scale,
      dy = (e.clientY - d.start.y) / scale;
    const next = {
      ...d,
      dx,
      dy,
      moved:
        d.moved || Math.hypot(e.clientX - d.start.x, e.clientY - d.start.y) > 6,
    };
    active.current = next;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setDrag(next));
  }
  function end(e: ReactPointerEvent, cancel = false) {
    const d = active.current;
    if (!d || e.pointerId !== d.pointer) return;
    active.current = null;
    cancelAnimationFrame(frame.current);
    setDrag(null);
    if (cancel) return;
    if (d.kind === "pan") {
      if (d.moved) setView((v) => ({ ...v, x: v.x + d.dx, y: v.y + d.dy }));
      return;
    }
    if (d.kind === "note") {
      const n = scene.nodes.find((n) => n.id === d.id);
      if (!n) return;
      if (!d.moved) {
        onSelectNote(n.noteId);
        return;
      }
      const p = { x: Math.max(0, n.x + d.dx), y: Math.max(0, n.y + d.dy) };
      onDrop(n, p, dropTarget(visible, n, p));
    } else {
      const g = scene.groups.find((g) => g.id === d.id);
      if (!g) return;
      if (!d.moved) {
        onSelectGroup(g.id);
        return;
      }
      const x = g.x + d.dx,
        y = g.y + d.dy;
      const target = scene.groups
        .filter((t) => t.id !== g.id)
        .find(
          (t) =>
            Math.hypot(
              Math.max(0, t.x - x - g.width, x - t.x - t.width),
              Math.max(0, t.y - y - g.height, y - t.y - t.height),
            ) <= 40,
        );
      onGroupDrop(g, d.dx, d.dy, target?.id ?? null);
    }
  }
  const endpoint = (noteId: string) => {
    const n = scene.nodes.find((n) => n.noteId === noteId);
    if (!n) return null;
    const g = n.groupId ? scene.groups.find((g) => g.id === n.groupId) : null;
    if (g?.collapsed) {
      const p = groupPoint(g);
      return { ...p, x: p.x + g.width / 2, y: p.y + 60, key: g.id };
    }
    const p = pointOf(n);
    return { x: p.x + NOTE_WIDTH / 2, y: p.y + NOTE_HEIGHT / 2, key: n.id };
  };
  const lines: {
      id: string;
      a: Point;
      b: Point;
      label: string;
      group: boolean;
    }[] = [],
    seen = new Set<string>();
  for (const c of source.connections.filter((c) => c.status === "accepted")) {
    const a = endpoint(c.source_id),
      b = endpoint(c.target_id);
    if (!a || !b || a.key === b.key) continue;
    const key = [a.key, b.key].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({
      id: c.id,
      a,
      b,
      label: relationNames[c.relation as Relation] ?? "연결",
      group: false,
    });
  }
  for (const l of board.links) {
    const a = scene.groups.find((g) => g.id === l.source),
      b = scene.groups.find((g) => g.id === l.target);
    if (a && b) {
      const p = groupPoint(a),
        q = groupPoint(b);
      lines.push({
        id: l.source + ":" + l.target,
        a: { x: p.x + a.width / 2, y: p.y + 24 },
        b: { x: q.x + b.width / 2, y: q.y + 24 },
        label: "묶음 연결",
        group: true,
      });
    }
  }
  const size = {
    width: Math.max(
      1800,
      ...scene.groups.map((g) => g.x + g.width + 400),
      ...scene.nodes.map((n) => n.x + 500),
    ),
    height: Math.max(
      1200,
      ...scene.groups.map((g) => g.y + g.height + 400),
      ...scene.nodes.map((n) => n.y + 500),
    ),
  };
  return (
    <div className="wb-canvas-shell">
      <div className="wb-zoom">
        <button
          type="button"
          aria-label="축소"
          onClick={() =>
            setView((v) => ({ ...v, zoom: Math.max(0.1, v.zoom - 0.1) }))
          }
        >
          −
        </button>
        <span>{Math.round(view.zoom * 100)}%</span>
        <button
          type="button"
          aria-label="확대"
          onClick={() =>
            setView((v) => ({ ...v, zoom: Math.min(1.8, v.zoom + 0.1) }))
          }
        >
          ＋
        </button>
        <button type="button" onClick={() => fit()}>
          전체 보기
        </button>
      </div>
      <div
        className="wb-viewport"
        ref={viewport}
        aria-label="메모 화이트보드"
        onPointerDown={(e) => {
          if (!(e.target as Element).closest(".wb-note,.wb-group-head"))
            start(e, "pan", "");
        }}
        onPointerMove={move}
        onPointerUp={(e) => end(e)}
        onPointerCancel={(e) => end(e, true)}
      >
        <div
          className="wb-world"
          style={{
            ...size,
            transform: `translate(${view.x + (drag?.kind === "pan" ? drag.dx : 0)}px,${view.y + (drag?.kind === "pan" ? drag.dy : 0)}px) scale(${view.zoom})`,
          }}
        >
          {scene.groups.map((g) => {
            const p = groupPoint(g);
            return (
              <div
                className={`wb-group ${g.collapsed ? "collapsed" : ""} ${selectedGroup === g.id ? "selected" : ""}`}
                key={g.id}
                style={{
                  left: p.x,
                  top: p.y,
                  width: g.width,
                  height: g.height,
                }}
                data-group-id={g.id}
              >
                <div
                  className="wb-group-head"
                  onPointerDown={(e) => start(e, "group", g.id)}
                >
                  <strong>{g.title}</strong>
                  <small>{g.nodes.length}개</small>
                  <button
                    type="button"
                    aria-label={`${g.title} ${g.collapsed ? "펼치기" : "접기"}`}
                    onClick={() => onToggle(g.id)}
                  >
                    {g.collapsed ? "펼치기" : "접기"}
                  </button>
                  <button
                    type="button"
                    aria-label={`${g.title} 묶음 선택`}
                    onClick={() => onSelectGroup(g.id)}
                  >
                    선택
                  </button>
                </div>
                {g.collapsed && (
                  <div className="wb-stack-preview">
                    {g.nodes.slice(0, 2).map((n) => (
                      <span key={n.id}>
                        {n.note.title || n.note.content.slice(0, 24)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <svg
            className="wb-lines"
            width={size.width}
            height={size.height}
            aria-label="메모와 묶음 연결선"
          >
            {lines.map((l) => (
              <line
                key={l.id}
                x1={l.a.x}
                y1={l.a.y}
                x2={l.b.x}
                y2={l.b.y}
                stroke={l.group ? "#94693c" : "#648b7f"}
                strokeWidth={l.group ? 3 : 2}
                strokeDasharray={l.group ? "8 5" : undefined}
                vectorEffect="non-scaling-stroke"
              >
                <title>{l.label}</title>
              </line>
            ))}
          </svg>
          {visible.map((n, i) => {
            const p = pointOf(n);
            return (
              <article
                className={`wb-note wb-color-${i % 4} ${selectedNote === n.noteId ? "selected" : ""} ${near?.node.id === n.id ? "wb-drop-target" : ""}`}
                key={n.id}
                style={{
                  left: p.x,
                  top: p.y,
                  width: NOTE_WIDTH,
                  height: NOTE_HEIGHT,
                }}
                data-note-id={n.noteId}
                tabIndex={0}
                aria-label={`메모 ${n.note.title || n.note.content.slice(0, 30)}`}
                onPointerDown={(e) => start(e, "note", n.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectNote(n.noteId);
                  }
                }}
              >
                <strong>{n.note.title || "미분류 메모"}</strong>
                <p>{n.note.content}</p>
                <footer>
                  <small>
                    {source.books.find((b) => b.id === n.note.bookId)?.title ??
                      "나의 생각"}
                  </small>
                  <button
                    type="button"
                    onClick={() => onOpen(n.noteId)}
                    aria-label={`${n.note.title || "메모"} 열기`}
                  >
                    열기
                  </button>
                </footer>
                {near?.node.id === n.id && (
                  <span className="wb-drop-hint">
                    {near.overlap ? "연결하고 묶기" : "이 메모와 연결"}
                  </span>
                )}
              </article>
            );
          })}
        </div>
      </div>
      {!scene.nodes.length && (
        <p className="wb-empty">조건에 맞는 메모가 없습니다.</p>
      )}
    </div>
  );
}
