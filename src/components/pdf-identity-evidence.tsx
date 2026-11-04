import { z } from "zod";
const identitySchema = z.object({
  documentId: z.string().uuid(),
  signature: z.string(),
  isbn: z.string(),
  evidence: z
    .array(
      z.object({ pageNumber: z.number().int().positive(), quote: z.string() }),
    )
    .max(20),
});
export function PdfIdentityEvidence({ value }: { value: unknown }) {
  const parsed = identitySchema.safeParse(value);
  if (!parsed.success) return null;
  const identity = parsed.data;
  return (
    <details className="curation-details">
      <summary>PDF 판본 확인 근거</summary>
      <p>
        PDF의 ISBN과 도서관 제목을 자동 대조해 보완했습니다. 판본이 다르면 책
        정보의 ‘수정’에서 변경할 수 있습니다.
      </p>
      <p>ISBN {identity.isbn}</p>
      {identity.evidence.map((e) => (
        <div key={e.pageNumber}>
          <span>PDF {e.pageNumber}쪽에서 확인</span>
          <blockquote>{e.quote}</blockquote>
        </div>
      ))}
    </details>
  );
}
