import { expect, it, vi } from "vitest";
import { LibraryError } from "../src/server/library-store";
let owner = "";
vi.mock("@/server/auth", () => ({
  requireOwner: async () => {
    if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
    return owner;
  },
}));
import { GET } from "../src/app/api/sync/session/route";
it("returns only the verified owner identifier and never embeds business data or credentials", async () => {
  expect((await GET()).status).toBe(401);
  owner = "owner-id";
  const response = await GET();
  expect(await response.json()).toEqual({ ownerId: owner });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
