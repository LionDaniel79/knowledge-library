import { expect, it, vi } from "vitest";
import { resolveLogosOwner } from "../src/server/logos-completion";

const id = "11111111-1111-4111-8111-111111111111";
it("uses the private operator owner ID without reading authentication tables", async () => {
  const query = vi.fn();
  expect(await resolveLogosOwner({ query }, { id })).toBe(id);
  expect(query).not.toHaveBeenCalled();
});
it("rejects a malformed configured ID without falling back to auth access", async () => {
  const query = vi.fn();
  await expect(
    resolveLogosOwner(
      { query },
      { id: "invalid", email: "fixture@example.invalid" },
    ),
  ).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});
it("keeps the existing parameterized email lookup for older operator installations", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ id }] });
  expect(
    await resolveLogosOwner({ query }, { email: "fixture@example.invalid" }),
  ).toBe(id);
  expect(query.mock.calls[0][1]).toEqual(["fixture@example.invalid"]);
});
it("refuses an unknown legacy owner", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  await expect(
    resolveLogosOwner({ query }, { email: "fixture@example.invalid" }),
  ).rejects.toThrow();
});
