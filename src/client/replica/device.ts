type StorageApi = Partial<
  Pick<StorageManager, "estimate" | "persisted" | "persist">
>;
const browserStorage = () =>
  typeof navigator === "undefined" ? undefined : navigator.storage;
export async function readStorageStatus(
  api: StorageApi | undefined = browserStorage(),
) {
  const [estimate, persisted] = await Promise.all([
    api?.estimate?.().catch(() => null),
    api?.persisted?.().catch(() => null),
  ]);
  return {
    usage: estimate?.usage ?? null,
    quota: estimate?.quota ?? null,
    persisted: persisted ?? null,
  };
}
export async function requestPersistentStorage(
  api: StorageApi | undefined = browserStorage(),
): Promise<boolean | null> {
  return api?.persist?.().catch(() => null) ?? null;
}
export async function readShellStatus(): Promise<
  "ready" | "waiting" | "unavailable"
> {
  if (
    typeof navigator === "undefined" ||
    !navigator.serviceWorker ||
    typeof caches === "undefined"
  )
    return "unavailable";
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration?.active) return "unavailable";
    const version = new URL(registration.active.scriptURL).searchParams.get(
      "build",
    );
    if (!version) return "unavailable";
    const cache = await caches.open("knowledge-library-shell-" + version);
    return (await cache.match("/"))
      ? registration.waiting
        ? "waiting"
        : "ready"
      : "unavailable";
  } catch {
    return "unavailable";
  }
}
export const formatStorageBytes = (n: number | null) =>
  n === null
    ? "확인 불가"
    : n >= 1024 ** 3
      ? `${(n / 1024 ** 3).toFixed(2)} GB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`;
