import { Sha256Stream, sha256Bytes } from "../../lib/replica/codec";
import {
  MAX_PARALLEL_DOWNLOADS,
  type SyncRow,
} from "../../lib/replica/contracts";
import type { ReplicaStorage } from "./storage";
import type { SyncTransport } from "./transport";
export function checkSyncAbort(signal?: AbortSignal) {
  signal?.throwIfAborted();
}
export async function ensureReplicaValue(
  storage: ReplicaStorage,
  generation: string,
  row: SyncRow,
  transport?: SyncTransport,
  signal?: AbortSignal,
) {
  checkSyncAbort(signal);
  if (row.deleted) return;
  if (row.inline !== undefined) {
    const bytes = new TextEncoder().encode(row.inline);
    if (bytes.length !== row.bytes || (await sha256Bytes(bytes)) !== row.sha256)
      throw Error("자료 내용 검증에 실패했습니다.");
    return;
  }
  let next = 0,
    failure: unknown;
  const worker = async () => {
    while (next < row.parts!.length && !failure) {
      const part = row.parts![next++];
      try {
        checkSyncAbort(signal);
        let bytes = await storage.readValuePart(generation, row, part.index);
        if (
          bytes &&
          (bytes.length !== part.bytes ||
            (await sha256Bytes(bytes)) !== part.sha256)
        )
          bytes = undefined;
        if (!bytes) {
          if (!transport) throw Error("저장된 자료 조각이 누락됐습니다.");
          bytes = await transport.value(row, part.index, signal);
          if (
            bytes.length !== part.bytes ||
            (await sha256Bytes(bytes)) !== part.sha256
          )
            throw Error("자료 조각 검증에 실패했습니다.");
          await storage.putValuePart(generation, row, part.index, bytes);
        }
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: MAX_PARALLEL_DOWNLOADS }, () => worker()),
  );
  if (failure) throw failure;
  const digest = new Sha256Stream();
  let size = 0;
  for (const part of row.parts!) {
    checkSyncAbort(signal);
    const bytes = await storage.readValuePart(generation, row, part.index);
    if (!bytes) throw Error("저장된 자료 조각이 누락됐습니다.");
    digest.update(bytes);
    size += bytes.length;
  }
  if (size !== row.bytes || digest.hex() !== row.sha256)
    throw Error("전체 자료 검증에 실패했습니다.");
}
export async function readReplicaValue(
  storage: ReplicaStorage,
  row: SyncRow,
  generation?: string,
): Promise<Uint8Array> {
  if (row.deleted) throw Error("삭제된 자료입니다.");
  if (row.inline !== undefined) return new TextEncoder().encode(row.inline);
  const id = generation ?? (await storage.checkpoint())?.generation;
  if (!id) throw Error("기기 자료가 준비되지 않았습니다.");
  const bytes = new Uint8Array(row.bytes);
  let offset = 0;
  for (const part of row.parts!) {
    const chunk = await storage.readValuePart(id, row, part.index);
    if (!chunk) throw Error("자료가 아직 내려받아지지 않았습니다.");
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function resolveReplicaImage(
  storage: ReplicaStorage,
  assetId: string,
  generation?: string,
): Promise<Blob> {
  const row = await storage.readRow(
    "library_cover_assets",
    JSON.stringify([assetId]),
    generation,
  );
  if (!row || row.deleted) throw Error("저장된 표지가 없습니다.");
  const image = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await readReplicaValue(storage, row, generation),
    ),
  );
  if (image.mime !== "image/webp" || typeof image.data_base64 !== "string")
    throw Error("표지 형식이 잘못되었습니다.");
  const decoded = atob(image.data_base64),
    bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: image.mime });
}
