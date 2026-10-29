import { expect, it } from "vitest";
import { resourceFixture } from "./helpers/replica-resources";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import {
  applyReplicaResolution,
  loadReplicaConflict,
} from "../src/client/replica/conflicts";
import { emptyBoard } from "../src/lib/whiteboard";
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
      revision: "2",
      deleted: false,
      inline,
      bytes: bytes.length,
      sha256: await sha256Bytes(bytes),
    },
  ]);
  f.repo.invalidate();
}
const queue = (f: Fixture, type: string, payload: any) =>
  queueReplicaCommand({
    storage: f.s,
    repository: f.repo,
    path: "/api/knowledge",
    body: { requestId: crypto.randomUUID(), type, payload },
  });
it("retains a dependent deletion when a conflicting save of the same project board is reviewed", async () => {
  const f = await resourceFixture();
  try {
    const project = (await f.repo.raw("library_research", f.research))!;
    await queue(f, "saveWhiteboard", {
      boardId: project.id,
      expectedVersion: 0,
      data: emptyBoard(),
    });
    await queue(f, "deleteResearch", {
      id: project.id,
      expectedTitle: project.title,
      expectedQuestion: project.question,
      expectedBoardVersion: 1,
    });
    const original = (await f.s.listOutbox())[0];
    await f.s.putOutbox({ ...original, state: "conflict" });
    await stage(f, "library_whiteboards", {
      id: project.id,
      version: 1,
      data: {
        ...emptyBoard(),
        filter: { ...emptyBoard().filter, q: "다른 기기의 배치" },
      },
    });
    const review = await loadReplicaConflict(f.s, original.requestId);
    await applyReplicaResolution(f.s, review, { choice: "mine" });
    const types = (await f.s.listOutbox()).map(
      (e) => (e.command as any).body.type,
    );
    expect(types).toContain("deleteResearch");
    expect(await f.repo.raw("library_research", project.id)).toBeUndefined();
  } finally {
    f.repo.close();
    await f.s.close();
  }
});
it("reviews a deletion against its project rather than a removed child and rebases the confirmed board version", async () => {
  const f = await resourceFixture();
  try {
    const project = (await f.repo.raw("library_research", f.research))!;
    await stage(f, "library_research_items", {
      id: crypto.randomUUID(),
      research_id: project.id,
      note_id: f.note,
      snapshot: { note: { title: "별도 사본" } },
      created_at: "2026-10-29",
    });
    await queue(f, "deleteResearch", {
      id: project.id,
      expectedTitle: project.title,
      expectedQuestion: project.question,
      expectedBoardVersion: 0,
    });
    const entry = (await f.s.listOutbox())[0];
    await f.s.putOutbox({ ...entry, state: "conflict" });
    await stage(f, "library_research", {
      ...project,
      title: "수정된 최신 제목",
    });
    await stage(f, "library_whiteboards", {
      id: project.id,
      version: 2,
      data: emptyBoard(),
    });
    const review = await loadReplicaConflict(f.s, entry.requestId);
    expect(review.primary?.entity).toBe("library_research");
    await applyReplicaResolution(f.s, review, { choice: "mine" });
    const body = (await f.s.listOutbox())[0].command as any;
    expect(body.body.type).toBe("deleteResearch");
    expect(body.body.payload).toMatchObject({
      expectedTitle: "수정된 최신 제목",
      expectedBoardVersion: 2,
    });
  } finally {
    f.repo.close();
    await f.s.close();
  }
});
