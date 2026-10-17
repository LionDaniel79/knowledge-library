import type { ReplicaStorage } from "./storage";
import { resolveReplicaImage } from "./values";
const urls = new Map<string, { refs: number; url: Promise<string> }>();
export async function acquireReplicaImage(
  storage: ReplicaStorage,
  assetId: string,
) {
  const cp = await storage.checkpoint();
  if (!cp?.complete) throw Error("기기 표지가 준비되지 않았습니다.");
  const row = await storage.readRow(
    "library_cover_assets",
    JSON.stringify([assetId]),
    cp.generation,
  );
  if (!row || row.deleted) throw Error("저장된 표지를 찾을 수 없습니다.");
  const key = JSON.stringify([
    storage.owner,
    cp.generation,
    assetId,
    row.sha256,
  ]);
  let entry = urls.get(key);
  if (!entry) {
    entry = {
      refs: 0,
      url: resolveReplicaImage(storage, assetId, cp.generation).then((blob) =>
        URL.createObjectURL(blob),
      ),
    };
    urls.set(key, entry);
  }
  entry.refs++;
  let url: string;
  try {
    url = await entry.url;
  } catch (error) {
    urls.delete(key);
    throw error;
  }
  let released = false;
  return {
    url,
    release() {
      if (released) return;
      released = true;
      if (--entry!.refs === 0) {
        urls.delete(key);
        URL.revokeObjectURL(url);
      }
    },
  };
}
