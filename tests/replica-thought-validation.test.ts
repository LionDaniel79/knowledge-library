import { expect, it } from "vitest";
import { resourceFixture } from "./helpers/replica-resources";
import { prepareOptimistic } from "../src/client/replica/optimistic";
import { syncKey, type SyncEntity } from "../src/lib/replica/entities";
import { sha256Bytes } from "../src/lib/replica/codec";
async function fixture(confirmed: boolean, status: string) {
  const f = await resourceFixture();
  const original = (await f.repo.raw("library_notes", f.note))!;
  const after = {
    ...original,
    id: crypto.randomUUID(),
    content: "신뢰는 정보를 공유하며 생긴다",
    created_at: "2026-10-18T00:00:00Z",
  };
  const membership = (await f.repo.all("library_topic_memberships"))[0];
  const rows: [SyncEntity, any][] = [
    ["library_notes", after],
    [
      "library_topics",
      { ...(await f.repo.raw("library_topics", f.topic)), confirmed },
    ],
    ...[original, after].map(
      (n, i) =>
        [
          "library_topic_memberships",
          {
            ...membership,
            id: i ? crypto.randomUUID() : membership.id,
            source_id: n.id,
            source_version: "1",
            status,
          },
        ] as [SyncEntity, any],
    ),
  ];
  const cp = (await f.s.checkpoint())!;
  for (const [entity, value] of rows) {
    const inline = JSON.stringify(value),
      bytes = new TextEncoder().encode(inline);
    await f.s.stageRows(cp.generation, [
      {
        entity,
        key: syncKey(entity, value),
        revision: "2",
        deleted: false,
        inline,
        bytes: bytes.length,
        sha256: await sha256Bytes(bytes),
      },
    ]);
  }
  const body = {
    requestId: crypto.randomUUID(),
    type: "connectThoughts",
    payload: {
      beforeId: f.note,
      afterId: after.id,
      topicId: f.topic,
      relation: "expands",
      explanation: "직접 확인한 입장의 확장",
    },
  };
  return { ...f, body };
}
for (const [confirmed, status] of [
  [false, "accepted"],
  [true, "suggested"],
] as const)
  it(`does not report a locally saved change for unverified classification ${confirmed}/${status}`, async () => {
    const f = await fixture(confirmed, status);
    try {
      await expect(
        prepareOptimistic(
          f.repo,
          "/api/thought-map",
          f.body,
          "2026-10-21T00:00:00Z",
        ),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      f.repo.close();
    }
  });
it("accepts a manually reviewed connection in a confirmed topic with current accepted memberships", async () => {
  const f = await fixture(true, "accepted");
  try {
    const command = await prepareOptimistic(
      f.repo,
      "/api/thought-map",
      f.body,
      "2026-10-21T00:00:00Z",
    );
    expect(
      command.effects.find((e) => e.entity === "library_evolution_candidates")
        ?.after?.status,
    ).toBe("accepted");
  } finally {
    f.repo.close();
  }
});
