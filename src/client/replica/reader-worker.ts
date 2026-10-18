import { openReplica } from "./indexed-db";
import {
  createLocalReplicaRepository,
  UnsupportedLocalRoute,
  type LocalReplicaRepository,
} from "./repository-local";
const methods = new Set([
  "books",
  "notes",
  "reading",
  "calendar",
  "search",
  "book",
  "note",
  "overview",
  "history",
  "read",
]);
let repository: LocalReplicaRepository | undefined;
self.onmessage = async (event: MessageEvent) => {
  const m = event.data;
  try {
    if (m.type === "open") {
      if (
        repository ||
        typeof m.owner !== "string" ||
        !m.owner ||
        m.owner.length > 128 ||
        typeof m.database !== "string" ||
        m.database.length > 200
      )
        throw Error("기기 저장소를 확인해 주세요.");
      repository = createLocalReplicaRepository(
        await openReplica(m.owner, { name: m.database }),
        true,
      );
      self.postMessage({ type: "ready", owner: m.owner });
    } else if (m.type === "invalidate") repository?.invalidate();
    else if (m.type === "read") {
      if (
        !repository ||
        !methods.has(m.method) ||
        !Array.isArray(m.args) ||
        m.args.length > 8
      )
        throw Error("허용하지 않은 기기 조회입니다.");
      const result = await (
        repository[m.method as keyof LocalReplicaRepository] as (
          ...args: any[]
        ) => any
      )(...m.args);
      self.postMessage({ id: m.id, result });
    }
  } catch (error) {
    self.postMessage({
      id: m.id,
      error:
        error instanceof Error
          ? error.message
          : "기기 자료를 불러오지 못했습니다.",
      status: (error as { status?: number })?.status ?? 400,
      unsupported: error instanceof UnsupportedLocalRoute,
    });
  }
};
