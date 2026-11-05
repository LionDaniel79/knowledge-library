import { expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import { applyLogos, previewLogos } from "../src/server/logos-import";
import { saveVerifiedLogosCover } from "../src/server/logos-cover";

it("imports only eligible Logos books by stable Resource ID and saves confirmed covers when Stage 5 is explicitly enabled", async () => {
  const fixture = await testDatabase();
  const owner = "logos-stage4-apply-owner";
  const previous = process.env.LIBRARY_STAGE5_WRITE_ENABLED;
  const row = (
    resourceId: string,
    title: string,
    resourceType: "성경 주석" | "단행본",
    license: "permanent" | "temporary",
  ) => ({
    resourceId,
    title,
    resourceType,
    license,
    author: "Sample Author",
    publisher: "Sample Publisher",
    series: "",
    language: "English",
    publicationDate: "2024",
    edition: "Logos 연구",
  });
  const data = {
    items: [
      row("LLS:STAGE4-COMMENT", "Commentary fixture", "성경 주석", "permanent"),
      row("LLS:STAGE4-BOOK", "Book fixture", "단행본", "temporary"),
    ],
  };
  try {
    delete process.env.LIBRARY_STAGE5_WRITE_ENABLED;
    await expect(applyLogos(fixture.db, owner, data)).rejects.toMatchObject({
      status: 403,
    });
    expect(
      (
        await fixture.db.query(
          "SELECT count(*)::int AS n FROM library_books WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(0);

    process.env.LIBRARY_STAGE5_WRITE_ENABLED = "true";
    const first = await applyLogos(fixture.db, owner, data);
    expect(first).toMatchObject({ received: 2, created: 2 });
    const second = await applyLogos(fixture.db, owner, data);
    expect(second).toMatchObject({
      received: 2,
      created: 0,
      alreadyImported: 2,
    });
    const sources = (
      await fixture.db.query(
        "SELECT s.resource_id,s.license_kind,s.source_metadata->>'resourceType' AS type,b.id,b.source_data->>'app' AS app,b.formats FROM library_book_sources s JOIN library_books b ON b.owner_id=s.owner_id AND b.id=s.book_id WHERE s.owner_id=$1 ORDER BY s.resource_id",
        [owner],
      )
    ).rows;
    expect(sources.map((s) => s.license_kind).sort()).toEqual([
      "permanent",
      "temporary",
    ]);
    expect(sources.map((s) => s.type).sort()).toEqual(
      ["단행본", "성경 주석"].sort(),
    );
    expect(
      sources.every((s) => s.app === "Logos" && s.formats.includes("ebook")),
    ).toBe(true);
    expect((await previewLogos(fixture.db, owner, data)).alreadyImported).toBe(
      2,
    );

    await expect(
      applyLogos(fixture.db, owner, {
        items: [
          {
            ...data.items[0],
            resourceId: "LLS:OUT-OF-SCOPE",
            resourceType: "인터랙티브",
          },
        ],
      }),
    ).rejects.toThrow();
    expect(
      (
        await fixture.db.query(
          "SELECT count(*)::int AS n FROM library_book_sources WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(2);

    const book = sources.find((s) => s.resource_id === "LLS:STAGE4-BOOK")!;
    const coverUrl = "https://covers.logoscdn.com/sample/test.jpg";
    const validImage = async () => Buffer.from("validated-image-fixture");
    const cover = await saveVerifiedLogosCover(
      fixture.db,
      owner,
      {
        bookId: book.id,
        expectedVersion: 1,
        coverUrl,
        verification: "manual",
        origin: "user",
      },
      validImage,
    );
    expect(cover).toMatchObject({ bookId: book.id, version: 2, coverUrl });
    const saved = (
      await fixture.db.query(
        "SELECT storage_kind,object_key,verification_status FROM library_cover_locations WHERE owner_id=$1 AND book_id=$2",
        [owner, book.id],
      )
    ).rows[0];
    expect(saved).toMatchObject({
      storage_kind: "external",
      object_key: coverUrl,
      verification_status: "manual",
    });
    await expect(
      saveVerifiedLogosCover(
        fixture.db,
        owner,
        {
          bookId: book.id,
          expectedVersion: 1,
          coverUrl,
          verification: "manual",
          origin: "user",
        },
        validImage,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      saveVerifiedLogosCover(
        fixture.db,
        "another-owner",
        {
          bookId: book.id,
          expectedVersion: 2,
          coverUrl,
          verification: "manual",
          origin: "user",
        },
        validImage,
      ),
    ).rejects.toMatchObject({ status: 404 });
    // Ensure a different owner cannot copy the same stable Resource ID by accident:
    // source keys are owner-scoped, so their legitimate import remains independent.
    expect(
      (
        await applyLogos(fixture.db, "another-owner", {
          items: [data.items[0]],
        })
      ).created,
    ).toBe(1);
  } finally {
    if (previous === undefined) delete process.env.LIBRARY_STAGE5_WRITE_ENABLED;
    else process.env.LIBRARY_STAGE5_WRITE_ENABLED = previous;
    await fixture.pg.close();
  }
});
