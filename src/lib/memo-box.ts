import type { WhiteboardSnapshot } from "./whiteboard";
export function connectedMemoGroups(
  source: Pick<WhiteboardSnapshot, "notes" | "connections"> &
    Partial<Pick<WhiteboardSnapshot, "board">>,
) {
  const notes = new Map(source.notes.map((n) => [n.id, n]));
  const noteRows = new Map<
    string,
    { note: WhiteboardSnapshot["notes"][number]; index: number }[]
  >();
  source.notes.forEach((note, index) => {
    const rows = noteRows.get(note.id);
    if (rows) rows.push({ note, index });
    else noteRows.set(note.id, [{ note, index }]);
  });
  const orderedNotes = (ids: Set<string>) =>
    [...ids]
      .flatMap((id) => noteRows.get(id) ?? [])
      .sort((a, b) => a.index - b.index)
      .map((row) => row.note);
  const edges = source.connections.filter(
    (c) =>
      c.status === "accepted" &&
      c.source_kind === "note" &&
      c.target_kind === "note" &&
      c.source_id !== c.target_id &&
      notes.has(c.source_id) &&
      notes.has(c.target_id),
  );
  const edgeIndexesById = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    const indexes = edgeIndexesById.get(edge.id);
    if (indexes) indexes.push(index);
    else edgeIndexesById.set(edge.id, [index]);
  });
  const adjacent = new Map<string, Set<string>>();
  const visited = new Set<string>(),
    groups: {
      id: string;
      title: string;
      reason?: string;
      children?: string[][];
      notes: WhiteboardSnapshot["notes"];
      connections: WhiteboardSnapshot["connections"];
    }[] = [];
  // Explicit partitions preserve shared notes when a higher-level group is split.
  const reserved = new Set<string>();
  for (const saved of [...(source.board?.data.memoGroups ?? [])].sort(
    (a, b) => b.connectionIds.length - a.connectionIds.length,
  )) {
    if (saved.connectionIds.some((id) => reserved.has(id))) continue;
    const connections = [...new Set(saved.connectionIds)]
      .flatMap((id) => edgeIndexesById.get(id) ?? [])
      .sort((a, b) => a - b)
      .map((index) => edges[index]);
    if (connections.length !== saved.connectionIds.length) continue;
    const ids = new Set(connections.flatMap((e) => [e.source_id, e.target_id]));
    connections.forEach((e) => reserved.add(e.id));
    groups.push({
      id: connections.map((e) => e.id).sort()[0],
      title:
        (connections.length === 1 ? connections[0].title : saved.title) ||
        connections
          .map((e) => e.title?.trim())
          .filter(Boolean)
          .slice(0, 2)
          .join(" · "),
      reason: connections.length === 1 ? connections[0].reason : saved.reason,
      children: saved.children ?? connections.map((c) => [c.id]),
      notes: orderedNotes(ids),
      connections,
    });
  }
  for (const e of edges.filter((e) => !reserved.has(e.id)))
    for (const [a, b] of [
      [e.source_id, e.target_id],
      [e.target_id, e.source_id],
    ]) {
      if (!adjacent.has(a)) adjacent.set(a, new Set());
      adjacent.get(a)!.add(b);
    }
  const components: Set<string>[] = [];
  const componentByNote = new Map<string, Set<string>>();
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
    components.push(ids);
    for (const id of ids) componentByNote.set(id, ids);
  }
  const componentEdges = new Map<Set<string>, typeof edges>();
  for (const edge of edges) {
    if (reserved.has(edge.id)) continue;
    const component = componentByNote.get(edge.source_id)!;
    const list = componentEdges.get(component);
    if (list) list.push(edge);
    else componentEdges.set(component, [edge]);
  }
  for (const ids of components) {
    const connections = componentEdges.get(ids)!,
      titles = [
        ...new Set(connections.map((c) => c.title?.trim()).filter(Boolean)),
      ];
    const children = connections.map((c) => [c.id]);
    const attached = reserved.size
      ? groups.filter((g) => g.notes.some((note) => ids.has(note.id)))
      : [];
    for (const old of attached) {
      children.push(old.connections.map((c) => c.id));
      old.notes.forEach((note) => ids.add(note.id));
      connections.push(...old.connections);
      groups.splice(groups.indexOf(old), 1);
    }
    groups.push({
      children,
      id: connections.map((c) => c.id).sort()[0],
      title:
        titles.slice(0, 2).join(" · ") +
        (titles.length > 2 ? ` 외 ${titles.length - 2}개` : ""),
      notes: orderedNotes(ids),
      connections,
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
    const list = memberships.get(key);
    if (list) list.push(m);
    else memberships.set(key, [m]);
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
  for (const c of edges)
    for (const id of [c.source_id, c.target_id]) {
      const list = connections.get(id);
      if (list) list.push(c);
      else connections.set(id, [c]);
    }
  return {
    notes,
    topics,
    noteTopics,
    edges,
    connections,
    connected: source.notes.filter((n) => connections.has(n.id)),
    groups: connectedMemoGroups(source),
  };
}
