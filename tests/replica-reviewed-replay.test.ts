import { expect, it } from "vitest";
import { resourceFixture } from "./helpers/replica-resources";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import { pushReplica } from "../src/client/replica/push";
import {
  loadReplicaConflict,
  applyReplicaResolution,
} from "../src/client/replica/conflicts";
import { createLocalReplicaRepository } from "../src/client/replica/repository-local";
import {
  prepareOptimistic,
  type QueuedChange,
} from "../src/client/replica/optimistic";
import { sha256Bytes } from "../src/lib/replica/codec";
import type { SyncEntity } from "../src/lib/replica/entities";

type Fixture = Awaited<ReturnType<typeof resourceFixture>>;
async function stage(f: Fixture, entity: SyncEntity, row: any) {
  const cp = (await f.s.checkpoint())!,
    inline = JSON.stringify(row),
    bytes = new TextEncoder().encode(inline);
  await f.s.stageRows(cp.generation, [
    {
      entity,
      key: JSON.stringify([row.id]),
      revision: String(row.version ?? 2),
      deleted: false,
      inline,
      bytes: bytes.length,
      sha256: await sha256Bytes(bytes),
    },
  ]);
  f.repo.invalidate();
}
function queue(f: Fixture, type: string, payload: any, path = "/api/library") {
  return queueReplicaCommand({
    storage: f.s,
    repository: f.repo,
    path,
    body: { requestId: crypto.randomUUID(), type, payload },
  });
}
async function review(f: Fixture) {
  await pushReplica({
    storage: f.s,
    send: async () => {
      throw Object.assign(Error("Changed on another device"), { status: 409 });
    },
    pull: async () => {},
  });
  return loadReplicaConflict(f.s, (await f.s.listOutbox())[0].requestId);
}
async function pushToDownloadedState(f: Fixture) {
  const server = createLocalReplicaRepository({
    ...f.s,
    listOutbox: async () => [],
  });
  try {
    return await pushReplica({
      storage: f.s,
      send: async (entry) => {
        server.invalidate();
        const change = entry.command as QueuedChange,
          prepared = await prepareOptimistic(
            server,
            change.path,
            change.body,
            change.at,
          );
        for (const effect of prepared.effects)
          if (effect.after) await stage(f, effect.entity, effect.after);
        return prepared.result;
      },
      pull: async () => {},
    });
  } finally {
    server.close();
    f.repo.invalidate();
  }
}

it("reviews a concurrent classification by its topic and source, then preserves its canonical identity in dependent changes", async () => {
  const f = await resourceFixture();
  try {
    const topic = {
      id: crypto.randomUUID(),
      name: "같이 만든 분류",
      version: 1,
      parent_id: null,
      archived_at: null,
    };
    await stage(f, "library_topics", topic);
    const payload = {
      topicId: topic.id,
      sourceKind: "note",
      sourceId: f.note,
      sourceVersion: "1",
      status: "accepted",
      expectedVersion: 0,
    };
    await queue(f, "assignTopic", payload, "/api/thought-map");
    await queue(
      f,
      "assignTopic",
      { ...payload, status: "rejected", expectedVersion: 1 },
      "/api/thought-map",
    );
    const canonicalId = crypto.randomUUID();
    await stage(f, "library_topic_memberships", {
      id: canonicalId,
      topic_id: topic.id,
      source_kind: "note",
      source_id: f.note,
      source_version: "1",
      status: "suggested",
      method: "manual",
      evidence: [],
      version: 1,
    });
    const selected = await review(f),
      conflicted = structuredClone(await f.s.listOutbox());
    expect(selected.latest).toMatchObject({
      id: canonicalId,
      status: "suggested",
    });
    await applyReplicaResolution(f.s, selected, { choice: "mine" });
    const pending = await f.s.listOutbox();
    expect(pending).toHaveLength(2);
    expect(pending.every((entry) => entry.entityId === canonicalId)).toBe(true);
    expect((await pushToDownloadedState(f)).conflicts).toBe(0);
    expect(await f.s.listOutbox()).toHaveLength(0);
    expect(
      await f.repo.raw("library_topic_memberships", canonicalId),
    ).toMatchObject({ status: "rejected", version: 3 });
    expect((await f.s.listConflicts(true))[0].resolution.entries).toEqual(
      conflicted,
    );
  } finally {
    f.repo.close();
  }
});

