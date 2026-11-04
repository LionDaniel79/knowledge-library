import { createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "../atomic-json";
import { lookupCollectedBook, type CollectedBook } from "./catalog";
import { parseYes24Records, readYes24Response } from "./yes24-batch";
import { reserveCatalogRequest } from "./api-quota";
export function supplementLookup(
  dir: string,
  fetcher = fetch,
  keys: { library?: string; yes24?: string } = {},
) {
  return async (
    provider: "yes24" | "library",
    isbn: string,
  ): Promise<CollectedBook[]> => {
    const key =
      keys[provider] ??
      process.env[provider === "yes24" ? "YES24_API_KEY" : "DATA4LIBRARY_KEY"];
    if (!key) throw Error("Catalog credential unavailable.");
    const path = join(
      dir,
      createHash("sha256").update(`${provider}:${isbn}`).digest("hex") +
        ".json",
    );
    try {
      const cache = JSON.parse(await readFile(path, "utf8"));
      if (
        cache.isbn === isbn &&
        cache.provider === provider &&
        Date.now() - cache.at < 7 * 86400000 &&
        Array.isArray(cache.records)
      )
        return cache.records;
    } catch {}
    let records: CollectedBook[];
    if (provider === "yes24") {
      reserveCatalogRequest(provider, key);
      const url = new URL("https://apis.yes24.com/v1/goods/itemList");
      url.search = new URLSearchParams({
        query: isbn,
        pageSize: "10",
        category: "BOOK",
        detail: "Y",
      }).toString();
      const json = await readYes24Response(
        await fetcher(url, {
          headers: { "X-Api-Key": key },
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        }),
      );
      records = json ? parseYes24Records(json, isbn) : [];
    } else {
      const r = await lookupCollectedBook(isbn, provider, key, fetcher);
      records = r ? [r] : [];
    }
    await mkdir(dir, { recursive: true });
    await atomicWriteJson(path, { at: Date.now(), provider, isbn, records });
    return records;
  };
}
