import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { readThoughtBoxes } from "../src/server/thought-boxes";
import { createKnowledgeStore } from "../src/server/knowledge-store";
import { addThoughtBox } from "../src/lib/thought-boxes";
import { emptyBoard } from "../src/lib/whiteboard";
import { resourceFixture } from "./helpers/replica-resources";
import { queueReplicaCommand } from "../src/client/replica/outbox";
const command = (type: string, payload: unknown) => ({
  requestId: randomUUID(),
  type,
  payload,
});
it("returns only owned small box summaries and supports the same inventory and edit offline", async () => {
  const f = await testDatabase();
  try {
    const owner = randomUUID(),
      store = createKnowledgeStore(f.db),
      box = randomUUID();
    await store.mutate(
      owner,
      command("saveWhiteboard", {
        expectedVersion: 0,
        data: addThoughtBox(emptyBoard(), box, "나의 상자"),
      }),
    );
    await store.mutate(
      "other",
      command("saveWhiteboard", {
        expectedVersion: 0,
        data: addThoughtBox(emptyBoard(), randomUUID(), "다른 사람"),
      }),
    );
    const rows = await readThoughtBoxes(f.db, owner);
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0].title).toBe("나의 상자");
    expect(rows.items[0]).not.toHaveProperty("items");
    expect(rows.items[0]).not.toHaveProperty("text");
    await expect(readThoughtBoxes(f.db, "")).rejects.toMatchObject({
      status: 401,
    });
    const local = await resourceFixture();
    const data = addThoughtBox(emptyBoard(), randomUUID(), "기기 상자");
    await queueReplicaCommand({
      storage: local.s,
      repository: local.repo,
      path: "/api/knowledge",
      body: command("saveWhiteboard", { expectedVersion: 0, data }),
    });
    expect(
      ((await local.repo.read("/api/thought-boxes")) as any).items[0].title,
    ).toBe("기기 상자");
    local.repo.close();
  } finally {
    await f.pg.close();
  }
});
