import { isbn13, suggestCategory } from "../lib/bibliography";
import { categoryName, categories } from "../lib/catalog";
import { reserveCatalogRequest } from "../local/curation/api-quota";
import { providerText } from "../lib/provider-text";
import type { BookCandidate } from "../lib/book-lookup";
import {
  secureImage,
  lookupLibrary,
  lookupLibraryTitle,
} from "./catalog-provider";
import { LibraryError } from "./library-store";
const text = (v: unknown, max = 300) => providerText(v).slice(0, max);
function subjectTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => text(v, 40).trim()).filter((v) => v.length > 1))].slice(0, 12);
}
function candidate(v: BookCandidate): BookCandidate {
  return {
    ...v,
    title: text(v.title),
    author: text(v.author),
    publisher: text(v.publisher),
    description: text(v.description, 3000),
    tags: subjectTags(v.tags),
    category: categories.some(([code]) => code === v.category) ? v.category : "",
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
        tags: subjectTags([b.categoryName, b.category?.name].filter(Boolean)),
        category: suggestCategory("", subjectTags([b.categoryName, b.category?.name].filter(Boolean))),
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
        tags: subjectTags(v.categories),
        category: suggestCategory("", subjectTags(v.categories)),
      });
    })
    .filter((b: BookCandidate) => !expectedIsbn || b.isbn === expectedIsbn);
}
/** ISBN-specific keyword data from the registered-IP library API. */
export function parseLibraryKeywords(payload: any): string[] {
  if (payload?.error || payload?.response?.error) return [];
  const items = payload?.response?.items;
  const list = Array.isArray(items) ? items : items?.item;
  return subjectTags((Array.isArray(list) ? list : list ? [list] : []).map((v: any) => v.item?.word ?? v.word));
}
async function lookupLibraryKeywords(isbn: string, key: string, fetcher: typeof fetch) {
  const url = new URL("https://data4library.kr/api/keywordList");
  url.search = new URLSearchParams({ authKey: key, isbn13: isbn, additionalYN: "Y", format: "json" }).toString();
  reserveCatalogRequest("library", key);
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(8000),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) return [];
  return parseLibraryKeywords(await response.json());
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
  // The source which first supplies a cover/title must not prevent verified
  // KDC classification and subjects from filling the same edition.
  if (library) {
    try {
      const results = isbn
        ? [await lookupLibrary(isbn, library)]
        : (await lookupLibraryTitle(q, library)).books;
      for (const b of results) {
        if (!b) continue;
        const fromLibrary = candidate({
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
          tags: b.category ? [categoryName(b.category)] : [],
          sourceUrl: "https://www.data4library.kr",
        });
        const i = items.findIndex((item) => item.isbn && item.isbn === b.isbn);
        if (i >= 0) {
          items[i] = candidate({
            ...items[i],
            category: fromLibrary.category || items[i].category,
            tags: [...(items[i].tags ?? []), ...(fromLibrary.tags ?? [])],
          });
        } else if (!items.length || isbn) items.push(fromLibrary);
      }
      // Only an explicit ISBN lookup incurs a further keyword request;
      // title searches can have many unrelated editions and must not spend
      // one registered-IP quota unit per match.
      if (isbn && items.length) {
        const keywords = await lookupLibraryKeywords(isbn, library, fetcher);
        for (let i = 0; i < items.length; i++)
          if (items[i].isbn === isbn)
            items[i] = candidate({
              ...items[i], tags: [...(items[i].tags ?? []), ...keywords],
            });
      }
    } catch {
      warnings.push("정보나루 분야·주제 보강을 완료하지 못했습니다.");
    }
  }
  // A registered data4library key may be PC-only. Google Books exposes
  // publisher-provided subjects as a graceful fallback in web deployments.
  if (items.length && items.some((b) => !b.category || !b.tags?.length)) {
    try {
      const url = new URL("https://www.googleapis.com/books/v1/volumes");
      url.search = new URLSearchParams({
        q: isbn ? "isbn:" + isbn : q,
        maxResults: "10",
        printType: "books",
      }).toString();
      if (google) url.searchParams.set("key", google);
      const candidates = parseGoogleBooks(await json(url), isbn);
      for (const item of items) {
        const match = candidates.find((b) =>
          b.isbn && item.isbn && b.isbn === item.isbn,
        );
        if (match) {
          item.category ||= match.category;
          item.tags = subjectTags([...(item.tags ?? []), ...(match.tags ?? [])]);
        }
      }
    } catch {
      // Metadata enrichment is optional; retain all original search results.
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
