import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createCurationStore } from "../src/server/curation-store";
it("exports auxiliary material separately with dates and without another owner's records", async () => {
  const { pg, db } = await testDatabase();
  try {
    const library = createLibraryStore(db),
      curation = createCurationStore(db);
    const n = await library.mutate("a", {
      requestId: randomUUID(),
      type: "addNote",
      payload: { title: "기록", content: "정서 수용", kind: "thought" },
    });
    const run = await curation.begin("a", "scope", "codex");
    await curation.begin("b", "hidden-other-scope", "codex");
    await curation.apply("a", run, [
      {
        id: randomUUID(),
        source: { kind: "note", id: n.id!, version: "1" },
        kind: "tag",
        proposedValue: "감정",
        evidence: { quote: "정서 수용" },
        coverage: "partial",
        origin: "codex",
        generator: "pilot",
      },
    ]);
    const out = await library.exportLibrary("a");
    expect(out.schemaVersion).toBe(7);
    expect((out as any).curation.items).toHaveLength(1);
    expect((out as any).curation.runs[0].created_at).toEqual(
      expect.stringMatching(/^20\d\d-/),
    );
    expect(out.library.notes).toHaveLength(1);
    expect(out.library.notes[0].tags).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("hidden-other-scope");
  } finally {
    await pg.close();
  }
});
