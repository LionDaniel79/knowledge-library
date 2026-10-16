import { categories } from "./catalog";
import { syncHash } from "./zotero-sync";
export type OrganizationItem = {
  key: string;
  version: number;
  data: Record<string, any> & { collections: string[] };
};
export type CollectionSpec = {
  key: string;
  name: string;
  parentCollection: string | false;
  path: string[];
};
export type MembershipPatch = {
  key: string;
  version: number;
  collections: string[];
};
export function categoryPath(
  category: string,
  classification: { verified?: boolean },
) {
  const entry = categories.find(([code]) => code === category);
  if (!entry) return ["지식서재", "분류 검토", "분야 미확인"];
  const name = entry.join(" ");
  return classification?.verified === true
    ? ["지식서재", name]
    : ["지식서재", "분류 검토", name + " (후보)"];
}
export function collectionSpecs(
  libraryId: string,
  paths: string[][],
): CollectionSpec[] {
  const all = new Map<string, string[]>();
  for (const path of paths)
    for (let i = 1; i <= path.length; i++)
      all.set(JSON.stringify(path.slice(0, i)), path.slice(0, i));
  const alphabet = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
  const key = (path: string[]) =>
    Buffer.from(
      syncHash(["knowledge-library-categories-v1", libraryId, path]),
      "hex",
    )
      .subarray(0, 8)
      .reduce((s, b) => s + alphabet[b % alphabet.length], "");
  return [...all.values()]
    .sort(
      (a, b) =>
        a.length - b.length ||
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
    )
    .map((path) => ({
      key: key(path),
      name: path.at(-1)!,
      parentCollection: path.length > 1 ? key(path.slice(0, -1)) : false,
      path,
    }));
}
export function membershipPatch(
  item: OrganizationItem,
  target: string,
  previousManaged: string[] = [],
): MembershipPatch | null {
  const collections = [
    ...new Set([
      ...item.data.collections.filter((k) => !previousManaged.includes(k)),
      target,
    ]),
  ];
  if (
    syncHash([...collections].sort()) ===
    syncHash([...item.data.collections].sort())
  )
    return null;
  return { key: item.key, version: item.version, collections };
}
export function preservedBookData(item: OrganizationItem) {
  const { collections, version, dateModified, ...rest } = item.data;
  return rest;
}
