import type {
  Board,
  BoardConnection,
  Point,
  WhiteboardSnapshot,
} from "./whiteboard";

type BaseLine = { id: string; a: Point; b: Point };
export type ConnectionLine = BaseLine &
  (
    | { kind: "note"; connections: BoardConnection[] }
    | { kind: "group"; link: Board["links"][number] }
  );
export function buildConnectionLines(
  source: WhiteboardSnapshot,
  board: Board,
  endpoint: (id: string) => (Point & { key: string }) | null,
  groupEndpoint: (id: string) => Point | null,
): ConnectionLine[] {
  const lines: ConnectionLine[] = [],
    notes = new Map<string, Extract<ConnectionLine, { kind: "note" }>>();
  for (const connection of source.connections) {
    if (
      connection.status !== "accepted" ||
      connection.source_kind !== "note" ||
      connection.target_kind !== "note"
    )
      continue;
    const a = endpoint(connection.source_id),
      b = endpoint(connection.target_id);
    if (!a || !b || a.key === b.key) continue;
    const id = "notes:" + [a.key, b.key].sort().join("|");
    const old = notes.get(id);
    if (old) old.connections.push(connection);
    else {
      const line: Extract<ConnectionLine, { kind: "note" }> = {
        id,
        a,
        b,
        kind: "note",
        connections: [connection],
      };
      notes.set(id, line);
      lines.push(line);
    }
  }
  for (const link of board.links) {
    const a = groupEndpoint(link.source),
      b = groupEndpoint(link.target);
    if (a && b)
      lines.push({
        id: "groups:" + [link.source, link.target].sort().join("|"),
        a,
        b,
        kind: "group",
        link,
      });
  }
  return lines;
}
export function hitPolygon(
  line: Pick<ConnectionLine, "a" | "b">,
  zoom: number,
): Point[] {
  const dx = line.b.x - line.a.x,
    dy = line.b.y - line.a.y,
    length = Math.hypot(dx, dy),
    half = 22 / Math.max(0.1, zoom);
  if (!length)
    return [
      { x: line.a.x - half, y: line.a.y - half },
      { x: line.a.x + half, y: line.a.y - half },
      { x: line.a.x + half, y: line.a.y + half },
      { x: line.a.x - half, y: line.a.y + half },
    ];
  const x = (-dy / length) * half,
    y = (dx / length) * half;
  return [
    { x: line.a.x + x, y: line.a.y + y },
    { x: line.b.x + x, y: line.b.y + y },
    { x: line.b.x - x, y: line.b.y - y },
    { x: line.a.x - x, y: line.a.y - y },
  ];
}
export function nearestConnectionLine(
  lines: ConnectionLine[],
  p: Point,
  tolerance: number,
): ConnectionLine | undefined {
  let selected: ConnectionLine | undefined,
    nearest = Infinity;
  for (const line of lines) {
    const dx = line.b.x - line.a.x,
      dy = line.b.y - line.a.y,
      t = Math.max(
        0,
        Math.min(
          1,
          ((p.x - line.a.x) * dx + (p.y - line.a.y) * dy) /
            (dx * dx + dy * dy || 1),
        ),
      ),
      distance = Math.hypot(p.x - line.a.x - t * dx, p.y - line.a.y - t * dy);
    if (distance <= tolerance && distance < nearest) {
      selected = line;
      nearest = distance;
    }
  }
  return selected;
}
