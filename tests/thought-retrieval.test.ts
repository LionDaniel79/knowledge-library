import { it, expect } from "vitest";
import { ThoughtIndex, splitText } from "../src/local/thought-map/index";
import {
  retrieveRelated,
  proposeMemberships,
  proposeTopicLinks,
} from "../src/local/thought-map/retrieval";
const record = {
  id: "query",
  version: 1,
  eventVersion: 1,
  contentHash: "hash",
  content: "정서 수용과 돌봄",
  occurredOn: "2020-01-01",
  voice: "self" as const,
};
it("retains relevant cross-field and unclassified records instead of letting the largest topic dominate", async () => {
  const index = new ThoughtIndex(":memory:", "owner", "digest", 2);
  try {
    index.put(
      {
        key: "query",
        rootId: "query",
        source: { kind: "note", id: "query", version: "1", page: null },
        text: record.content,
        hash: "hash",
        topicIds: ["theology"],
        coverage: "full",
      },
      [1, 0],
    );
    for (let i = 0; i < 90; i++)
      index.put(
        {
          key: `t${i}`,
          rootId: `t${i}`,
          source: { kind: "note", id: `t${i}`, version: "1", page: null },
          text: "정서 수용과 돌봄 신학",
          hash: "h",
          topicIds: ["theology"],
          coverage: "full",
        },
        [1, 0],
      );
    for (const [key, topics] of [
      ["counseling", ["counseling"]],
      ["unclassified", []],
    ] as const)
      index.put(
        {
          key,
          rootId: key,
          source: { kind: "note", id: key, version: "1", page: null },
          text: "정서 수용과 돌봄 상담",
          hash: "h",
          topicIds: [...topics],
          coverage: "full",
        },
        [1, 0],
      );
    index.put(
      {
        key: "irrelevant",
        rootId: "x",
        source: { kind: "book_metadata", id: "x", version: "1", page: null },
        text: "주식 가격",
        hash: "h",
        topicIds: ["finance"],
        coverage: "metadata",
      },
      [0, 1],
    );
    const hits = await retrieveRelated(index, record, { limit: 6 });
    expect(hits).toHaveLength(6);
    expect(hits.map((h) => h.source.id)).toContain("counseling");
    expect(hits.map((h) => h.source.id)).not.toContain("irrelevant");
    const only = await retrieveRelated(index, record, {
      limit: 6,
      explicitTopicFilter: "theology",
    });
    expect(only.every((h) => h.topicIds.includes("theology"))).toBe(true);
  } finally {
    index.close();
  }
});
it("keeps exact Unicode offsets and refuses invalid or stale embeddings", () => {
  const text = "가😊정서 ".repeat(500),
    parts = splitText(text);
  expect(parts.length).toBeGreaterThan(1);
  for (const p of parts) {
    expect(text.slice(p.start, p.end)).toBe(p.text);
    expect(Array.from(p.text).length).toBeLessThanOrEqual(1000);
    expect(p.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  }
  const index = new ThoughtIndex(":memory:", "o", "d", 2),
    doc = {
      key: "n",
      rootId: "n",
      source: { kind: "note" as const, id: "n", version: "1", page: null },
      text: "정서",
      hash: "h",
      topicIds: [],
      coverage: "full" as const,
    };
  try {
    expect(() => index.put(doc, [0, 0])).toThrow();
    expect(() => index.put(doc, [NaN, 1])).toThrow();
    index.put(doc, [1, 0]);
    expect(index.vector("n", "changed")).toBeNull();
  } finally {
    index.close();
  }
});
it("only proposes a few topics and requires independent root sources for topic links", async () => {
  const index = new ThoughtIndex(":memory:", "o", "d", 2);
  try {
    index.setTopics(
      Array.from({ length: 5 }, (_, i) => ({
        id: String(i),
        name: "정서" + i,
        parentId: null,
        aliases: ["감정"],
        description: "정서 수용",
        kdcCodes: [],
        confirmed: true,
        version: 1,
      })),
      [],
    );
    const doc = {
      key: "a",
      rootId: "same-book",
      source: { kind: "note" as const, id: "a", version: "1", page: null },
      text: "감정 수용",
      hash: "h",
      topicIds: ["0", "1"],
      coverage: "full" as const,
    };
    index.put(doc);
    expect(
      await proposeMemberships(index, {
        id: "a",
        text: doc.text,
        source: doc.source,
        coverage: doc.coverage,
      }),
    ).toHaveLength(3);
    index.put({ ...doc, key: "b", source: { ...doc.source, id: "b" } });
    expect(await proposeTopicLinks(index)).toHaveLength(0);
    index.put({
      ...doc,
      key: "c",
      rootId: "independent",
      source: { ...doc.source, id: "c" },
    });
    expect((await proposeTopicLinks(index)).length).toBeGreaterThan(0);
  } finally {
    index.close();
  }
});
