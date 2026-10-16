import { isbn13 } from "../lib/bibliography";
import { providerText } from "../lib/provider-text";
import { reserveCatalogRequest } from "../local/curation/api-quota";
export interface BibliographicResult {
  title: string;
  author: string;
  publisher: string;
  isbn: string;
  coverUrl: string;
  description: string;
  descriptionFormat?: "plain-text-v1";
  category: string;
  classification: Record<string, unknown>;
  source: string;
  url: string;
}
export function parseLibraryResult(
  json: any,
  requestedIsbn: string,
): BibliographicResult | null {
  // The provider can return HTTP 200 for an inactive key. Never cache it as a miss.
  // Do not include the remote error text: it may echo authentication details.
  const errors = [json?.response?.error, json?.error].filter(Boolean);
  // Only this observed, explicit absence response is safe to cache as a missing book.
  if (
    errors.length &&
    errors.every((error) => error === "ISBN에 해당하는 도서가 없습니다.")
  )
    return null;
  if (errors.length)
    throw Error(
      "도서관 API 요청이 거부되었습니다. 인증키 승인 상태와 사용 한도를 확인해 주세요.",
    );
  const docs = json?.response?.detail ?? [];
  const requested = isbn13(requestedIsbn);
  for (const item of docs) {
    const b = item.book ?? item;
    if (!requested || isbn13(String(b.isbn13 ?? "")) !== requested) continue;
    const code = String(b.class_no ?? "").trim();
    const classified = /^\d{3}(?:\.\d+)?$/.test(code);
    return {
      title: String(b.bookname ?? ""),
      author: String(b.authors ?? ""),
      publisher: String(b.publisher ?? ""),
      isbn: requested,
      coverUrl: secureImage(b.bookImageURL),
      description: providerText(b.description).slice(0, 500),
      descriptionFormat: "plain-text-v1",
      category: classified ? code[0] + "00" : "",
      classification: {
        source: "국립중앙도서관·도서관 정보나루",
        code,
        verified: classified,
        method: "ISBN 일치",
        url: "https://www.data4library.kr",
      },
      source: "도서관 정보나루",
      url: "https://www.data4library.kr",
    };
  }
  return null;
}
export function secureImage(value: unknown) {
  try {
    const u = new URL(String(value));
    if (u.username || u.password) return "";
    // This provider's legacy image origin was verified to serve the same paths over HTTPS.
    if (
      u.protocol === "http:" &&
      u.hostname === "image.aladin.co.kr" &&
      !u.port
    )
      u.protocol = "https:";
    return u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}
export async function lookupLibrary(isbn: string, key: string) {
  const normalized = isbn13(isbn);
  if (!normalized) return null;
  const url = new URL("https://data4library.kr/api/srchDtlList");
  url.searchParams.set("authKey", key);
  url.searchParams.set("isbn13", normalized);
  url.searchParams.set("format", "json");
  reserveCatalogRequest("library", key);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw Error("도서관에 연결하지 못했습니다. 연결 상태를 확인해 주세요.");
  }
  if (!res.ok) throw Error("도서관 조회를 완료하지 못했습니다.");
  return parseLibraryResult(await res.json(), normalized);
}

export interface LibraryTitleSearch {
  numFound: number;
  books: (BibliographicResult & { volume: string; publicationYear: string })[];
}
/** Search hits are candidate editions, never proof of the PDF's edition. */
export function parseLibraryTitleSearch(json: any): LibraryTitleSearch {
  if (json?.response?.error || json?.error)
    throw Error(
      "도서관 검색 요청이 거부되었습니다. 승인·한도를 확인해 주세요.",
    );
  const response = json?.response;
  if (
    !response ||
    !Array.isArray(response.docs) ||
    !Number.isFinite(Number(response.numFound))
  )
    throw Error("도서관 검색 응답 형식을 확인하지 못했습니다.");
  const books: LibraryTitleSearch["books"] = [];
  for (const item of response.docs.slice(0, 10)) {
    const b = item.doc ?? item;
    const isbn = isbn13(String(b.isbn13 ?? ""));
    if (!isbn) continue;
    const parsed = parseLibraryResult(
      { response: { detail: [{ book: b }] } },
      isbn,
    );
    if (parsed)
      books.push({
        ...parsed,
        volume: String(b.vol ?? ""),
        publicationYear: String(b.publication_year ?? ""),
      });
  }
  return { numFound: Number(response.numFound), books };
}
export async function lookupLibraryTitle(
  title: string,
  key: string,
  author = "",
): Promise<LibraryTitleSearch> {
  if (!key || title.trim().length < 2 || title.length > 200)
    throw Error("제목과 인증키를 확인해 주세요.");
  // Unbalanced filename punctuation can produce HTTP 200 with an empty body.
  // Only the search query is normalized; exact edition checks retain the title.
  const query = title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (query.length < 2) throw Error("검색 가능한 제목을 확인해 주세요.");
  if (author.length > 200) throw Error("저자 검색 조건을 확인해 주세요.");
  const authorQuery = author
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const url = new URL("https://data4library.kr/api/srchBooks");
  url.searchParams.set("authKey", key);
  url.searchParams.set("title", query);
  if (authorQuery) url.searchParams.set("author", authorQuery);
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("pageSize", "10");
  url.searchParams.set("format", "json");
  reserveCatalogRequest("library", key);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw Error("도서관 검색에 연결하지 못했습니다.");
  }
  if (!response.ok) throw Error("도서관 검색을 완료하지 못했습니다.");
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw Error("도서관 검색 응답 형식을 확인하지 못했습니다.");
  }
  return parseLibraryTitleSearch(json);
}
