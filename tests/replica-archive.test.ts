import { expect, it } from "vitest";
import { resourceFixture } from "./helpers/replica-resources";
import { createReplicaArchive } from "../src/client/replica/archive";
import { sha256Bytes } from "../src/lib/replica/codec";
it("exports exact serialized values without rounding large integers or losing pending originals", async () => {
  const f = await resourceFixture(),
    cp = (await f.s.checkpoint())!;
  const inline =
    '{"id":"exact","original_data":{"integer":9007199254740993123,"decimal":0.1234567890123456789012345,"text":"내 원문"}}';
  await f.s.stageRows(cp.generation, [
    {
      entity: "library_imports",
      key: '["exact"]',
      revision: "1",
      deleted: false,
      inline,
      bytes: Buffer.byteLength(inline),
      sha256: await sha256Bytes(new TextEncoder().encode(inline)),
    },
  ]);
  const blob = await createReplicaArchive(f.s),
    text = await blob.text();
  expect(text).toContain(inline);
  expect(JSON.parse(text).format).toBe("knowledge-library-device-export-v1");
  expect(JSON.parse(text).tables.library_imports).toHaveLength(1);
});
