import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LibraryError, type Database } from "./library-store";
import { readActiveBook } from "./active-book";
import { withSyncWrite } from "./sync/write";
import { carryCuration } from "./book-curation-history";
import { createCurationStore } from "./curation-store";
import {
  mergeBookInformation,
  currentBookInformation,
  informationValueKey,
  pendingAutomaticFields,
} from "../lib/unified-book-information";
import { displayedBookInformation } from "../lib/book-detail-information";
import { isbn13 } from "../lib/bibliography";
import { editOutlineDraft, pdfOutlineSchema } from "../lib/pdf-outline";
import { editPrintedToc, printedTocSchema } from "../lib/printed-toc";

export async function editBookInformation(
  db: Database,
  owner: string,
  raw: unknown,
) {
  const p = z
    .object({
      action: z.literal("editBookInformation"),
      bookId: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
      changes: z
        .object({
          description: z.string().trim().max(8000).optional(),
          toc: z.string().trim().max(64000).optional(),
          publicationYear: z
            .string()
            .trim()
            .regex(/^(?:\d{4})?$/, "발행연도는 네 자리 숫자로 입력해 주세요.")
            .optional(),
          referenceIsbn: z
            .string()
            .trim()
            .max(30)
            .refine(
              (value) => !value || !!isbn13(value),
              "참고 판본 ISBN을 확인해 주세요.",
            )
            .optional(),
        })
        .strict()
        .refine((value) => Object.keys(value).length > 0),
    })
    .strict()
    .parse(raw);

  return withSyncWrite(db, owner, async (tx) => {
    const book = await readActiveBook(tx, owner, p.bookId, true);
    if (!book) throw new LibraryError(404, "도서를 찾을 수 없습니다.");
    if (Number(book.version) !== p.expectedVersion)
      throw new LibraryError(
        409,
        "도서가 변경되었습니다. 최신 정보를 확인해 주세요.",
      );
    const previous = book.enrichment ?? {};
    const enrichment = { ...previous };
    const fields = Object.keys(p.changes);
    for (const [field, value] of Object.entries(p.changes))
      enrichment["auto_" + field] = value;
    if (p.changes.referenceIsbn)
      enrichment.auto_referenceIsbn = isbn13(p.changes.referenceIsbn);
    if (p.changes.toc) {
      const items = await createCurationStore(tx as Database).list(
        owner,
        "book",
        p.bookId,
      );
      const { toc } = displayedBookInformation(previous, items);
      const printed = printedTocSchema.safeParse(toc);
      const outline = pdfOutlineSchema.safeParse(toc);
      try {
        if (printed.success)
          enrichment.auto_toc = editPrintedToc(printed.data, p.changes.toc);
        else if (outline.success)
          enrichment.auto_toc = editOutlineDraft(outline.data, p.changes.toc);
        else {
          const lines = p.changes.toc
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          if (lines.length > 200 || lines.some((line) => line.length > 300))
            throw Error(
              "목차는 200줄까지, 한 줄에 300자 이내로 입력해 주세요.",
            );
          enrichment.auto_toc = lines;
        }
      } catch (error) {
        throw new LibraryError(
          400,
          error instanceof z.ZodError
            ? "목차의 내용과 쪽수를 확인해 주세요."
            : (error as Error).message,
        );
      }
    }
    const application = previous.autoBibliography;
    const pending = pendingAutomaticFields(application);
    enrichment.autoBibliographyLocks = [
      ...new Set([
        ...(previous.autoBibliographyLocks ?? []),
        ...fields,
        ...pending,
      ]),
    ];
    enrichment.bookInformationEdits = [
      ...new Set([...(previous.bookInformationEdits ?? []), ...fields]),
    ];
    if (pending.length) {
      enrichment.autoBibliography = {
        ...application,
        status: "kept",
        pendingFields: [],
        decisions: {
          ...application.decisions,
          ...Object.fromEntries(pending.map((field) => [field, "keep"])),
        },
        reviewedAt: new Date().toISOString(),
      };
    }
    const version = p.expectedVersion + 1;
    await tx.query(
      "UPDATE library_books SET enrichment=$3,version=$4 WHERE owner_id=$1 AND id=$2",
      [owner, p.bookId, JSON.stringify(enrichment), version],
    );
    await carryCuration(
      tx,
      owner,
      p.bookId,
      String(p.expectedVersion),
      String(version),
    );
    await tx.query(
      "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'editBookInformation',$4,$5)",
      [
        randomUUID(),
        owner,
        p.bookId,
        JSON.stringify(book),
        JSON.stringify({ ...book, version, enrichment }),
      ],
    );
    return { version, enrichment };
  });
}
export async function selectBookInformation(
  db: Database,
  owner: string,
  raw: unknown,
) {
  const p = z
    .object({
      action: z.literal("selectBookField").optional(),
      bookId: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
      field: z.string().min(1).max(100),
      itemId: z.string().min(1).max(100),
      valueKey: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(raw);
  return withSyncWrite(db, owner, async (tx) => {
    const b = await readActiveBook(tx, owner, p.bookId, true);
    if (!b) throw new LibraryError(404, "도서를 찾을 수 없습니다.");
    if (Number(b.version) !== p.expectedVersion)
      throw new LibraryError(
        409,
        "도서가 변경되었습니다. 최신 정보를 확인해 주세요.",
      );
    const items = await createCurationStore(tx as Database).list(
      owner,
      "book",
      p.bookId,
    );
    const field = mergeBookInformation(
      items,
      b.enrichment?.autoBibliography,
      {},
      currentBookInformation(b.enrichment),
    ).find((f) => f.field === p.field);
    const value = field?.values.find(
      (v) =>
        informationValueKey(p.field, v.value) === p.valueKey &&
        (p.itemId === "automatic"
          ? v.automatic
          : p.itemId === "current"
            ? v.current
            : v.itemIds.includes(p.itemId)),
    );
    if (!value)
      throw new LibraryError(
        409,
        "선택한 정보가 변경되었습니다. 다시 비교해 주세요.",
      );
    const enrichment = {
      ...b.enrichment,
      informationSelections: {
        ...b.enrichment?.informationSelections,
        [p.field]: { itemId: p.itemId, valueKey: p.valueKey },
      },
    };
    await tx.query(
      "UPDATE library_books SET enrichment=$3,version=version+1 WHERE owner_id=$1 AND id=$2",
      [owner, p.bookId, JSON.stringify(enrichment)],
    );
    await carryCuration(
      tx,
      owner,
      p.bookId,
      String(b.version),
      String(Number(b.version) + 1),
    );
    await tx.query(
      "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'selectBookInformation',$4,$5)",
      [
        randomUUID(),
        owner,
        p.bookId,
        JSON.stringify(b),
        JSON.stringify({ ...b, enrichment, version: Number(b.version) + 1 }),
      ],
    );
    return {
      version: Number(b.version) + 1,
      informationSelections: enrichment.informationSelections,
    };
  });
}
