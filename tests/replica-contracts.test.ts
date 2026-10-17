import { afterAll, beforeAll, expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import {
  syncEntities,
  projectSyncRow,
  syncKey,
  validatePublicRow,
} from "../src/lib/replica/entities";
import {
  syncRevision,
  syncPage,
  parseSyncCursor,
  createSyncCursor,
  VALUE_PART_BYTES,
  MAX_JSON_RESPONSE_BYTES,
} from "../src/lib/replica/contracts";
import {
  encodeSyncValue,
  decodeSyncValue,
  sha256Bytes,
} from "../src/lib/replica/codec";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
it("includes every owner application table and its complete safe column set", async () => {
  const rows = (
    await f.db.query(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'library_%' AND table_name NOT LIKE 'library_active_%' AND table_name IN(SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='owner_id') ORDER BY table_name,ordinal_position",
    )
  ).rows;
  const serverOnly = new Set([
    "library_mcp_codes",
    "library_mcp_tokens",
    "library_assist_workers",
    "library_analysis_workers",
  ]);
  const tables = [...new Set(rows.map((r) => String(r.table_name)))].filter(
    (t) => !serverOnly.has(t),
  );
  expect(Object.keys(syncEntities).sort()).toEqual(tables.sort());
  expect(tables).toHaveLength(38);
  for (const table of tables) {
    const fields = rows
      .filter((r) => r.table_name === table)
      .map((r) => r.column_name)
      .filter((c) => !["owner_id", "token_hash", "lease_token"].includes(c));
    expect(syncEntities[table as keyof typeof syncEntities].columns).toEqual(
      fields,
    );
  }
});
it("strips server credential columns and rejects client injection and unknown fields", () => {
  const value = projectSyncRow("library_analysis_devices", {
    id: "d",
    owner_id: "owner",
    name: "PC",
    token_hash: "secret",
    expires_at: null,
    revoked_at: null,
    last_seen: null,
    created_at: null,
  });
  expect(value).not.toHaveProperty("owner_id");
  expect(value).not.toHaveProperty("token_hash");
  expect(value.name).toBe("PC");
  expect(() =>
    validatePublicRow("library_analysis_devices", {
      ...value,
      token_hash: "secret",
    }),
  ).toThrow();
  expect(() =>
    projectSyncRow("library_books", { id: "b", new_unreviewed_field: "value" }),
  ).toThrow();
  expect(() => validatePublicRow("library_mcp_tokens" as any, {})).toThrow();
});
it("keeps composite keys, owner-only keys, revision precision and cursor ownership", () => {
  expect(
    syncKey("library_annual_metrics", { owner_id: "owner", year: 2026 }),
  ).toBe('["2026"]');
  expect(syncKey("library_ai_policy", { owner_id: "owner" })).toBe("[]");
  expect(syncRevision.parse("9007199254740993")).toBe("9007199254740993");
  expect(() => syncRevision.parse("9223372036854775808")).toThrow();
  expect(() => syncRevision.parse("-1")).toThrow();
  const epoch = "11111111-1111-4111-a111-111111111111";
  const cursor = createSyncCursor({
    owner: "owner",
    epoch,
    after: "9007199254740993",
  });
  expect(parseSyncCursor(cursor, "owner", epoch).after).toBe(
    "9007199254740993",
  );
  expect(() => parseSyncCursor(cursor, "another", epoch)).toThrow();
  expect(() =>
    parseSyncCursor(cursor, "owner", "22222222-2222-4222-a222-222222222222"),
  ).toThrow();
});
it("preserves complete nested original values, Unicode and safe object keys through the codec", async () => {
  const row = JSON.parse(
    '{"id":"x","raw":{"__proto__":{"owned":true},"목차":["첫 장",null,42]},"content":"아버지께 드림"}',
  );
  const encoded = encodeSyncValue(row);
  expect(decodeSyncValue(encoded)).toEqual(row);
  expect(({} as any).owned).toBeUndefined();
  expect(await sha256Bytes(new TextEncoder().encode("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const exact = '{"large":9007199254740993,"cost":0.000000001}';
  expect(new TextDecoder().decode(encodeSyncValue(exact))).toBe(exact);
});
it("bounds transport values by bytes and accepts a complete small row envelope", () => {
  expect(VALUE_PART_BYTES).toBe(192 * 1024);
  expect(MAX_JSON_RESPONSE_BYTES).toBe(512 * 1024);
  const page = {
    epoch: "11111111-1111-4111-a111-111111111111",
    head: "1",
    cursor: "c",
    hasMore: false,
    rows: [
      {
        entity: "library_books",
        key: '["b"]',
        revision: "1",
        deleted: false,
        sha256: "a".repeat(64),
        bytes: 10,
        inline: '{"id":"b"}',
      },
    ],
  };
  expect(syncPage.parse(page)).toEqual(page);
  expect(() =>
    syncPage.parse({
      ...page,
      rows: [
        {
          ...page.rows[0],
          inline: undefined,
          parts: [
            { index: 0, bytes: VALUE_PART_BYTES + 1, sha256: "a".repeat(64) },
          ],
        },
      ],
    }),
  ).toThrow();
});
