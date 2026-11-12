import { catalogSelection } from "@/lib/catalog-selection";
import { catalogProviderNames } from "@/lib/book-lookup";
export function CatalogAttribution({
  value,
  automatic,
  compact = false,
}: {
  value: unknown;
  automatic?: Record<string, unknown>;
  compact?: boolean;
}) {
  const adoption = automatic?.autoBibliography as
    { provider?: string; url?: string; fields?: string[] } | undefined;
  const adopted = adoption?.fields?.length
    ? catalogSelection.safeParse({
        provider:
          adoption.provider === "예스24"
            ? "yes24"
            : adoption.provider === "도서관 정보나루"
              ? "library"
              : "",
        sourceUrl: adoption.url,
        description:
          typeof automatic?.auto_description === "string"
            ? automatic.auto_description
            : "",
      })
    : undefined;
  const original = catalogSelection.safeParse(value);
  const result = original.success ? original : (adopted ?? original);
  if (!result.success) return null;
  const v = result.data;
  // YES24 requires attribution on displays using its information, even when compact.
  if (compact)
    return v.provider === "yes24" ? (
      <small className="catalog-credit">예스24</small>
    ) : null;
  return (
    <div className="catalog-credit">
      {v.description && (
        <details>
          <summary>책 소개</summary>
          <p>{v.description}</p>
        </details>
      )}
      {adopted?.success &&
        typeof automatic?.auto_publicationYear === "string" && (
          <p>참고 판본 발행연도: {automatic.auto_publicationYear}</p>
        )}
      {adopted?.success &&
        Array.isArray(automatic?.auto_toc) &&
        automatic.auto_toc.length > 0 && (
          <details>
            <summary>목차 · 참고 판본</summary>
            <ol>
              {automatic.auto_toc
                .filter((item): item is string => typeof item === "string")
                .map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
            </ol>
          </details>
        )}
      <a href={v.sourceUrl} target="_blank" rel="noreferrer">
        {catalogProviderNames[v.provider]}
      </a>
      {original.success &&
        adopted?.success &&
        adopted.data.sourceUrl !== v.sourceUrl && (
          <>
            {" "}
            ·{" "}
            <a href={adopted.data.sourceUrl} target="_blank" rel="noreferrer">
              {catalogProviderNames[adopted.data.provider]} · 자동 보완 출처
            </a>
          </>
        )}
    </div>
  );
}
