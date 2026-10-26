import { it, expect } from "vitest";
import { resourceFixture } from "./helpers/replica-resources";
import { testDatabase } from "./helpers/database";
import { listSearchTopics } from "../src/server/library-search-context";
it("includes the displayed topic version in both lightweight online and device choices", async () => {
  const f = await resourceFixture(),
    db = await testDatabase();
  try {
    await db.db.query(
      "INSERT INTO library_topics(id,owner_id,name,parent_id,aliases,description,kdc_codes,version) VALUES($1,$2,'관계',NULL,'[]','', '[]',7)",
      [f.topic, f.s.owner],
    );
    expect((await listSearchTopics(db.db, f.s.owner))[0]).toMatchObject({
      id: f.topic,
      version: 7,
    });
    const choices = (await f.repo.read("/api/library-search/topics")) as {
      topics: { id: string; version: number }[];
    };
    expect(choices.topics.find((t) => t.id === f.topic)).toMatchObject({
      version: 1,
    });
    const cp = (await f.s.checkpoint())!;
    expect(
      await f.s.readIndex("query-index-v1", cp.generation),
    ).toBeUndefined();
  } finally {
    f.repo.close();
    await db.pg.close();
  }
});
