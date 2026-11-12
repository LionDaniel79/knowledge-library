import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
export async function pdfCandidateStamp(root: string, b: any) {
  const files: string[] = [];
  for (const provider of ["library", "yes24"]) {
    if (b.isbn)
      files.push(
        join(
          root,
          "isbn",
          createHash("sha256").update(`${provider}:${b.isbn}`).digest("hex") +
            ".json",
        ),
      );
    for (const publisher of [b.publisher, ""])
      files.push(
        join(
          root,
          createHash("sha256")
            .update(
              JSON.stringify([
                "logos-title/v1",
                provider,
                { title: b.title, author: b.author, publisher },
              ]),
            )
            .digest("hex") + ".json",
        ),
      );
  }
  return Promise.all(
    files.map(async (f) => {
      try {
        return f + ":" + (await stat(f)).mtimeMs;
      } catch {
        return f + ":0";
      }
    }),
  );
}
export type PdfProgress = {
  fingerprint: string;
  state: string;
  attempts: number;
  nextAttemptAt: number;
};
export const pdfProgressFingerprint = (
  book: any,
  source: any,
  evidence: any,
  candidatesStamp = "",
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        book.title,
        book.author,
        book.publisher,
        book.isbn,
        book.coverUrl,
        book.category,
        source?.signature,
        source?.sha256,
        source?.status,
        evidence?.candidates,
        evidence?.missingPages,
        evidence?.pendingOcrPages,
        candidatesStamp,
      ]),
    )
    .digest("hex");
export function pdfProgressReady(
  previous: PdfProgress | undefined,
  fingerprint: string,
  now = Date.now(),
) {
  return (
    !previous ||
    previous.fingerprint !== fingerprint ||
    previous.nextAttemptAt <= now
  );
}
export function pdfProgressResult(
  previous: PdfProgress | undefined,
  fingerprint: string,
  state: string,
  now = Date.now(),
): PdfProgress {
  const attempts =
    state === "error"
      ? (previous?.fingerprint === fingerprint ? previous.attempts : 0) + 1
      : 0;
  return {
    fingerprint,
    state,
    attempts,
    nextAttemptAt:
      now +
      (state === "error"
        ? attempts >= 3
          ? 7 * 86400000
          : 60000 * 2 ** (attempts - 1)
        : state === "source_unavailable"
          ? 86400000
          : 7 * 86400000),
  };
}
