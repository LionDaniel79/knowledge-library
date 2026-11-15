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
} from "../lib/unified-book-information";
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
