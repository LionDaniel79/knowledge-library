import { expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import { createThoughtMapStore } from "../src/server/thought-map-store";
import { createAssistStore } from "../src/server/assist-store";
it("removes and restores a topic without deleting memo memberships or its change history", async () => {
  const f = await testDatabase();
  try {
    const store = createThoughtMapStore(f.db),
      owner = "archive-owner";
    const topic: any = await store.mutate(owner, {
      requestId: crypto.randomUUID(),
      type: "upsertTopic",
      payload: {
        name: "독서",
        description: "기억",
        parentId: null,
        aliases: [],
        kdcCodes: [],
      },
    });
    await store.mutate(owner, {
      requestId: crypto.randomUUID(),
      type: "deleteTopic",
      payload: { id: topic.id, expectedVersion: 1 },
    });
    const state = await store.snapshot(owner);
    expect(state.topics).toHaveLength(0);
    expect(state.archivedTopics?.[0].id).toBe(topic.id);
    await store.mutate(owner, {
      requestId: crypto.randomUUID(),
      type: "restoreTopic",
      payload: { id: topic.id, expectedVersion: 2 },
    });
    expect((await store.snapshot(owner)).topics[0].version).toBe(3);
  } finally {
    await f.pg.close();
  }
});
it("hides an AI request while retaining the paid request and result accounting", async () => {
  const f = await testDatabase();
  try {
    const owner = "hide-owner",
      id = crypto.randomUUID();
    await f.db.query(
      "INSERT INTO library_assist_requests(id,owner_id,request_id,fingerprint,purpose,task,policy_version,status) VALUES($1,$2,$3,'fingerprint','tag_suggestion','{}',1,'failed')",
      [id, owner, crypto.randomUUID()],
    );
    const store = createAssistStore(f.db);
    await store.hide(owner, id);
    expect((await store.status(owner)).requests).toHaveLength(0);
    expect(
      (
        await f.db.query(
          "SELECT status FROM library_assist_requests WHERE id=$1",
          [id],
        )
      ).rows[0].status,
    ).toBe("failed");
  } finally {
    await f.pg.close();
  }
});
