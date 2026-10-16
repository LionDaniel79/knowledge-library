import { LibraryError, type Executor } from "./library-store";
export interface SearchTopic {
  id: string;
  name: string;
  parentId: string | null;
  aliases: string[];
}
export type TopicRelation = "exact" | "child" | "related";
export async function listSearchTopics(
  db: Executor,
  owner: string,
): Promise<SearchTopic[]> {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  return (
    await db.query(
      "SELECT id,name,parent_id,aliases FROM library_topics WHERE owner_id=$1 AND confirmed=true ORDER BY name,id",
      [owner],
    )
  ).rows.map((t) => ({
    id: t.id,
    name: t.name,
    parentId: t.parent_id,
    aliases: t.aliases,
  }));
}
export async function searchContext(
  db: Executor,
  owner: string,
  query: {
    text: string;
    topicId?: string;
    topicScope?: "exact" | "children" | "related";
    expandAliases?: boolean;
  },
) {
  const topics =
    query.topicId || query.expandAliases
      ? await listSearchTopics(db, owner)
      : [];
  const scope = new Map<
    string,
    { id: string; name: string; relation: TopicRelation }
  >();
  if (query.topicId) {
    const selected = topics.find((t) => t.id === query.topicId);
    if (!selected)
      throw new LibraryError(404, "확인된 주제를 찾을 수 없습니다.");
    scope.set(selected.id, {
      id: selected.id,
      name: selected.name,
      relation: "exact",
    });
    if (query.topicScope === "children" || query.topicScope === "related") {
      let changed = true;
      while (changed) {
        changed = false;
        for (const t of topics)
          if (t.parentId && scope.has(t.parentId) && !scope.has(t.id)) {
            scope.set(t.id, { id: t.id, name: t.name, relation: "child" });
            changed = true;
          }
      }
    }
    if (query.topicScope === "related") {
      const links = (
        await db.query(
          "SELECT source_topic_id,target_topic_id FROM library_topic_links WHERE owner_id=$1 AND status='accepted' AND (source_topic_id=$2 OR target_topic_id=$2)",
          [owner, selected.id],
        )
      ).rows;
      for (const l of links) {
        const id =
            l.source_topic_id === selected.id
              ? l.target_topic_id
              : l.source_topic_id,
          t = topics.find((t) => t.id === id);
        if (t && !scope.has(id))
          scope.set(id, { id, name: t.name, relation: "related" });
      }
    }
  }
  const terms = [query.text];
  if (query.expandAliases && query.text)
    for (const t of topics) {
      const names = [t.name, ...t.aliases].map((x) => x.trim()).filter(Boolean);
      if (names.some((x) => x.toLowerCase() === query.text.toLowerCase()))
        for (const n of names)
          if (
            !terms.some((x) => x.toLowerCase() === n.toLowerCase()) &&
            terms.length < 21
          )
            terms.push(n);
    }
  return { terms, scope };
}
