import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { prepareOptimistic } from "../src/client/replica/optimistic";
import type { ReplicaRepository } from "../src/client/replica/repository";
it("keeps research metadata free of invented version fields and compares the displayed base", async () => {
  const id = randomUUID(),
    row = { id, title: "Before", question: "Q", kind: "thesis" };
  const repo = {
    raw: async (e: string, key: string) =>
      e === "library_research" && key === id ? row : undefined,
  } as ReplicaRepository;
  const p = {
    id,
    title: "After",
    question: "Outline",
    expectedTitle: "Before",
    expectedQuestion: "Q",
  };
  const result = await prepareOptimistic(
    repo,
    "/api/knowledge",
    { requestId: randomUUID(), type: "updateResearch", payload: p },
    "2026-10-25T00:00:00Z",
  );
  const changed = result.effects.find(
    (e) => e.entity === "library_research",
  )!.after!;
  expect(changed.title).toBe("After");
  expect(changed).not.toHaveProperty("version");
  expect(result.entityId).toBe(id);
  await expect(
    prepareOptimistic(
      repo,
      "/api/knowledge",
      {
        requestId: randomUUID(),
        type: "updateResearch",
        payload: { ...p, expectedTitle: "Stale" },
      },
      "now",
    ),
  ).rejects.toMatchObject({ status: 409 });
});
it("normalizes legacy unplaced notes together and preserves each existing section and interpretation", async () => {
  const research = randomUUID(),
    ids: string[] = Array.from({ length: 3 }, () => randomUUID()),
    requestId = randomUUID();
  const old = {
    id: ids[0],
    role: "claim",
    section: "First",
    position: 8,
    comment: "My interpretation",
    state: "active",
    version: 2,
  };
  const repo = {
    raw: async (e: string, key: string) =>
      e === "library_research_items" && ids.includes(key)
        ? { id: key, research_id: research }
        : e === "library_research_placements" && key === ids[0]
          ? old
          : undefined,
  } as ReplicaRepository;
  const result = await prepareOptimistic(
    repo,
    "/api/knowledge",
    {
      requestId,
      type: "moveResearchItems",
      payload: {
        items: [ids[2], ids[0], ids[1]].map((itemId, i) => ({
          itemId,
          position: i + 1,
          expectedVersion: itemId === ids[0] ? 2 : 0,
        })),
      },
    },
    "now",
  );
  const effects = result.effects.filter(
    (e) => e.entity === "library_research_placements",
  );
  expect(effects.map((e) => e.after?.position)).toEqual([1, 2, 3]);
  expect(effects.find((e) => e.after?.id === ids[0])?.after).toMatchObject({
    section: "First",
    comment: "My interpretation",
    version: 3,
  });
  expect(
    result.effects.filter((e) => e.entity === "library_revisions"),
  ).toHaveLength(3);
});
