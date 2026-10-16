import { randomUUID } from "node:crypto";
import type {
  AnalysisRecord,
  ContextExcerpt,
  Membership,
  TopicLink,
} from "../../lib/thought-map/types";
import { ThoughtIndex, terms, type IndexedSource } from "./index";
export interface RetrievalHit {
  source: ContextExcerpt["source"];
  score: number;
  route: "same_topic" | "neighbor_topic" | "global";
  excerpt: ContextExcerpt;
  topicIds: string[];
}
export async function retrieveRelated(
  index: ThoughtIndex,
  query: AnalysisRecord,
  options: {
    limit: number;
    explicitTopicFilter?: string;
    excludedRoots?: Set<string>;
    eligibleNoteIds?: Set<string>;
    excludedSourceIds?: Set<string>;
  },
): Promise<RetrievalHit[]> {
  const docs = index.list(),
    anchor = docs.find(
      (d) =>
        d.source.kind === "note" &&
        d.source.id === query.id &&
        d.hash === query.contentHash,
    ),
    anchorTopics = anchor?.topicIds ?? [];
  const { topics, links } = index.taxonomy(),
    neighbors = new Set(
      links
        .filter(
          (l) =>
            l.status === "accepted" &&
            (anchorTopics.includes(l.sourceTopicId) ||
              anchorTopics.includes(l.targetTopicId)),
        )
        .flatMap((l) => [l.sourceTopicId, l.targetTopicId]),
    );
  const aliases = topics
      .filter((t) => t.confirmed && anchorTopics.includes(t.id))
      .flatMap((t) => t.aliases),
    tokens = new Set(terms(query.content + " " + aliases.join(" "))),
    queryVector = anchor ? index.vector(anchor.key, anchor.hash) : null;
  const eligible = docs
    .filter(
      (d) =>
        d.source.id !== query.id &&
        (!options.eligibleNoteIds ||
          (d.source.kind === "note" &&
            options.eligibleNoteIds.has(d.source.id))) &&
        !options.excludedSourceIds?.has(d.source.id) &&
        !options.excludedRoots?.has(d.rootId) &&
        (!options.explicitTopicFilter ||
          d.topicIds.includes(options.explicitTopicFilter)),
    )
    .map((d) => {
      const dt = terms(d.text),
        lex =
          dt.filter((t) => tokens.has(t)).length /
          Math.sqrt(Math.max(1, dt.length * tokens.size)),
        vec = queryVector ? index.vector(d.key, d.hash) : null,
        similarity = vec
          ? vec.reduce((sum, v, i) => sum + v * queryVector![i], 0)
          : 0;
      return {
        d,
        lex,
        similarity,
        score: 0,
        route: (d.topicIds.some((t) => anchorTopics.includes(t))
          ? "same_topic"
          : d.topicIds.some((t) => neighbors.has(t))
            ? "neighbor_topic"
            : "global") as RetrievalHit["route"],
      };
    })
    .filter((x) => x.lex > 0 || x.similarity >= 0.35);
  const scored = new Map<string, (typeof eligible)[number]>();
  for (const route of ["same_topic", "neighbor_topic", "global"] as const) {
    const pool = eligible.filter(
      (x) => route === "global" || x.route === route,
    );
    const lexical = [...pool]
        .filter((x) => x.lex > 0)
        .sort((a, b) => b.lex - a.lex || a.d.key.localeCompare(b.d.key))
        .slice(0, 20),
      vectors = [...pool]
        .filter((x) => x.similarity >= 0.35)
        .sort(
          (a, b) =>
            b.similarity - a.similarity || a.d.key.localeCompare(b.d.key),
        )
        .slice(0, 20);
    for (const list of [lexical, vectors])
      list.forEach((x, i) => {
        const old = scored.get(x.d.key) ?? { ...x, score: 0 };
        old.score += 1 / (60 + i + 1);
        scored.set(x.d.key, old);
      });
  }
  const sorted = [...scored.values()].sort(
      (a, b) => b.score - a.score || a.d.key.localeCompare(b.d.key),
    ),
    selected: typeof sorted = [],
    roots = new Set<string>(),
    limit = Math.max(1, Math.min(20, options.limit));
  const add = (hit: (typeof sorted)[number]) => {
    if (!roots.has(hit.d.rootId) && selected.length < limit) {
      roots.add(hit.d.rootId);
      selected.push(hit);
    }
  };
  if (!options.explicitTopicFilter && anchorTopics.length) {
    for (const hit of [...eligible]
      .filter((x) => !x.d.topicIds.some((t) => anchorTopics.includes(t)))
      .sort(
        (a, b) =>
          b.lex + b.similarity - a.lex - a.similarity ||
          a.d.key.localeCompare(b.d.key),
      )
      .slice(0, Math.min(2, limit)))
      add(scored.get(hit.d.key) ?? { ...hit, score: 1 / 81 });
  }
  for (const hit of sorted) add(hit);
  return selected.map((x) => ({
    source: x.d.source,
    score: x.score,
    route: x.route,
    topicIds: x.d.topicIds,
    excerpt: {
      id: x.d.key,
      text: x.d.text,
      source: x.d.source,
      coverage: x.d.coverage,
    },
  }));
}
export async function proposeMemberships(
  index: ThoughtIndex,
  source: ContextExcerpt,
): Promise<Membership[]> {
  const tokens = new Set(terms(source.text)),
    { topics } = index.taxonomy();
  return topics
    .map((topic) => ({
      topic,
      matches: terms(
        [topic.name, ...topic.aliases, topic.description].join(" "),
      ).filter((t) => tokens.has(t)),
    }))
    .filter((x) => x.matches.length)
    .sort((a, b) => b.matches.length - a.matches.length)
    .slice(0, 3)
    .map((x) => ({
      id: randomUUID(),
      topicId: x.topic.id,
      sourceKind:
        source.source.kind === "book_metadata"
          ? "book"
          : source.source.kind === "pdf"
            ? "pdf_chunk"
            : "note",
      sourceId: source.source.id,
      sourceVersion: source.source.version,
      status: "suggested",
      method: "topic-terms-v1",
      evidence: [
        {
          terms: x.matches,
          excerpt: source.text.slice(0, 300),
          coverage: source.coverage,
        },
      ],
      version: 1,
    }));
}
export async function proposeTopicLinks(
  index: ThoughtIndex,
): Promise<TopicLink[]> {
  const groups = new Map<string, IndexedSource[]>(),
    { links } = index.taxonomy();
  for (const doc of index.list().filter((d) => d.source.kind === "note")) {
    const ids = [...new Set(doc.topicIds)].sort();
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const key = ids[i] + ":" + ids[j];
        groups.set(key, [...(groups.get(key) ?? []), doc]);
      }
  }
  const result: TopicLink[] = [];
  for (const [key, docs] of groups) {
    const [a, b] = key.split(":"),
      roots = [...new Map(docs.map((d) => [d.rootId, d])).values()];
    if (
      roots.length < 2 ||
      links.some((l) => l.sourceTopicId === a && l.targetTopicId === b)
    )
      continue;
    result.push({
      id: randomUUID(),
      sourceTopicId: a,
      targetTopicId: b,
      status: "suggested",
      supportingPairs: roots
        .slice(0, 20)
        .map((d) => ({ beforeId: d.source.id, afterId: d.source.id })),
      version: 1,
    });
  }
  return result;
}
