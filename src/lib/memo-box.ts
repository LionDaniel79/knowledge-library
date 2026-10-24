import type { WhiteboardSnapshot } from "./whiteboard";
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
    topicPairs: [...pairs.values()],
  };
}