it("rebases every placement version in a selected writing-project reorder", async () => {
  const f = await resourceFixture();
  try {
    const first = (await f.repo.all("library_research_items"))[0],
      second = { ...first, id: crypto.randomUUID() };
    await stage(f, "library_research_items", second);
    for (const [i, item] of [first, second].entries())
      await stage(f, "library_research_placements", {
        id: item.id,
        version: 1,
        position: i + 1,
        role: "background",
        state: "active",
        section: "",
        comment: "",
      });
    await queue(
      f,
      "moveResearchItems",
      {
        items: [
          { itemId: first.id, expectedVersion: 1, position: 2 },
          { itemId: second.id, expectedVersion: 1, position: 1 },
        ],
      },
      "/api/knowledge",
    );
    await stage(f, "library_research_placements", {
      id: second.id,
      version: 2,
      position: 3,
      role: "evidence",
      state: "active",
      section: "",
      comment: "서버의 주석",
    });
    await applyReplicaResolution(f.s, await review(f), { choice: "mine" });
    expect((await pushToDownloadedState(f)).conflicts).toBe(0);
    expect(await f.s.listOutbox()).toHaveLength(0);
    expect(
      await f.repo.raw("library_research_placements", second.id),
    ).toMatchObject({ version: 3, position: 1, comment: "서버의 주석" });
  } finally {
    f.repo.close();
  }
});

it.each(["introduction", "relation"])(
  "refreshes the book preconditions of a selected %s while retaining its chosen content",
  async (kind) => {
    const f = await resourceFixture();
    try {
      const book = (await f.repo.raw("library_books", f.book))!,
        other = { ...book, id: crypto.randomUUID(), title: "다른 판본" };
      await stage(f, "library_books", other);
      const body =
        kind === "introduction"
          ? {
              bookId: f.book,
              bookVersion: 1,
              expectedVersion: 1,
              text: "내가 선택한 소개",
              sources: [],
            }
          : {
              leftId: f.book,
              rightId: other.id,
              leftVersion: 1,
              rightVersion: 1,
              expectedVersion: 0,
              relation: "different_edition",
              state: "accepted",
              reason: "내가 확인한 판본",
            };
      await queueReplicaCommand({
        storage: f.s,
        repository: f.repo,
        path:
          kind === "introduction"
            ? "/api/book-introduction"
            : "/api/book-relations",
        body: { ...body, requestId: crypto.randomUUID() },
      });
      await stage(f, "library_books", {
        ...book,
        version: 2,
        title: "서버에서 보완한 도서",
      });
      await applyReplicaResolution(f.s, await review(f), { choice: "mine" });
      const selected = (await f.s.listOutbox())[0].command as QueuedChange;
      expect(selected.body).toMatchObject(
        kind === "introduction"
          ? { bookVersion: 2, text: "내가 선택한 소개" }
          : {
              leftVersion: 2,
              rightVersion: 1,
              relation: "different_edition",
              reason: "내가 확인한 판본",
            },
      );
      expect((await pushToDownloadedState(f)).conflicts).toBe(0);
      expect(await f.s.listOutbox()).toHaveLength(0);
    } finally {
      f.repo.close();
    }
  },
);

it("keeps an existing note's earlier classification and related-record edits when its newest text is selected", async () => {
  const f = await resourceFixture();
  try {
    const original = await f.repo.raw("library_notes", f.note),
      relatedId = crypto.randomUUID();
    await stage(f, "library_notes", {
      ...original,
      id: relatedId,
      title: "연결할 메모",
    });
    await queue(f, "editNote", {
      id: f.note,
      expectedVersion: 1,
      title: "내 글",
      content: "첫 수정",
      kind: "thought",
      topicChanges: [
        { topicId: f.topic, status: "rejected", expectedVersion: 1 },
      ],
      relatedNotes: [{ noteId: relatedId }],
    });
    await queue(f, "editNote", {
      id: f.note,
      expectedVersion: 2,
      title: "내 글",
      content: "마지막 수정",
      kind: "thought",
    });
    await stage(f, "library_notes", {
      ...original,
      content: "다른 기기의 내용",
      version: 2,
    });
    await applyReplicaResolution(f.s, await review(f), { choice: "mine" });
    expect(
      (await f.repo.all("library_topic_memberships")).find(
        (m) => m.source_id === f.note && m.topic_id === f.topic,
      )?.status,
    ).toBe("rejected");
    expect(
      (await f.repo.all("library_connections")).some((c) =>
        [c.source_id, c.target_id].includes(relatedId),
      ),
    ).toBe(true);
    expect((await pushToDownloadedState(f)).conflicts).toBe(0);
    expect(await f.s.listOutbox()).toHaveLength(0);
    expect((await f.repo.note(f.note)).content).toBe("마지막 수정");
    expect((await f.s.listConflicts(true))[0].resolution.entries).toHaveLength(
      2,
    );
  } finally {
    f.repo.close();
  }
});

it("rebases a selected writing project's title and question preconditions before resending", async () => {
  const f = await resourceFixture();
  try {
    const original = await f.repo.raw("library_research", f.research);
    await queue(
      f,
      "updateResearch",
      {
        id: f.research,
        expectedTitle: original!.title,
        expectedQuestion: original!.question,
        title: "내가 선택한 제목",
        question: "내가 선택한 질문",
      },
      "/api/knowledge",
    );
    await stage(f, "library_research", {
      ...original,
      title: "다른 기기의 제목",
      question: "다른 기기의 질문",
    });
    await applyReplicaResolution(f.s, await review(f), { choice: "mine" });
    expect((await pushToDownloadedState(f)).conflicts).toBe(0);
    expect(await f.s.listOutbox()).toHaveLength(0);
    expect(await f.repo.raw("library_research", f.research)).toMatchObject({
      title: "내가 선택한 제목",
      question: "내가 선택한 질문",
    });
  } finally {
    f.repo.close();
  }
});

