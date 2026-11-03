import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { testDatabase } from "./helpers/database";
import { createDesktopToken } from "../src/server/desktop-auth";
import { desktopItemsDigest } from "../src/lib/desktop-catalog-contract";

const fake = vi.hoisted(() => ({ db: null as any }));
vi.mock("@/server/db", () => ({
  database: {
    query: (sql: string, params?: unknown[]) => fake.db.query(sql, params),
    transaction: (fn: unknown) => fake.db.transaction(fn),
  },
}));

import { POST as startRoute } from "../src/app/api/desktop/catalog/manifests/route";
import { PUT as itemsRoute } from "../src/app/api/desktop/catalog/manifests/[id]/items/route";
import { POST as sealRoute } from "../src/app/api/desktop/catalog/manifests/[id]/seal/route";
import { POST as previewRoute } from "../src/app/api/desktop/catalog/manifests/[id]/preview/route";

const base = "https://stage5-test.invalid/api/desktop/catalog/manifests";
function req(
  url: string,
  method: "POST" | "PUT",
  payload: unknown,
  credential?: string,
) {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(credential ? { authorization: "Bearer " + credential } : {}),
    },
    body: JSON.stringify(payload),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

it("routes an authenticated desktop manifest through start/items/seal/preview without applying a PDF transition", async () => {
  const fixture = await testDatabase();
  fake.db = fixture.db;
  try {
    const owner = "desktop-http-stage5-qa";
    const bookId = randomUUID();
    const documentId = randomUUID();
    const operationId = randomUUID();
    await fixture.db.query(
      "INSERT INTO library_books(id,owner_id,title,author,formats,source_key,source_data) VALUES($1,$2,'Stage5 synthetic PDF','QA',ARRAY['pdf'],'stage5-http-pdf',$3::jsonb)",
      [bookId, owner, JSON.stringify({ app: "Local PDF", recordId: documentId })],
    );
    await fixture.db.query(
      "INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns,processing_scope,material_kind,scope_reason,scope_version) VALUES($1,$2,$3,'synthetic','test.pdf','기독도서/test.pdf',1,'1','full','book','','v1')",
      [documentId, owner, bookId],
    );
    const token = await createDesktopToken(fixture.db, owner, "QA device");
    const start = {
      operationId,
      scanComplete: true,
      rootsAvailable: true,
      physicalByRoot: { christian: 1, general: 0 },
      expectedDocuments: 1,
    };
    expect((await startRoute(req(base, "POST", start))).status).toBe(401);

    const created = await startRoute(req(base, "POST", start, token.token));
    expect(created.status).toBe(200);
    const begin = await created.json();
    expect(begin).toMatchObject({ operationId, status: "collecting" });
    const reused = await startRoute(req(base, "POST", start, token.token));
    expect((await reused.json()).manifestId).toBe(begin.manifestId);

    const url = base + "/" + begin.manifestId;
    const item = {
      legacyDocumentId: documentId,
      bookId,
      expectedBookVersion: 1,
      copiesByRoot: { christian: 1, general: 0 },
    };
    const rejected = await itemsRoute(
      req(url + "/items", "PUT", { items: [{ ...item, path: "E:\\private.pdf" }] }, token.token),
      params(begin.manifestId),
    );
    expect(rejected.status).toBe(400);

    const added = await itemsRoute(
      req(url + "/items", "PUT", { items: [item] }, token.token),
      params(begin.manifestId),
    );
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ accepted: 1, created: 1 });

    const replay = await itemsRoute(
      req(url + "/items", "PUT", { items: [item] }, token.token),
      params(begin.manifestId),
    );
    expect(await replay.json()).toMatchObject({ accepted: 1, created: 0 });
    const changed = await itemsRoute(
      req(url + "/items", "PUT", { items: [{ ...item, expectedBookVersion: 2 }] }, token.token),
      params(begin.manifestId),
    );
    expect(changed.status).toBe(409);

    const mismatch = await sealRoute(
      req(url + "/seal", "POST", { itemsDigest: "0".repeat(64) }, token.token),
      params(begin.manifestId),
    );
    expect(mismatch.status).toBe(409);

    const digest = desktopItemsDigest([item]);
    const sealed = await sealRoute(
      req(url + "/seal", "POST", { itemsDigest: digest }, token.token),
      params(begin.manifestId),
    );
    expect(sealed.status).toBe(200);
    expect(await sealed.json()).toMatchObject({ status: "sealed", itemsDigest: digest });

    const preview = await previewRoute(
      req(url + "/preview", "POST", {}, token.token),
      params(begin.manifestId),
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      status: "preview",
      selectedDocuments: 1,
      missing: 0,
      versionConflicts: 0,
      canApplySelection: false,
      canDelete: false,
    });
    expect(
      (
        await fixture.db.query(
          "SELECT version FROM library_books WHERE owner_id=$1 AND id=$2",
          [owner, bookId],
        )
      ).rows[0].version,
    ).toBe(1);
    expect(
      (await fixture.db.query("SELECT count(*)::int AS n FROM library_pdf_registry")).rows[0].n,
    ).toBe(0);
    expect(
      (await fixture.db.query("SELECT count(*)::int AS n FROM library_book_exclusions")).rows[0].n,
    ).toBe(0);
    expect(createHash("sha256").update(token.token).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    fake.db = null;
    await fixture.pg.close();
  }
});
