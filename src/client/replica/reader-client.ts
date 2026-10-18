import { ReplicaQueryError } from "./queries";
import { UnsupportedLocalRoute } from "./repository-local";
export const readerMethods = [
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
] as const;
export function createReplicaReader(
  owner: string,
  database: string,
  factory = () =>
    new Worker(new URL("./reader-worker.ts", import.meta.url), {
      type: "module",
    }),
) {
  let worker: Worker | undefined,
    boot: Promise<boolean> | undefined,
    finishBoot: ((ready: boolean) => void) | undefined,
    bootTimer: ReturnType<typeof setTimeout> | undefined,
    disabled = false,
    closed = false,
    sequence = 0;
  const pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      fallback: () => Promise<any>;
    }
  >();
  function runFallback(
    id: number,
    p: NonNullable<ReturnType<typeof pending.get>>,
  ) {
    Promise.resolve()
      .then(() => {
        if (closed)
          throw new DOMException("서재 조회가 종료되었습니다.", "AbortError");
        return p.fallback();
      })
      .then(
        (value) => {
          if (!pending.delete(id)) return;
          clearTimeout(p.timer);
          if (closed)
            p.reject(
              new DOMException("서재 조회가 종료되었습니다.", "AbortError"),
            );
          else p.resolve(value);
        },
        (error) => {
          if (pending.delete(id)) {
            clearTimeout(p.timer);
            p.reject(error);
          }
        },
      );
  }
  function unavailable() {
    if (disabled) return;
    disabled = true;
    worker?.terminate();
    worker = undefined;
    clearTimeout(bootTimer);
    finishBoot?.(false);
    for (const [id, p] of pending) runFallback(id, p);
  }
  function start() {
    return (boot ??= new Promise<boolean>((resolve) => {
      finishBoot = resolve;
      bootTimer = setTimeout(unavailable, 2500);
      try {
        worker = factory();
        worker.onmessage = (event) => {
          const m = event.data;
          if (m.type === "ready") {
            if (m.owner !== owner) {
              unavailable();
              return;
            }
            clearTimeout(bootTimer);
            resolve(true);
            return;
          }
          const p = pending.get(m.id);
          if (!p) return;
          pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.error)
            p.reject(
              m.unsupported
                ? new UnsupportedLocalRoute(m.error)
                : new ReplicaQueryError(m.status ?? 400, m.error),
            );
          else p.resolve(m.result);
        };
        worker.onerror = unavailable;
        worker.onmessageerror = unavailable;
        worker.postMessage({ type: "open", owner, database });
      } catch {
        unavailable();
      }
    }));
  }
  return {
    async read(method: string, args: any[], fallback: () => Promise<any>) {
      if (closed)
        throw new DOMException("서재 조회가 종료되었습니다.", "AbortError");
      if (!disabled) await start();
      if (closed)
        throw new DOMException("서재 조회가 종료되었습니다.", "AbortError");
      return new Promise<any>((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, {
          resolve,
          reject,
          fallback,
          timer: setTimeout(() => {
            pending.delete(id);
            reject(
              new ReplicaQueryError(
                503,
                "기기 자료를 정리하고 있습니다. 잠시 후 다시 시도해 주세요.",
              ),
            );
          }, 60000),
        });
        if (disabled || !worker) {
          runFallback(id, pending.get(id)!);
          return;
        }
        try {
          worker!.postMessage({ type: "read", id, method, args });
        } catch {
          unavailable();
        }
      });
    },
    invalidate() {
      if (worker && !closed) worker.postMessage({ type: "invalidate" });
    },
    close() {
      closed = true;
      clearTimeout(bootTimer);
      finishBoot?.(false);
      worker?.terminate();
      worker = undefined;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new DOMException("서재 조회가 종료되었습니다.", "AbortError"));
      }
      pending.clear();
    },
  };
}
