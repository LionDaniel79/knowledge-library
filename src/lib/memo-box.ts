import type { WhiteboardSnapshot } from "./whiteboard";
export function connectedMemoGroups(
  source: Pick<WhiteboardSnapshot, "notes" | "connections">,
) {
  const notes = new Map(source.notes.map((n) => [n.id, n]));
  const edges = source.connections.filter(
    (c) =>
      c.status === "accepted" &&
      c.source_kind === "note" &&
      c.target_kind === "note" &&
      c.source_id !== c.target_id &&
      notes.has(c.source_id) &&
      notes.has(c.target_id),
  );
  const adjacent = new Map<string, Set<string>>();
  for (const e of edges)
    for (const [a, b] of [
      [e.source_id, e.target_id],
      [e.target_id, e.source_id],
    ]) {
      if (!adjacent.has(a)) adjacent.set(a, new Set());
      adjacent.get(a)!.add(b);
    }
  const visited = new Set<string>(),
    groups: {
      id: string;
      notes: WhiteboardSnapshot["notes"];
      connections: WhiteboardSnapshot["connections"];
    }[] = [];
  for (const n of source.notes) {
    if (visited.has(n.id) || !adjacent.has(n.id)) continue;
    const ids = new Set([n.id]),
      queue = [n.id];
    visited.add(n.id);
    for (let i = 0; i < queue.length; i++)
      for (const next of adjacent.get(queue[i]) ?? [])
        if (!visited.has(next)) {
          visited.add(next);
          ids.add(next);
          queue.push(next);
        }
    groups.push({
      id: [...ids].sort()[0],
      notes: source.notes.filter((note) => ids.has(note.id)),
      connections: edges.filter(
        (e) => ids.has(e.source_id) && ids.has(e.target_id),
      ),
    });
  }
  return groups;
}
export function buildMemoBox(source: WhiteboardSnapshot) {
  const notes = new Map(source.notes.map((n) => [n.id, n]));
  const topics = new Map(source.topics.map((t) => [t.id, t]));
  const memberships = new Map<string, typeof source.memberships>();
  for (const m of source.memberships) {
    const key = m.sourceKind + ":" + m.sourceId;
    memberships.set(key, [...(memberships.get(key) ?? []), m]);
  }
  const noteTopics = new Map<string, string[]>();
  for (const n of source.notes) {
    const direct = memberships.get("note:" + n.id) ?? [];
    const assigned = new Set(
      (memberships.get("book:" + n.bookId) ?? [])
        .filter((m) => m.status === "accepted")
        .map((m) => m.topicId),
    );
    for (const m of direct) {
      if (m.status === "accepted") assigned.add(m.topicId);
      else if (m.status === "rejected") assigned.delete(m.topicId);
    }
    noteTopics.set(
      n.id,
      [...assigned].filter((id) => topics.has(id)),
    );
  }
  const edges = source.connections.filter(
    (c) =>
      c.status === "accepted" &&
      c.source_kind === "note" &&
      c.target_kind === "note" &&
      c.source_id !== c.target_id &&
      notes.has(c.source_id) &&
      notes.has(c.target_id),
  );
  const connections = new Map<string, typeof edges>();
  const pairs = new Map<
    string,
    {
      id: string;
      source: string;
      target: string;
      connectionIds: string[];
      board: boolean;
      topicLinkIds: string[];
    }
  >();
  function pair(a: string, b: string) {
    if (a === b || !topics.has(a) || !topics.has(b)) return;
    const [source, target] = [a, b].sort(),
      id = source + ":" + target;
    if (!pairs.has(id))
      pairs.set(id, {
        id,
        source,
        target,
        connectionIds: [],
        board: false,
        topicLinkIds: [],
      });
    return pairs.get(id)!;
  }
  for (const c of edges) {
    for (const id of [c.source_id, c.target_id])
      connections.set(id, [...(connections.get(id) ?? []), c]);
    for (const a of noteTopics.get(c.source_id) ?? [])
      for (const b of noteTopics.get(c.target_id) ?? []) {
        const p = pair(a, b);
        if (p && !p.connectionIds.includes(c.id)) p.connectionIds.push(c.id);
      }
  }
  for (const l of source.board?.data.links ?? [])
    if (l.source.startsWith("topic:") && l.target.startsWith("topic:")) {
      const p = pair(l.source.slice(6), l.target.slice(6));
      if (p) p.board = true;
    }
  for (const l of source.topicLinks ?? [])
    if (l.status === "accepted") {
      const p = pair(l.sourceTopicId, l.targetTopicId);
      if (p) p.topicLinkIds.push(l.id);
    }
  return {
    notes,
    topics,
    noteTopics,
    edges,
    connections,
    connected: source.notes.filter((n) => connections.has(n.id)),
    groups: connectedMemoGroups(source),
    topicPairs: [...pairs.values()],
  };
}