it("rebases a selected note's nested classification version while preserving its chosen status and text", async () => {
  const f = await resourceFixture();
  try {
    const note = await f.repo.raw("library_notes", f.note),
      membership = (await f.repo.all("library_topic_memberships")).find(
        (m) => m.source_id === f.note && m.topic_id === f.topic,
      )!;
    await queue(f, "editNote", {
      id: f.note,
      expectedVersion: 1,
      title: "선택한 제목",
      content: "선택한 내용",
      kind: "thought",
      topicChanges: [
        { topicId: f.topic, status: "rejected", expectedVersion: 1 },
      ],
    });
    await stage(f, "library_notes", {
      ...note,
      title: "다른 제목",
      version: 2,
    });
    await stage(f, "library_topic_memberships", {
      ...membership,
      status: "suggested",
      version: 2,
    });
    await applyReplicaResolution(f.s, await review(f), { choice: "mine" });
    expect((await pushToDownloadedState(f)).conflicts).toBe(0);
    expect(await f.s.listOutbox()).toHaveLength(0);
    expect((await f.repo.note(f.note)).content).toBe("선택한 내용");
    expect(
      await f.repo.raw("library_topic_memberships", membership.id),
    ).toMatchObject({ status: "rejected", version: 3 });
  } finally {
    f.repo.close();
  }
});

it("copies a reviewed contextual note under fresh note and classification identities", async () => {
  const f = await resourceFixture();
  try {
    await queue(f, "editNote", {
      id: f.note,
      expectedVersion: 1,
      title: "원래 메모 수정",
      content: "새 메모로 보관할 내용",
      kind: "thought",
      topicChanges: [
        { topicId: f.topic, status: "accepted", expectedVersion: 1 },
      ],
    });
    await applyReplicaResolution(f.s, await review(f), {
      choice: "copy",
      text: { title: "복사한 기록", content: "새 메모로 보관할 내용" },
    });
    const copiedId = (await f.s.listOutbox())[0].entityId;
    expect(copiedId).not.toBe(f.note);
    expect((await pushToDownloadedState(f)).conflicts).toBe(0);
    expect(await f.s.listOutbox()).toHaveLength(0);
    expect(await f.repo.raw("library_notes", copiedId)).toMatchObject({
      title: "복사한 기록",
      content: "새 메모로 보관할 내용",
      version: 1,
    });
    expect(
      (await f.repo.all("library_topic_memberships")).some(
        (m) =>
          m.source_id === copiedId &&
          m.topic_id === f.topic &&
          m.status === "accepted",
      ),
    ).toBe(true);
    expect((await f.repo.note(f.note)).content).toContain("정보와 신뢰");
  } finally {
    f.repo.close();
  }
});

it("rebuilds a blocked pending classification between selected note edits with the newly selected source version", async () => {
  const f = await resourceFixture();
  try {
    const original = await f.repo.raw("library_notes", f.note);
    await queue(f, "editNote", {
      id: f.note,
      expectedVersion: 1,
      title: "내 글",
      content: "첫 선택",
      kind: "thought",
    });
    await queue(
      f,
      "assignTopic",
      {
        topicId: f.topic,
        sourceKind: "note",
        sourceId: f.note,
        sourceVersion: "2",
        status: "rejected",
        expectedVersion: 1,
      },
      "/api/thought-map",
    );
    await queue(f, "editNote", {
      id: f.note,
      expectedVersion: 2,
      title: "내 글",
      content: "최종 선택",
      kind: "thought",
    });
    await stage(f, "library_notes", {
      ...original,
      version: 2,
      content: "서버에서 고친 내용",
    });
    await applyReplicaResolution(f.s, await review(f), { choice: "mine" });
    const pending = await f.s.listOutbox(),
      classification = pending.find(
        (e) => (e.command as QueuedChange).body.type === "assignTopic",
      )!;
    expect((classification.command as QueuedChange).body.payload).toMatchObject(
      { sourceVersion: "3", status: "rejected" },
    );
    expect((await pushToDownloadedState(f)).conflicts).toBe(0);
    expect(await f.s.listOutbox()).toHaveLength(0);
    expect((await f.repo.note(f.note)).content).toBe("최종 선택");
    const archive = (await f.s.listConflicts(true))[0];
    expect(archive.resolution.entries).toHaveLength(2);
    expect(archive.resolution.dependentEntries).toHaveLength(1);
  } finally {
    f.repo.close();
  }
});
