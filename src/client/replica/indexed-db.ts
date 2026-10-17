import {
  createReplicaStorage,
  replicaStores,
  type ReplicaBackend,
  type ReplicaIO,
  type ReplicaKey,
  type ReplicaStore,
  type StoredEntry,
} from "./storage";
export const REPLICA_DB_NAME = "knowledge-library-replica";
export const REPLICA_DB_VERSION = 1;
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? Error("기기 저장에 실패했습니다."));
  });
}
export async function openReplica(
  owner: string,
  options: { name?: string; onInvalidated?: () => void } = {},
) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(
      options.name ?? REPLICA_DB_NAME,
      REPLICA_DB_VERSION,
    );
    r.onupgradeneeded = () => {
      for (const store of replicaStores)
        if (!r.result.objectStoreNames.contains(store))
          r.result.createObjectStore(store, { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () =>
      reject(
        r.error?.name === "VersionError"
          ? Error(
              "기기 자료는 유지됩니다. 최신 버전으로 서재를 다시 열어 주세요.",
            )
          : (r.error ?? Error("기기 저장소를 열지 못했습니다.")),
      );
    r.onblocked = () =>
      reject(Error("다른 서재 창을 닫고 다시 시도해 주세요."));
  });
  let closed = false;
  const check = () => {
    if (closed)
      throw Error("서재가 업데이트되었습니다. 화면을 다시 열어 주세요.");
  };
  db.onversionchange = () => {
    closed = true;
    db.close();
    options.onInvalidated?.();
  };
  const backend: ReplicaBackend = {
    async get(store, key) {
      check();
      const record = await request(
        db.transaction(store, "readonly").objectStore(store).get(key),
      );
      return record?.data;
    },
    async scan(store, prefix, after, limit = Number.MAX_SAFE_INTEGER) {
      check();
      return new Promise<StoredEntry[]>((resolve, reject) => {
        const tx = db.transaction(store, "readonly"),
          range = IDBKeyRange.bound(
            after ?? prefix,
            [...prefix, []],
            Boolean(after),
            true,
          ),
          r = tx.objectStore(store).openCursor(range),
          entries: StoredEntry[] = [];
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const c = r.result;
          if (!c || entries.length >= limit) {
            resolve(entries);
            return;
          }
          entries.push(c.value);
          c.continue();
        };
      });
    },
    async transaction(fn) {
      check();
      const tx = db.transaction([...replicaStores], "readwrite");
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () =>
          reject(tx.error ?? Error("기기 저장이 취소되었습니다."));
        tx.onerror = () => {};
      });
      // Only queued database operations run here. The public transaction callback
      // is synchronous and is collected before opening this IndexedDB transaction.
      const io: ReplicaIO = {
        get: async (s, key) =>
          (await request(tx.objectStore(s).get(key)))?.data,
        put: async (s, key, data) => {
          await request(tx.objectStore(s).put({ id: key, data }));
        },
        delete: async (s, key) => {
          await request(tx.objectStore(s).delete(key));
        },
      };
      try {
        await fn(io);
        await done;
      } catch (error) {
        try {
          tx.abort();
        } catch {}
        await done.catch(() => {});
        throw error;
      }
    },
    close() {
      closed = true;
      db.close();
    },
  };
  return createReplicaStorage(owner, backend);
}
