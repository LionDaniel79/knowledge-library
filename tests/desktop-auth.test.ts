import { expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import {
  authorizeDesktop,
  createDesktopToken,
  revokeDesktopToken,
} from "../src/server/desktop-auth";

it("uses owner-bound hashed desktop credentials and enforces scope and revocation", async () => {
  const fixture = await testDatabase();
  try {
    const issued = await createDesktopToken(fixture.db, "desktop-owner-A", "Study PC");
    const stored = (
      await fixture.db.query(
        "SELECT token_hash FROM library_desktop_tokens WHERE owner_id=$1 AND id=$2",
        ["desktop-owner-A", issued.id],
      )
    ).rows[0];
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.token_hash).not.toBe(issued.token);

    const request = new Request("https://library.example.test/api/desktop/catalog/manifests", {
      headers: { Authorization: "Bearer " + issued.token },
    });
    expect(await authorizeDesktop(fixture.db, request, "catalog:read")).toEqual({
      owner: "desktop-owner-A",
      deviceId: issued.id,
    });
    await fixture.db.query(
      "UPDATE library_desktop_tokens SET scopes=ARRAY['catalog:read'] WHERE owner_id=$1 AND id=$2",
      ["desktop-owner-A", issued.id],
    );
    await expect(
      authorizeDesktop(fixture.db, request, "catalog:write"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      revokeDesktopToken(fixture.db, "another-owner", issued.id),
    ).rejects.toMatchObject({ status: 404 });
    await revokeDesktopToken(fixture.db, "desktop-owner-A", issued.id);
    await expect(
      authorizeDesktop(fixture.db, request, "catalog:read"),
    ).rejects.toMatchObject({ status: 401 });
  } finally {
    await fixture.pg.close();
  }
});
