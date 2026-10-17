import {
  runLocalQuery,
  ReplicaQueryError,
  type LocalIndex,
  type QueryKind,
} from "./queries";
export function createQueryWorker(owner: string) {
  let data: LocalIndex,
    worker: Worker | undefined,
    id = 0,
    closed = false;
  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  if (typeof Worker !== "undefined") {
    worker = new Worker(new URL("./search-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error)
        p.reject(new ReplicaQueryError(e.data.status ?? 400, e.data.error));
      else p.resolve(e.data.result);
    };
    worker.onerror = () => {
      for (const p of pending.values())
        p.reject(Error("기기 검색을 다시 시작해 주세요."));
      pending.clear();
    };
  }
  function send(message: Record<string, unknown>): Promise<any> {
    if (closed) return Promise.reject(Error("검색 창을 다시 열어 주세요."));
    return new Promise((resolve, reject) => {
      const key = ++id;
      pending.set(key, { resolve, reject });
      worker!.postMessage({ ...message, id: key });
    });
  }
  return {
    async initialize(next: LocalIndex) {
      data = next;
      if (worker) await send({ type: "init", owner, data });
    },
    async query(kind: QueryKind, input: unknown) {
      return worker
        ? send({ type: "query", kind, input })
        : runLocalQuery(data, owner, kind, input);
    },
    close() {
      closed = true;
      worker?.terminate();
      for (const p of pending.values())
        p.reject(Error("검색이 종료되었습니다."));
      pending.clear();
    },
  };
}
