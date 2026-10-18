import type { ReplicaStorage } from "./storage";
import { createLocalReplicaRepository } from "./repository-local";
import { createReplicaReader, readerMethods } from "./reader-client";
export { UnsupportedLocalRoute } from "./repository-local";
export function createReplicaRepository(storage: ReplicaStorage) {
  const repository = createLocalReplicaRepository(storage);
  if (storage.databaseName && typeof Worker !== "undefined") {
    const reader = createReplicaReader(storage.owner, storage.databaseName);
    for (const method of readerMethods) {
      const local = (
        repository[method] as (...args: any[]) => Promise<any>
      ).bind(repository);
      (repository as any)[method] = (...args: any[]) =>
        reader.read(method, args, () => local(...args));
    }
    const invalidate = repository.invalidate,
      close = repository.close;
    repository.invalidate = () => {
      invalidate();
      reader.invalidate();
    };
    repository.close = () => {
      reader.close();
      close();
    };
  }
  return repository;
}
export type ReplicaRepository = ReturnType<typeof createReplicaRepository>;
