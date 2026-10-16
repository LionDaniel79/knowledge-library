import { isbn13 } from "../lib/bibliography";
import { providerText } from "../lib/provider-text";
import type { BookCandidate } from "../lib/book-lookup";
import {
  secureImage,
  lookupLibrary,
  lookupLibraryTitle,
} from "./catalog-provider";
import { LibraryError } from "./library-store";
const text = (v: unknown, max = 300) => providerText(v).slice(0, max);
function candidate(v: BookCandidate): BookCandidate {
  return {
    ...v,
    title: text(v.title),
    author: text(v.author),
    publisher: text(v.publisher),
    description: text(v.description, 3000),
    coverUrl: secureImage(v.coverUrl),
    totalPages:
      v.totalPages &&
      Number.isInteger(v.totalPages) &&
      v.totalPages > 0 &&
      v.totalPages <= 100000
        ? v.totalPages
        : null,
  };
}
export function parseYes24Books(json: any, expectedIsbn = ""): BookCandidate[] {
  if (json?.success !== true || !Array.isArray(json?.data?.items))
    throw Error("provider response");
  return json.data.items
    .slice(0, 10)
    .filter((b: any) => b.title && /^\d+$/.test(String(b.itemId)))
    .map((b: any) =>
      candidate({
        id: "yes24:" + b.itemId,
        provider: "yes24",
        sourceUrl: "https://www.yes24.com/product/goods/" + b.itemId,
        title: b.title,
        author: b.author ?? "",
        publisher: b.publisher ?? "",
        isbn: isbn13(String(b.isbn13 ?? b.isbn10 ?? "")),
        coverUrl: b.cover ?? "",
        totalPages: Number(b.pages) || null,
        description: b.contentDetail?.bookIntroduction ?? "",
      }),
    )
    .filter((b: BookCandidate) => !expectedIsbn || b.isbn === expectedIsbn);
}
export function parseGoogleBooks(
  json: any,
  expectedIsbn = "",
): BookCandidate[] {
  if (!json || json.error || !Array.isArray(json.items ?? []))
    throw Error("provider response");
  return (json.items ?? [])
    .slice(0, 10)
    .filter((b: any) => b.volumeInfo?.title && /^[\w-]+$/.test(b.id))
    .map((b: any) => {
      const v = b.volumeInfo;
      return candidate({
        id: "google:" + b.id,
        provider: "google",
        sourceUrl: "https://books.google.com/books?id=" + b.id,
        title: v.title,
        author: (v.authors ?? []).join(", "),
        publisher: v.publisher ?? "",
        isbn:
          (v.industryIdentifiers ?? [])
            .map((i: any) => isbn13(String(i.identifier)))
            .find(Boolean) ?? "",
        coverUrl: v.imageLinks?.thumbnail ?? "",
        totalPages: v.pageCount ?? null,
        description: v.description ?? "",
      });
    })
    .filter((b: BookCandidate) => !expectedIsbn || b.isbn === expectedIsbn);
}
type Options = {
  fetcher?: typeof fetch;
  yes24Key?: string;
  googleKey?: string;
  libraryKey?: string;
};
export async function searchBookMetadata(raw: string, options: Options = {}) {
  const q = raw.trim();
  if (q.length < 2 || q.length > 200)
    throw new LibraryError(400, "제목이나 ISBN을 2~200자로 입력해 주세요.");
  const isbn = isbn13(q),
    fetcher = options.fetcher ?? fetch,
    items: BookCandidate[] = [],
    warnings: string[] = [];
  const yes24 = options.yes24Key ?? process.env.YES24_API_KEY,
    google = options.googleKey ?? process.env.GOOGLE_BOOKS_API_KEY;
  // The PC collector uses the registered IP and shared durable quota ledger.
  const library =
    options.libraryKey ??
    (!process.env.VERCEL ? process.env.DATA4LIBRARY_KEY : undefined);
  async function json(url: URL, headers?: HeadersInit) {
    const response = await fetcher(url, {
      headers,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw Error("provider unavailable");
    return response.json();
  }
  if (yes24) {
    try {
      const url = new URL("https://apis.yes24.com/v1/goods/itemList");
      url.search = new URLSearchParams({
        query: isbn || q,
        pageSize: "10",
        category: "BOOK",
        detail: "Y",
      }).toString();
      items.push(
        ...parseYes24Books(await json(url, { "X-Api-Key": yes24 }), isbn),
      );
    } catch {
      warnings.push(
        "예스24 조회를 완료하지 못했습니다. 다른 검색 결과를 표시합니다.",
      );
    }
  }
  if (!items.length && library) {
    try {
      const results = isbn
        ? [await lookupLibrary(isbn, library)]
        : (await lookupLibraryTitle(q, library)).books;
      for (const b of results) {
        if (b)
          items.push(
            candidate({
              id: "library:" + b.isbn,
              provider: "library",
              title: b.title,
              author: b.author,
              publisher: b.publisher,
              isbn: b.isbn,
              coverUrl: b.coverUrl,
              totalPages: null,
              description: b.description,
              category: b.category,
              sourceUrl: "https://www.data4library.kr",
            }),
          );
      }
    } catch {
      warnings.push("정보나루 조회를 완료하지 못했습니다.");
    }
  }
  if (!items.length) {
    try {
      const url = new URL("https://www.googleapis.com/books/v1/volumes");
      url.search = new URLSearchParams({
        q: isbn ? "isbn:" + isbn : q,
        maxResults: "10",
        printType: "books",
      }).toString();
      if (google) url.searchParams.set("key", google);
      items.push(...parseGoogleBooks(await json(url), isbn));
    } catch {
      warnings.push("Google Books 조회를 완료하지 못했습니다.");
    }
  }
  if (!items.length) {
    try {
      if (isbn) {
        const url = new URL("https://openlibrary.org/api/books");
        url.search = new URLSearchParams({
          bibkeys: "ISBN:" + isbn,
          format: "json",
          jscmd: "data",
        }).toString();
        const b = (await json(url))["ISBN:" + isbn];
        if (b?.title)
          items.push(
            candidate({
              id: "openlibrary:" + isbn,
              provider: "openlibrary",
              sourceUrl: "https://openlibrary.org/isbn/" + isbn,
              title: b.title,
              author: (b.authors ?? []).map((a: any) => a.name).join(", "),
              publisher: (b.publishers ?? [])
                .map((p: any) => p.name)
                .join(", "),
              isbn,
              coverUrl: b.cover?.large ?? b.cover?.medium ?? "",
              description: "",
              totalPages: b.number_of_pages ?? null,
            }),
          );
      } else {
        const url = new URL("https://openlibrary.org/search.json");
        url.search = new URLSearchParams({
          title: q,
          limit: "10",
          fields: "key,title,author_name",
        }).toString();
        const data = await json(url);
        if (!Array.isArray(data.docs)) throw Error("provider response");
        for (const b of data.docs) {
          if (!/^\/works\/OL\d+W$/.test(b.key) || !b.title) continue;
          items.push(
            candidate({
              id: "openlibrary:" + b.key,
              provider: "openlibrary",
              sourceUrl: "https://openlibrary.org" + b.key,
              title: b.title,
              author: (b.author_name ?? []).join(", "),
              publisher: "",
              isbn: "",
              coverUrl: "",
              description: "",
              totalPages: null,
            }),
          );
        }
      }
    } catch {
      warnings.push("Open Library 조회를 완료하지 못했습니다.");
    }
  }
  return { items, warnings };
}
