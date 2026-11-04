import { syncQuery } from "../../server/sync/write";
import { randomUUID } from "node:crypto";
import { isbn13 } from "../../lib/bibliography";
import { providerText as plain } from "../../lib/provider-text";
import type { CurationItem, SourceRef } from "../../lib/curation";
import type { Database } from "../../server/library-store";
import {
  contentHash,
  createCurationStore,
  readCurationSource,
} from "../../server/curation-store";
import { secureImage, lookupLibrary } from "../../server/catalog-provider";
import { reserveCatalogRequest } from "./api-quota";
export interface CollectedBook {
  provider: "Google Books" | "도서관 정보나루" | "예스24";
  url: string;
  isbn: string;
  title: string;
  facts: {
    title: string;
    author: string;
    publisher: string;
    isbn: string;
    coverUrl: string;
    category?: string;
    classification?: Record<string, unknown>;
  };
  description?: string;
  descriptionFormat?: "plain-text-v1";
  toc?: string[];
}
export function parseGoogleBooks(
  json: any,
  requestedIsbn: string,
): CollectedBook | null {
  const isbn = isbn13(requestedIsbn);
  if (!isbn) return null;
  for (const item of json?.items ?? []) {
    const v = item.volumeInfo;
    if (
      !v ||
      !v.industryIdentifiers?.some(
        (i: any) => isbn13(String(i.identifier ?? "")) === isbn,
      )
    )
      continue;
    return {
      provider: "Google Books",
      url: `https://books.google.com/books?id=${encodeURIComponent(item.id)}`,
      isbn,
      title: plain(v.title),
      facts: {
        title: plain(v.title),
        author: (v.authors ?? []).map(plain).join(", "),
        publisher: plain(v.publisher),
        isbn,
        coverUrl: secureImage(v.imageLinks?.thumbnail),
      },
      description: plain(v.description).slice(0, 500),
      descriptionFormat: "plain-text-v1",
    };
  }
  return null;
}
export async function lookupCollectedBook(
  isbn: string,
  provider: "google" | "library",
  key: string,
  fetcher: typeof fetch = fetch,
): Promise<CollectedBook | null> {
  if (!key) throw Error("서지 API 인증키가 설정되지 않았습니다.");
  if (!isbn13(isbn)) return null;
  if (provider === "library") {
    const r = await lookupLibrary(isbn, key, fetcher);
    return r
      ? {
          provider: "도서관 정보나루",
          url: r.url,
          isbn: r.isbn,
          title: r.title,
          description: r.description,
          descriptionFormat: r.descriptionFormat,
          facts: {
            title: r.title,
            author: r.author,
            publisher: r.publisher,
            isbn: r.isbn,
            coverUrl: r.coverUrl,
            category: r.category,
            classification: r.classification,
          },
        }
      : null;
  }
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", "isbn:" + isbn13(isbn));
  url.searchParams.set("key", key);
  url.searchParams.set("maxResults", "5");
  reserveCatalogRequest("google", key);
  let response: Response;
  try {
    response = await fetcher(url, {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
  } catch {
    throw Error("서지 제공자에 연결하지 못했습니다.");
  }
  if (!response.ok)
    throw Error(
      response.status === 429
        ? "서지 제공자 사용량 한도에 도달했습니다."
        : "서지 제공자 요청 실패",
    );
  return parseGoogleBooks(await response.json(), isbn);
}
export async function collectBookReference(
  db: Database,
  owner: string,
  source: SourceRef,
  record: CollectedBook,
  apply = false,
) {
  if (source.kind !== "book") throw Error("책만 서지 조회할 수 있습니다.");
  const current = await readCurationSource(db, owner, source);
  if (current.version !== source.version)
    throw Error("책 정보가 변경되었습니다.");
  const book = (
    await db.query(
      "SELECT isbn FROM library_books WHERE owner_id=$1 AND id=$2",
      [owner, source.id],
    )
  ).rows[0];
  if (!isbn13(book.isbn) || isbn13(book.isbn) !== isbn13(record.isbn))
    throw Error("동일 판본의 ISBN 근거가 필요합니다.");
  const url = new URL(record.url),
    host = url.hostname;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !(
      (record.provider === "Google Books" && host === "books.google.com") ||
      (record.provider === "예스24" &&
        host === "www.yes24.com" &&
        /^\/product\/goods\/\d+$/.test(url.pathname) &&
        !url.search &&
        !url.hash &&
        !url.port) ||
      (record.provider === "도서관 정보나루" &&
        ["www.data4library.kr", "data4library.kr"].includes(host))
    )
  )
    throw Error("서지 제공자 주소 불일치");
  const excerpt =
    JSON.stringify(record.facts) +
    [record.description, ...(record.toc ?? [])].filter(Boolean).join("\n");
  const hash = contentHash(excerpt),
    store = createCurationStore(db);
  const existing = (
    await db.query(
      "SELECT id FROM library_reference_sources WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND source_version=$3 AND content_hash=$4 AND provider=$5",
      [owner, source.id, source.version, hash, record.provider],
    )
  ).rows[0];
  if (!apply) return { dryRun: true, applied: 0, duplicate: !!existing };
  const id = existing?.id ?? randomUUID();
  if (!existing)
    await syncQuery(
      db,
      owner,
      "INSERT INTO library_reference_sources(id,owner_id,source_kind,source_id,source_version,url,provider,title,content_hash,excerpt,facts,edition_match) VALUES($1,$2,'book',$3,$4,$5,$6,$7,$8,$9,$10,'isbn')",
      [
        id,
        owner,
        source.id,
        source.version,
        url.href,
        record.provider,
        record.title,
        hash,
        excerpt,
        JSON.stringify(record.facts),
      ],
    );
  const items: CurationItem[] = [
    {
      id: randomUUID(),
      source,
      kind: "bibliography",
      proposedValue: record.facts,
      evidence: { referenceId: id, quote: record.isbn },
      coverage: "metadata",
      origin: "provider",
      generator: record.provider + "/v1",
    },
  ];
  if (record.description)
    items.push({
      ...items[0],
      id: randomUUID(),
      kind: "publisher_intro",
      generator: record.provider + "/" + (record.descriptionFormat ?? "v1"),
      proposedValue: record.description,
      evidence: { referenceId: id, quote: record.description.slice(0, 500) },
    });
  if (record.toc?.length)
    items.push({
      ...items[0],
      id: randomUUID(),
      kind: "toc",
      proposedValue: record.toc,
      coverage: "toc",
      evidence: { referenceId: id, quote: record.toc[0].slice(0, 500) },
    });
  const run = await store.begin(
    owner,
    contentHash(JSON.stringify([source, hash])),
    "catalog-provider",
  );
  const result = await store.apply(owner, run, items);
  await store.seal(owner, run);
  return {
    dryRun: false,
    applied: result.applied,
    duplicate: !!existing && result.applied === 0,
    runId: run,
  };
}
