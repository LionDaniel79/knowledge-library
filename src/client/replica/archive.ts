import type { ReplicaStorage } from "./storage";
import { syncEntities, type SyncEntity } from "../../lib/replica/entities";
import { readReplicaValue } from "./values";
export async function createReplicaArchive(
  storage: ReplicaStorage,
): Promise<Blob> {
  const cp = await storage.checkpoint();
  if (!cp?.complete) throw Error("기기 저장을 먼저 완료해 주세요.");
  const chunks: BlobPart[] = [],
    batch: BlobPart[] = [];
  let size = 0;
  const append = (value: BlobPart, bytes: number) => {
    batch.push(value);
    size += bytes;
    if (size > 512 * 1024) {
      chunks.push(new Blob(batch));
      batch.length = 0;
      size = 0;
    }
  };
  const text = (s: string) => append(s, s.length * 2);
  text(
    JSON.stringify({
      format: "knowledge-library-device-export-v1",
      createdAt: new Date().toISOString(),
      owner: storage.owner,
      checkpoint: cp,
    }).slice(0, -1) + ',"tables":{',
  );
  let firstTable = true;
  for (const entity of Object.keys(syncEntities) as SyncEntity[]) {
    text((firstTable ? "" : ",") + JSON.stringify(entity) + ":[");
    firstTable = false;
    let first = true,
      after: string | undefined;
    while (true) {
      const page = await storage.readPage(entity, {
        generation: cp.generation,
        after,
        limit: 200,
      });
      for (const row of page.rows) {
        if (row.deleted) continue;
        if (!first) text(",");
        first = false;
        append(
          row.inline !== undefined
            ? row.inline
            : (await readReplicaValue(storage, row, cp.generation)).slice()
                .buffer,
          row.bytes,
        );
      }
      after = page.after;
      if (!page.hasMore) break;
    }
    text("]");
  }
  text(
    '},"outbox":' +
      JSON.stringify(await storage.listOutbox()) +
      ',"conflicts":' +
      JSON.stringify(await storage.listConflicts(true)) +
      "}",
  );
  const latest = await storage.checkpoint();
  if (
    latest?.generation !== cp.generation ||
    latest.cursor !== cp.cursor ||
    latest.localRevision !== cp.localRevision
  )
    throw Error("자료가 변경되었습니다. 동기화가 끝난 뒤 다시 내려받으세요.");
  if (batch.length) chunks.push(new Blob(batch));
  return new Blob(chunks, { type: "application/json" });
}
