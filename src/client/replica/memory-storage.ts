import {
  createReplicaStorage,
  type ReplicaBackend,
  type ReplicaIO,
  type ReplicaKey,
  type ReplicaStore,
  type StoredEntry,
} from "./storage";
export function createMemoryBackend(): ReplicaBackend {
  let data = new Map<string, StoredEntry>(),
    tail = Promise.resolve();
  const key = (store: ReplicaStore, id: ReplicaKey) =>
    JSON.stringify([store, id]);
  const clone = <T>(v: T) => (v === undefined ? v : structuredClone(v));
  return {
    async get(store, id) {
      await tail;
      return clone(data.get(key(store, id))?.data);
    },
    async scan(store, prefix, after, limit = Number.MAX_SAFE_INTEGER) {
      await tail;
      const compare = (a: ReplicaKey, b: ReplicaKey) => {
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] === b[i]) continue;
          if (a[i] === undefined) return -1;
          if (b[i] === undefined) return 1;
          return a[i] < b[i] ? -1 : 1;
        }
        return 0;
      };
      return [...data.entries()]
        .filter(
          ([k, e]) =>
            JSON.parse(k)[0] === store &&
            prefix.every((v, i) => e.id[i] === v) &&
            (!after || compare(e.id, after) > 0),
        )
        .map(([, e]) => clone(e))
        .sort((a, b) => compare(a.id, b.id))
        .slice(0, limit);
    },
    transaction(fn) {
      const run = tail.then(async () => {
        const next = new Map(data);
        const io: ReplicaIO = {
          get: async (s, id) => clone(next.get(key(s, id))?.data),
          put: async (s, id, value) => {
            next.set(key(s, id), { id: clone(id), data: clone(value) });
          },
          delete: async (s, id) => {
            next.delete(key(s, id));
          },
        };
        await fn(io);
        data = next;
      });
      tail = run.catch(() => {});
      return run;
    },
    close() {},
  };
}
export function createMemoryReplica(
  owner: string,
  backend = createMemoryBackend(),
) {
  return createReplicaStorage(owner, backend);
}
