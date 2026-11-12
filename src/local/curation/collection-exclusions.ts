import { readFile } from "node:fs/promises";

/** The scheduler owns this private ledger; collectors only read it. */
export async function collectionExclusions(
  path: string | undefined,
  kind: "logos" | "pdf",
) {
  if (!path) return new Set<string>();
  const ledger = JSON.parse(await readFile(path, "utf8"));
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
  }).format(new Date());
  const ids: unknown = ledger?.[kind]?.ids;
  if (
    ledger?.day !== today ||
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== "string" || !id) ||
    new Set(ids).size !== ids.length
  )
    throw Error("Invalid daily collection exclusion ledger");
  return new Set<string>(ids);
}
