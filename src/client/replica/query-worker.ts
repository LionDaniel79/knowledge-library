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
    closed = false,
    initialization: Promise<void> | undefined;
  const pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      fallback: () => any;
    }
  >();
  function fallback() {
    worker?.terminate();
    worker = undefined;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      try {
        p.resolve(p.fallback());
      } catch (e) {
        p.reject(e as Error);
      }
    }
    pending.clear();
  }
  function start() {
    if (typeof Worker === "undefined") return;
    try {
      worker = new Worker(new URL("./search-worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (e) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        clearTimeout(p.timer);
        if (e.data.error)
          p.reject(new ReplicaQueryError(e.data.status ?? 400, e.data.error));
        else p.resolve(e.data.result);
      };
      worker.onerror = fallback;
      worker.onmessageerror = fallback;
    } catch {
      fallback();
    }
  }
  function send(
    message: Record<string, unknown>,
    local: () => any,
  ): Promise<any> {
    if (closed) return Promise.reject(Error("검색 창을 다시 열어 주세요."));
    return new Promise((resolve, reject) => {
      const key = ++id;
      pending.set(key, {
        resolve,
        reject,
        fallback: local,
        timer: setTimeout(fallback, 2500),
      });
      try {
        worker!.postMessage({ ...message, id: key });
      } catch {
        fallback();
      }
    });
  }
  return {
    async initialize(next: LocalIndex) {
      if (closed) throw Error("검색 창을 다시 열어 주세요.");
      if (data === next) return initialization;
      const first = !data;
      data = next;
      if (first) start();
      initialization = worker
        ? send({ type: "init", owner, data }, () => undefined)
        : Promise.resolve();
      await initialization;
    },
    async query(kind: QueryKind, input: unknown) {
      return worker
        ? send({ type: "query", kind, input }, () =>
            runLocalQuery(data, owner, kind, input),
          )
        : runLocalQuery(data, owner, kind, input);
    },
    close() {
      closed = true;
      worker?.terminate();
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(Error("검색이 종료되었습니다."));
      }
      pending.clear();
    },
  };
}
