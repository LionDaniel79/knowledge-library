import { createHash } from "node:crypto";
import { isbn13, compactTitle } from "./bibliography";
export type SyncBook = {
  id: string;
  version: number;
  title: string;
  author: string;
  publisher: string;
  isbn: string;
  excluded?: boolean;
};
export type ZoteroData = {
  itemType: string;
  title: string;
  creators: {
    creatorType: string;
    name?: string;
    firstName?: string;
    lastName?: string;
  }[];
  publisher: string;
  ISBN: string;
};
export type RemoteItem = { key: string; version: number; data: ZoteroData };
export type SyncLink = {
  book_id: string;
  external_id: string;
  state: string;
  version: number;
  snapshot: { sync?: { remoteVersion: number; data: ZoteroData } };
};
export type SyncEntry = {
  book: SyncBook;
  key: string;
  action: "create" | "link" | "update" | "unchanged" | "review" | "excluded";
  reason: string;
  data: ZoteroData;
  remote?: RemoteItem;
  linkVersion: number;
};
export type SyncPlan = {
  libraryId: string;
  libraryVersion: number;
  entries: SyncEntry[];
  fingerprint: string;
};
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const syncHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export function zoteroBookData(b: SyncBook): ZoteroData {
  return {
    itemType: "book",
    title: b.title,
    creators: b.author ? [{ creatorType: "author", name: b.author }] : [],
    publisher: b.publisher,
    ISBN: isbn13(b.isbn),
  };
}
export function managedZoteroData(data: Record<string, any>): ZoteroData {
  return {
    itemType: String(data.itemType ?? ""),
    title: String(data.title ?? ""),
    creators: Array.isArray(data.creators)
      ? data.creators.map((c) => ({
          creatorType: String(c.creatorType ?? ""),
          ...(typeof c.name === "string"
            ? { name: c.name }
            : {
                firstName: String(c.firstName ?? ""),
                lastName: String(c.lastName ?? ""),
              }),
        }))
      : [],
    publisher: String(data.publisher ?? ""),
    ISBN: String(data.ISBN ?? ""),
  };
}
const equal = (a: ZoteroData, b: ZoteroData) => syncHash(a) === syncHash(b);
export function planZoteroSync(
  owner: string,
  libraryId: string,
  libraryVersion: number,
  books: SyncBook[],
  items: RemoteItem[],
  links: SyncLink[],
): SyncPlan {
  const claimed = new Set<string>();
  const entries = books.map((book): SyncEntry => {
    const data = zoteroBookData(book);
    const digest = createHash("sha256")
      .update(JSON.stringify([owner, libraryId, book.id]))
      .digest();
    const alphabet = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
    const key = [...digest.subarray(0, 8)]
      .map((x) => alphabet[x % 32])
      .join("");
    const base: SyncEntry = {
      book,
      key,
      action: "create",
      reason: "새 서지",
      data,
      linkVersion: 0,
    };
    const review = (reason: string, remote?: RemoteItem): SyncEntry => ({
      ...base,
      action: "review",
      reason,
      ...(remote ? { key: remote.key, remote } : {}),
    });
    if (book.excluded)
      return {
        ...base,
        action: "excluded",
        reason: "논문·간행물은 기본정보만 보관",
      };
    const ownLinks = links.filter((l) => l.book_id === book.id);
    if (ownLinks.length > 1)
      return review("연결이 여러 개입니다. 먼저 사용할 항목을 확인하세요.");
    const link = ownLinks[0];
    if (link) {
      base.linkVersion = link.version;
      if (link.state !== "active")
        return review(
          "직접 해제한 연결입니다. 자동으로 다시 연결하지 않습니다.",
        );
      const prefix = "users/" + libraryId + "/";
      if (!link.external_id.startsWith(prefix))
        return review("다른 Zotero 서재의 연결입니다.");
      base.key = link.external_id.slice(prefix.length);
      const remote = items.find((r) => r.key === base.key);
      if (!remote)
        return review(
          "Zotero 항목이 없거나 휴지통에 있습니다. 다시 만들지 않습니다.",
        );
      if (equal(data, remote.data))
        return {
          ...base,
          remote,
          action:
            link.snapshot.sync?.remoteVersion === remote.version &&
            equal(link.snapshot.sync.data, remote.data)
              ? "unchanged"
              : "link",
          reason: "현재 서지가 같습니다.",
        };
      const previous = link.snapshot.sync;
      if (
        !previous ||
        previous.remoteVersion !== remote.version ||
        !equal(previous.data, remote.data)
      )
        return review(
          "Zotero에서 변경되었거나 직접 연결한 자료입니다. 양쪽 정보를 확인하세요.",
          remote,
        );
      return {
        ...base,
        remote,
        action: "update",
        reason: "지식서재에서 바뀐 서지를 반영합니다.",
      };
    }
    const identities = [
      "title:" + compactTitle(data.title),
      ...(data.ISBN ? ["isbn:" + data.ISBN] : []),
    ];
    if (identities.some((identity) => claimed.has(identity)))
      return review(
        "이번 목록에 같은 ISBN 또는 제목이 있습니다. 소장본·판본을 확인하세요.",
      );
    identities.forEach((identity) => claimed.add(identity));
    const candidates = items.filter(
      (r) =>
        r.key === key ||
        (data.ISBN && isbn13(r.data.ISBN) === data.ISBN) ||
        compactTitle(r.data.title) === compactTitle(data.title),
    );
    if (candidates.length > 1)
      return review("Zotero에 일치할 수 있는 항목이 여러 개 있습니다.");
    if (candidates.length) {
      const remote = candidates[0];
      if (
        links.some(
          (l) =>
            l.external_id === "users/" + libraryId + "/" + remote.key &&
            l.book_id !== book.id,
        )
      )
        return review("다른 소장 도서에 이미 연결된 항목입니다.", remote);
      if (equal(data, remote.data) && (data.ISBN || book.author.trim()))
        return {
          ...base,
          key: remote.key,
          remote,
          action: "link",
          reason: "동일한 서지가 있어 기존 항목에 연결합니다.",
        };
      return review(
        "유사한 책이 있습니다. 판본·저자·출판사를 확인하세요.",
        remote,
      );
    }
    return { ...base, reason: "Zotero에 새 서지를 추가합니다." };
  });
  const plan = { libraryId, libraryVersion, entries };
  return { ...plan, fingerprint: syncHash(plan) };
}
