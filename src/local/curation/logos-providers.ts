import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isbn13 } from "../../lib/bibliography";
import {
  parseLibraryTitleSearch,
  librarySearchTerm,
} from "../../server/catalog-provider";
import { atomicWriteJson } from "../atomic-json";
import { reserveCatalogRequest, CatalogQuotaError } from "./api-quota";
import { parseYes24Records, readYes24Response } from "./yes24-batch";
import { supplementLookup } from "./supplement-providers";
import type { LogosCandidate, LogosCompletionBook } from "./logos-discovery";

export function logosLookup(options: {
  allowFallback?: boolean;
  dir: string;
  libraryKey?: string;
  yes24Key?: string;
  fetcher?: typeof fetch;
  reserve?: (provider: "library" | "yes24", key: string) => unknown;
  isbnLookup?: ReturnType<typeof supplementLookup>;
}) {
  const fetcher = options.fetcher ?? fetch;
  const reserve = options.reserve ?? reserveCatalogRequest;
  const byIsbn =
    options.isbnLookup ??
    supplementLookup(join(options.dir, "isbn"), fetcher, {
      library: options.libraryKey,
      yes24: options.yes24Key,
    });
  return async (book: LogosCompletionBook): Promise<LogosCandidate[]> => {
    const records: LogosCandidate[] = [];
    const errors: unknown[] = [];
    for (const provider of ["library", "yes24"] as const) {
      try {
        const key =
          provider === "library" ? options.libraryKey : options.yes24Key;
        if (!key) continue;
        if (isbn13(book.isbn)) {
          records.push(...(await byIsbn(provider, isbn13(book.isbn))));
          continue;
        }
        const query = {
          title: book.title,
          author: book.author,
          publisher: book.publisher,
        };
        const fingerprint = createHash("sha256")
          .update(JSON.stringify(["logos-title/v1", provider, query]))
          .digest("hex");
        const path = join(options.dir, fingerprint + ".json");
        try {
          const cached = JSON.parse(await readFile(path, "utf8"));
          if (
            cached.fingerprint === fingerprint &&
            Array.isArray(cached.records) &&
            Date.now() - cached.at < 7 * 86400000
          ) {
            records.push(...cached.records);
            continue;
          }
        } catch (e) {
          if (
            !(e instanceof SyntaxError) &&
            (e as NodeJS.ErrnoException).code !== "ENOENT"
          )
            throw e;
        }
        const url = new URL(
          provider === "library"
            ? "https://data4library.kr/api/srchBooks"
            : "https://apis.yes24.com/v1/goods/itemList",
        );
        if (provider === "library") {
          url.search = new URLSearchParams({
            authKey: key,
            title: librarySearchTerm(query.title),
            author: librarySearchTerm(query.author),
            publisher: librarySearchTerm(query.publisher),
            pageNo: "1",
            pageSize: "10",
            format: "json",
          }).toString();
        } else
          url.search = new URLSearchParams({
            query: [book.title, book.author, book.publisher]
              .filter(Boolean)
              .join(" "),
            pageSize: "10",
            detail: "Y",
          }).toString();
        reserve(provider, key);
        const response = await fetcher(url, {
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: provider === "yes24" ? { "X-Api-Key": key } : {},
        });
        let found: LogosCandidate[];
        if (provider === "library") {
          if (!response.ok)
            throw Object.assign(
              Error("도서관 후보 검색을 완료하지 못했습니다."),
              { status: response.status },
            );
          found = parseLibraryTitleSearch(await response.json()).books.map(
            (r) => ({
              provider: "도서관 정보나루",
              url: r.url,
              isbn: r.isbn,
              title: r.title,
              facts: {
                title: r.title,
                author: r.author,
                publisher: r.publisher,
                isbn: r.isbn,
                coverUrl: r.coverUrl,
                category: r.category,
                classification: r.classification,
              },
              description: r.description,
              publicationYear: r.publicationYear,
              format: "unknown",
            }),
          );
        } else {
          const json = await readYes24Response(response);
          // This Logos collector includes textual periodicals; their stable resource
          // identity is independent of whether a book provider can find an ISBN.
          found = json
            ? parseYes24Records(json, "", true).map((r) => {
                const item = json.data.items.find((i: any) =>
                  r.url.endsWith("/" + i.itemId),
                );
                const kind = String(item?.goodsSortNm ?? "");
                return {
                  ...r,
                  publicationYear:
                    /^\d{4}/.exec(
                      String(item?.publishDate ?? item?.publicationDate ?? ""),
                    )?.[0] ?? "",
                  edition:
                    typeof item?.edition === "string" ? item.edition : "",
                  format: /ebook|전자책/i.test(kind) ? "digital" : "unknown",
                };
              })
            : [];
        }
        await mkdir(options.dir, { recursive: true });
        await atomicWriteJson(path, {
          fingerprint,
          at: Date.now(),
          records: found,
        });
        records.push(...found);
      } catch (e) {
        if (
          e instanceof CatalogQuotaError ||
          [401, 403, 429].includes((e as { status?: number })?.status ?? 0)
        )
          throw e;
        errors.push(e);
      }
    }
    if (!options.libraryKey && !options.yes24Key)
      throw Error("서지 제공자 인증 설정을 확인하세요.");
    if (!records.length && errors.length) throw errors[0];
    if (!records.length && book.publisher && options.allowFallback !== false)
      return logosLookup({ ...options, allowFallback: false })({
        ...book,
        publisher: "",
      });
    return records;
  };
}
