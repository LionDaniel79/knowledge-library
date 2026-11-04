import type { Book } from "@/lib/domain";

const roots = { christian: "기독도서", general: "일반도서" };
export function PdfStorageLocations({ book }: { book: Book }) {
  const raw = book.enrichment?.desktopPdf as
    Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return null;
  const entries = [
    raw,
    ...(Array.isArray(raw.registrations) ? raw.registrations : []),
  ];
  const locations = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.locations))
      continue;
    for (const location of entry.locations) {
      if (
        !location ||
        !Object.hasOwn(roots, location.rootKey) ||
        typeof location.relativePath !== "string"
      )
        continue;
      const path = location.relativePath;
      if (
        !path ||
        path.length > 2048 ||
        /[\x00-\x1f:]|^[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(path)
      )
        continue;
      locations.add(
        roots[location.rootKey as keyof typeof roots] +
          " / " +
          path.replaceAll("\\", "/"),
      );
    }
  }
  if (!locations.size) return null;
  const checked =
    typeof raw.lastCheckedAt === "string" ? Date.parse(raw.lastCheckedAt) : NaN;
  return (
    <section aria-label="PDF 저장 위치" className="pdf-storage-locations">
      <h3>PDF 저장 위치</h3>
      <ul>
        {[...locations].map((path) => (
          <li key={path} style={{ overflowWrap: "anywhere" }}>
            {path}
          </li>
        ))}
      </ul>
      {Number.isFinite(checked) && (
        <p>
          보관 위치 갱신{" "}
          <time dateTime={new Date(checked).toISOString()}>
            {new Date(checked).toLocaleString("ko-KR")}
          </time>
        </p>
      )}
      <p>위치 확인과 PDF 열기는 Windows PDF 서재에서 할 수 있습니다.</p>
    </section>
  );
}
