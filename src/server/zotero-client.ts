import { LibraryError } from "./library-store";
import type {
  OrganizationItem,
  CollectionSpec,
  MembershipPatch,
} from "../lib/zotero-organization";
import {
  managedZoteroData,
  type RemoteItem,
  type ZoteroData,
} from "../lib/zotero-sync";
const keyPattern = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
export type ZoteroWrite = ZoteroData & {
  key: string;
  version: number;
  tags?: unknown[];
  collections?: string[];
  relations?: Record<string, string>;
};
export interface ZoteroRemote {
  libraryId: string;
  readLibrary(): Promise<{ version: number; items: RemoteItem[] }>;
  write(
    items: ZoteroWrite[],
    version: number,
  ): Promise<{ successful: Record<number, RemoteItem>; failed: number[] }>;
}
export class ZoteroClient implements ZoteroRemote {
  private nextRequestAt = 0;
  constructor(
    public libraryId: string,
    private apiKey: string,
    private fetcher: typeof fetch = fetch,
  ) {
    if (!/^[1-9][0-9]{0,19}$/.test(libraryId) || !apiKey)
      throw new LibraryError(503, "Zotero 연결 설정을 확인하세요.");
  }
  private async request(path: string, init: RequestInit = {}) {
    if (Date.now() < this.nextRequestAt)
      throw new LibraryError(
        429,
        "Zotero가 잠시 대기를 요청했습니다. 잠시 후 다시 시도하세요.",
      );
    let response: Response;
    try {
      response = await this.fetcher("https://api.zotero.org" + path, {
        ...init,
        headers: {
          "Zotero-API-Key": this.apiKey,
          "Zotero-API-Version": "3",
          ...init.headers,
        },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new LibraryError(
        502,
        "Zotero 응답을 확인하지 못했습니다. 미리보기로 전송 상태를 다시 확인하세요.",
      );
    }
    const seconds = Math.max(
      Number(response.headers.get("Backoff") ?? 0),
      Number(response.headers.get("Retry-After") ?? 0),
    );
    if (Number.isFinite(seconds) && seconds > 0)
      this.nextRequestAt = Date.now() + Math.min(seconds, 86400) * 1000;
    if (!response.ok) {
      if (response.status === 412)
        throw new LibraryError(
          409,
          "Zotero 자료가 변경되었습니다. 미리보기를 다시 확인하세요.",
        );
      if (response.status === 429) {
        this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + 60000);
        throw new LibraryError(
          429,
          "Zotero 호출 대기 중입니다. 잠시 후 다시 시도하세요.",
        );
      }
      throw new LibraryError(
        response.status === 401 || response.status === 403 ? 503 : 502,
        "Zotero 연결 또는 권한을 확인하세요. (HTTP " + response.status + ")",
      );
    }
    const text = await response.text();
    if (text.length > 10000000)
      throw new LibraryError(502, "Zotero 응답이 너무 큽니다.");
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LibraryError(502, "Zotero 응답을 읽지 못했습니다.");
    }
    return { response, json };
  }
  async verifyAccess() {
    const { json } = await this.request("/keys/current");
    if (
      String(json.userID) !== this.libraryId ||
      !json.access?.user?.library ||
      !json.access?.user?.write
    )
      throw new LibraryError(
        503,
        "연결된 Zotero 계정과 개인서재 읽기·쓰기 권한을 확인하세요.",
      );
  }
  private async organizationObjects(kind: "books" | "collections") {
    const items: any[] = [];
    let version: number | undefined;
    for (let start = 0; start < 50000; start += 100) {
      const path =
        kind === "books" ? "items/top?itemType=book&" : "collections?";
      const { response, json } = await this.request(
        "/users/" +
          this.libraryId +
          "/" +
          path +
          "format=json&include=data&limit=100&start=" +
          start,
      );
      const v = Number(response.headers.get("Last-Modified-Version")),
        total = Number(response.headers.get("Total-Results"));
      if (
        !response.headers.has("Last-Modified-Version") ||
        !response.headers.has("Total-Results") ||
        !Number.isSafeInteger(v) ||
        v < 0 ||
        !Number.isSafeInteger(total) ||
        total < 0 ||
        !Array.isArray(json)
      )
        throw new LibraryError(502, "Zotero 분류 목록을 확인하지 못했습니다.");
      if (version !== undefined && version !== v)
        throw new LibraryError(
          409,
          "Zotero 목록이 변경되었습니다. 다시 확인하세요.",
        );
      version = v;
      for (const item of json) {
        if (
          !keyPattern.test(item?.key) ||
          !Number.isSafeInteger(item.version) ||
          item.version < 0 ||
          !item.data
        )
          throw new LibraryError(502, "Zotero 분류 응답이 올바르지 않습니다.");
        if (kind === "books") {
          if (
            item.data.itemType !== "book" ||
            !Array.isArray(item.data.collections) ||
            item.data.collections.some(
              (k: unknown) => typeof k !== "string" || !keyPattern.test(k),
            )
          )
            throw new LibraryError(502, "Zotero 도서 분류를 읽지 못했습니다.");
        } else if (
          typeof item.data.name !== "string" ||
          !(
            item.data.parentCollection === false ||
            keyPattern.test(item.data.parentCollection)
          )
        )
          throw new LibraryError(502, "Zotero 컬렉션 응답을 확인하세요.");
        items.push({ key: item.key, version: item.version, data: item.data });
      }
      if (start + json.length >= total) return { version, items };
      if (!json.length)
        throw new LibraryError(502, "Zotero 분류 목록 일부가 누락되었습니다.");
    }
    throw new LibraryError(413, "Zotero 분류 목록이 너무 큽니다.");
  }
  async readOrganizationBooks(): Promise<{
    version: number;
    items: OrganizationItem[];
  }> {
    return this.organizationObjects("books");
  }
  async readCollections(): Promise<{
    version: number;
    items: {
      key: string;
      version: number;
      data: { name: string; parentCollection: string | false };
    }[];
  }> {
    return this.organizationObjects("collections");
  }
  private async organizationWrite(
    kind: "items" | "collections",
    items: Record<string, unknown>[],
    version: number,
  ) {
    if (
      !items.length ||
      items.length > 50 ||
      !Number.isSafeInteger(version) ||
      version < 0 ||
      items.some((i) => typeof i.key !== "string" || !keyPattern.test(i.key))
    )
      throw new LibraryError(400, "Zotero 분류 전송 범위를 확인하세요.");
    const { response, json } = await this.request(
      "/users/" + this.libraryId + "/" + kind,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Unmodified-Since-Version": String(version),
        },
        body: JSON.stringify(items),
      },
    );
    const next = Number(response.headers.get("Last-Modified-Version"));
    if (
      !response.headers.has("Last-Modified-Version") ||
      !Number.isSafeInteger(next) ||
      next < version
    )
      throw new LibraryError(
        502,
        "분류 저장 버전이 불확실합니다. 다시 조회하세요.",
      );
    const successful = items.map((p, i) => {
      const item = json.successful?.[i];
      if (
        !item ||
        item.key !== p.key ||
        !Number.isSafeInteger(item.version) ||
        item.version < 0 ||
        !item.data
      )
        throw new LibraryError(
          502,
          "분류 일부의 저장이 불확실합니다. 다시 조회해서 이어가세요.",
        );
      return { key: item.key, version: item.version, data: item.data };
    });
    return { version: next, items: successful };
  }
  async createCollections(specs: CollectionSpec[], version: number) {
    return this.organizationWrite(
      "collections",
      specs.map((s) => ({
        key: s.key,
        version: 0,
        name: s.name,
        parentCollection: s.parentCollection,
      })),
      version,
    );
  }
  async writeMemberships(
    items: MembershipPatch[],
    version: number,
  ): Promise<{ version: number; items: OrganizationItem[] }> {
    if (
      items.some(
        (i) =>
          !Number.isSafeInteger(i.version) ||
          i.version < 1 ||
          !Array.isArray(i.collections) ||
          i.collections.some((k) => !keyPattern.test(k)),
      )
    )
      throw new LibraryError(400, "Zotero 분류 항목을 확인하세요.");
    return this.organizationWrite(
      "items",
      items.map((i) => ({
        key: i.key,
        version: i.version,
        collections: i.collections,
      })),
      version,
    );
  }
  async readLibrary() {
    const items: RemoteItem[] = [];
    let version: number | undefined;
    for (let start = 0; start < 50000; start += 100) {
      const { response, json } = await this.request(
        "/users/" +
          this.libraryId +
          "/items/top?itemType=book&format=json&include=data&limit=100&start=" +
          start,
      );
      const current = Number(response.headers.get("Last-Modified-Version")),
        total = Number(response.headers.get("Total-Results"));
      if (
        !response.headers.has("Last-Modified-Version") ||
        !response.headers.has("Total-Results") ||
        !Number.isSafeInteger(current) ||
        current < 0 ||
        !Number.isSafeInteger(total) ||
        total < 0 ||
        !Array.isArray(json)
      )
        throw new LibraryError(
          502,
          "Zotero 목록의 버전 정보를 확인할 수 없습니다.",
        );
      if (version !== undefined && version !== current)
        throw new LibraryError(
          409,
          "목록을 읽는 중 Zotero가 변경되었습니다. 다시 확인하세요.",
        );
      version = current;
      for (const item of json) items.push(this.parseItem(item));
      if (start + json.length >= total) return { version, items };
      if (json.length === 0)
        throw new LibraryError(502, "Zotero 목록 일부를 읽지 못했습니다.");
    }
    throw new LibraryError(
      413,
      "Zotero 목록이 한 번에 확인할 수 있는 범위를 넘었습니다.",
    );
  }
  private parseItem(item: any): RemoteItem {
    if (
      !item ||
      !keyPattern.test(item.key) ||
      !Number.isSafeInteger(item.version) ||
      item.version < 0 ||
      item.data?.itemType !== "book"
    )
      throw new LibraryError(502, "Zotero 서지 응답을 확인할 수 없습니다.");
    return {
      key: item.key,
      version: item.version,
      data: managedZoteroData(item.data),
    };
  }
  async write(items: ZoteroWrite[], version: number) {
    if (
      !items.length ||
      items.length > 50 ||
      items.some((i) => !keyPattern.test(i.key))
    )
      throw new LibraryError(400, "한 번에 1~50권을 선택하세요.");
    const { json } = await this.request("/users/" + this.libraryId + "/items", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "If-Unmodified-Since-Version": String(version),
      },
      body: JSON.stringify(items),
    });
    const successful: Record<number, RemoteItem> = {},
      failed: number[] = [];
    for (let i = 0; i < items.length; i++) {
      if (json.successful?.[i]) {
        const item = this.parseItem(json.successful[i]);
        if (item.key !== items[i].key)
          throw new LibraryError(502, "Zotero 전송 결과의 식별자가 다릅니다.");
        successful[i] = item;
      } else if (json.failed?.[i]) failed.push(i);
      else
        throw new LibraryError(
          502,
          "전송 결과가 불확실합니다. 미리보기로 다시 확인하세요.",
        );
    }
    return { successful, failed };
  }
}
