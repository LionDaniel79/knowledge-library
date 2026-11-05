import { createMemoryReplica } from "../../src/client/replica/memory-storage";
import { createReplicaRepository } from "../../src/client/replica/repository";
import { sha256Bytes } from "../../src/lib/replica/codec";
import { syncKey, type SyncEntity } from "../../src/lib/replica/entities";
import { createSyncCursor } from "../../src/lib/replica/contracts";
import type { ReplicaStorage } from "../../src/client/replica/storage";
const date = "2026-10-17T01:00:00Z";
export async function resourceFixture(provided?: ReplicaStorage) {
  const s = provided ?? createMemoryReplica("resources"),
    epoch = crypto.randomUUID();
  const g = await s.createGeneration({
    epoch,
    cursor: createSyncCursor({ owner: s.owner, epoch, after: "1" }),
  });
  const book = crypto.randomUUID(),
    note = crypto.randomUUID(),
    review = crypto.randomUUID(),
    topic = crypto.randomUUID(),
    research = crypto.randomUUID(),
    curation = crypto.randomUUID(),
    ref = crypto.randomUUID();
  const records: [SyncEntity, any][] = [
    [
      "library_books",
      {
        id: book,
        title: "넥서스",
        author: "하라리",
        publisher: "김영사",
        isbn: "9791194330424",
        formats: ["paper"],
        tags: [],
        bookshelves: [],
        version: 1,
        created_at: date,
        source_data: null,
      },
    ],
    [
      "library_notes",
      {
        id: note,
        book_id: book,
        title: "내 생각",
        content: "정보와 신뢰를 함께 생각한다",
        kind: "thought",
        page: null,
        tags: [],
        version: 1,
        created_at: date,
        updated_at: date,
        source_data: null,
      },
    ],
    [
      "library_catalog_reviews",
      {
        id: review,
        book_id: book,
        book_snapshot: { title: "넥서스" },
        record: {
          title: "넥서스",
          isbn: "9791194330424",
          facts: { author: "하라리", publisher: "김영사" },
          toc: ["정보"],
          raw: { original: "보존" },
        },
        status: "pending",
        version: 1,
        source_version: 1,
        created_at: date,
        decision: null,
      },
    ],
    [
      "library_reference_sources",
      {
        id: ref,
        source_kind: "book",
        source_id: book,
        source_version: "1",
        url: "https://example.test/book",
        provider: "library",
        title: "원문",
        retrieved_at: date,
        edition_match: "isbn",
      },
    ],
    [
      "library_curation_items",
      {
        id: curation,
        source_kind: "book",
        source_id: book,
        source_version: "1",
        kind: "publisher_intro",
        value: "책 소개",
        evidence: { referenceId: ref },
        coverage: "metadata",
        origin: "provider",
        generator: "library",
        state: "active",
        version: 1,
        reviewed_by: null,
        created_at: date,
      },
    ],
    [
      "library_book_introductions",
      {
        id: crypto.randomUUID(),
        book_id: book,
        book_version: 1,
        text: "내가 정리한 소개",
        sources: [],
        version: 1,
        updated_at: date,
      },
    ],
    [
      "library_topics",
      {
        id: topic,
        name: "신뢰",
        aliases: [],
        confirmed: true,
        version: 1,
        created_at: date,
      },
    ],
    [
      "library_topic_memberships",
      {
        id: crypto.randomUUID(),
        topic_id: topic,
        source_kind: "note",
        source_id: note,
        status: "accepted",
        version: 1,
      },
    ],
    [
      "library_research",
      {
        id: research,
        title: "신뢰 연구",
        question: "어떻게 신뢰하는가",
        kind: "thesis",
        created_at: date,
      },
    ],
    [
      "library_research_items",
      {
        id: crypto.randomUUID(),
        research_id: research,
        note_id: note,
        snapshot: { content: "예전 원문" },
        created_at: date,
      },
    ],
    [
      "library_ai_policy",
      {
        runtime_mode: "manual_only",
        requests_enabled: true,
        request_limit_usd: "0.010000",
        runtime_monthly_limit_usd: "5.000000",
        development_limit_usd: null,
        version: 1,
        updated_at: date,
      },
    ],
    [
      "library_ai_usage",
      {
        id: crypto.randomUUID(),
        phase: "runtime",
        period: new Date().toISOString().slice(0, 7),
        status: "settled",
        cost_usd: "0.000001",
        max_cost_usd: "0.010000",
        created_at: date,
      },
    ],
    [
      "library_assist_requests",
      {
        id: review,
        purpose: "organize_note",
        status: "completed",
        error_code: null,
        created_at: date,
        updated_at: date,
      },
    ],
    [
      "library_assist_results",
      {
        id: crypto.randomUUID(),
        request_id: review,
        result: { valid: true, output: { items: ["신뢰"] } },
        adoption: [],
        created_at: date,
      },
    ],
  ];
  for (const [entity, value] of records) {
    const inline = JSON.stringify(value),
      bytes = new TextEncoder().encode(inline);
    await s.stageRows(g.generation, [
      {
        entity,
        key: syncKey(entity, value),
        revision: "1",
        deleted: false,
        inline,
        bytes: bytes.length,
        sha256: await sha256Bytes(bytes),
      },
    ]);
  }
  await s.setCheckpoint(g.generation, {
    complete: true,
    changeOrderVersion: 2,
  });
  await s.promoteGeneration(g.generation);
  return {
    s,
    repo: createReplicaRepository(s),
    book,
    note,
    review,
    topic,
    research,
    curation,
    ref,
  };
}
