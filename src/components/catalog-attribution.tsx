import { catalogSelection } from "@/lib/catalog-selection";
import { catalogProviderNames } from "@/lib/book-lookup";
export function CatalogAttribution({
  value,
  compact = false,
}: {
  value: unknown;
  compact?: boolean;
}) {
  const result = catalogSelection.safeParse(value);
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
      <a href={v.sourceUrl} target="_blank" rel="noreferrer">
        {catalogProviderNames[v.provider]}
      </a>
    </div>
  );
}
