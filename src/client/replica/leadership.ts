import { ReplicaLeaseLost, type ReplicaStorage } from "./storage";
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Stopped", "AbortError"));
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
export async function withReplicaLeader<T>(
  owner: string,
  fn: (leader: { storage: ReplicaStorage; signal: AbortSignal }) => Promise<T>,
  options: {
    storage: ReplicaStorage;
    signal?: AbortSignal;
    locks?: LockManager | null;
    leaseMs?: number;
  },
) {
  if (owner !== options.storage.owner) throw Error("서재 계정이 다릅니다.");
  const controller = new AbortController(),
    forward = () => controller.abort(options.signal?.reason),
    ttl = options.leaseMs ?? 15000;
  options.signal?.addEventListener("abort", forward, { once: true });
  if (options.signal?.aborted) forward();
  async function run() {
    let lease = null;
    while (!lease) {
      controller.signal.throwIfAborted();
      lease = await options.storage.claimLease(crypto.randomUUID(), ttl);
      if (!lease) await delay(100, controller.signal);
    }
    const initial = lease,
      fenced = options.storage.withLease(initial);
    let renewing = false;
    const timer = setInterval(
      () => {
        if (renewing) return;
        renewing = true;
        void options.storage
          .renewLease(initial, ttl)
          .then((value) => {
            if (!value) controller.abort(new ReplicaLeaseLost());
          })
          .catch((e) => controller.abort(e))
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(50, Math.min(3000, Math.floor(ttl / 3))),
    );
    try {
      const result = await fn({ storage: fenced, signal: controller.signal });
      controller.signal.throwIfAborted();
      await fenced.assertWriteLease();
      return result;
    } finally {
      clearInterval(timer);
      await options.storage.releaseLease(initial).catch(() => {});
    }
  }
  try {
    const locks =
      options.locks === undefined
        ? typeof navigator !== "undefined"
          ? navigator.locks
          : undefined
        : options.locks;
    return locks
      ? await locks.request(
          "knowledge-library-sync:" + owner,
          // A backgrounded phone tab can retain a Web Lock indefinitely.
          // The expiring, fenced database lease remains authoritative even
          // when that optional advisory lock is unavailable.
          { mode: "exclusive", ifAvailable: true },
          run,
        )
      : await run();
  } finally {
    options.signal?.removeEventListener("abort", forward);
  }
}
