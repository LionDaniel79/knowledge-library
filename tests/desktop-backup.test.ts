import { it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createDesktopToken } from "../src/server/desktop-auth";
import { upsertDesktopLibrary } from "../src/server/desktop-library";
import {
  createLibraryBackup,
  restoreLibraryBackup,
} from "../src/server/library-backup";
afterEach(() => vi.unstubAllEnvs());
it("backs up and restores desktop resource identity, selected PDF registry and source provenance without authentication secrets", async () => {
  const origin = await testDatabase(),
    dest = await testDatabase();
  try {
    vi.stubEnv("LIBRARY_STAGE5_WRITE_ENABLED", "true");
    const device = await createDesktopToken(origin.db, "owner", "test device");
    const result = await upsertDesktopLibrary(
      origin.db,
      { owner: "owner", deviceId: device.id },
      {
        requestId: randomUUID(),
        action: "upsert",
        items: [
          {
            resourceId: randomUUID(),
            metadata: { title: "보존할 서지" },
            locations: [{ rootKey: "christian", relativePath: "도서.pdf" }],
          },
        ],
      },
    );
    const book = result.items[0].bookId;
    await origin.db.query(
      "INSERT INTO library_book_sources(owner_id,source_kind,resource_id,book_id,license_kind) VALUES('owner','Logos','sample-provenance',$1,'permanent')",
      [book],
    );
    await origin.db.query(
      "INSERT INTO library_cover_locations(owner_id,book_id,storage_kind,object_key,verification_status) VALUES('owner',$1,'external','https://example.invalid/source','verified')",
      [book],
    );
    await origin.db.query(
      "INSERT INTO library_desktop_scan_status(owner_id,device_id,scan_id,completed_at,roots) VALUES('owner',$1,$2,now(),'[]'::jsonb)",
      [device.id, randomUUID()],
    );
    await origin.db.query(
      "INSERT INTO library_desktop_document_blocks(owner_id,document_id,book_id,plan_hash) VALUES('owner',$1,$2,$3)",
      [randomUUID(), randomUUID(), "a".repeat(64)],
    );
    const saved = await createLibraryBackup(origin.db, "owner");
    expect((saved.tables as any).library_desktop_resources).toHaveLength(1);
    expect((saved.tables as any).library_book_sources).toHaveLength(1);
    expect((saved.tables as any).library_cover_locations).toHaveLength(1);
    expect((saved.tables as any).library_pdf_registry).toHaveLength(1);
    expect((saved.tables as any).library_desktop_scan_status).toHaveLength(1);
    expect((saved.tables as any).library_desktop_document_blocks).toHaveLength(
      1,
    );
    expect(JSON.stringify(saved)).not.toContain(device.token);
    expect(Object.keys(saved.tables)).not.toContain("library_desktop_tokens");
    await restoreLibraryBackup(dest.db, "restored", saved);
    expect((await createLibraryBackup(dest.db, "restored")).tables).toEqual(
      saved.tables,
    );
  } finally {
    await origin.pg.close();
    await dest.pg.close();
  }
});
