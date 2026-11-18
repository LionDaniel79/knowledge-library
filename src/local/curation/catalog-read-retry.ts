import { collectionFailure } from "./collection-failure";
/** Only wrap idempotent reads, never a transaction or a write/apply operation. */
export async function retryCatalogRead<T>(
  read: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++)
    try {
      return await read();
    } catch (error) {
      if (attempt >= 2 || !collectionFailure(error, "read").retryable)
        throw error;
      await sleep((attempt + 1) * 1000);
    }
}
