import { afterEach, expect, it, vi } from "vitest";
import { failure } from "../src/server/http";
import { LibraryError } from "../src/server/library-store";

afterEach(() => vi.restoreAllMocks());
it("identifies a permission failure only for exact known application objects", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  failure(
    Object.assign(
      new Error("permission denied for view library_active_books"),
      { code: "42501" },
    ),
  );
  expect(log).toHaveBeenLastCalledWith("Library request failed", {
    name: "Error",
    code: "42501",
    object: "library_active_books",
  });
  for (const message of [
    "permission denied for table library_private_note_text",
    "permission denied for view library_active_books: private note text",
    "private SQL mentions library_active_books",
  ]) {
    failure(Object.assign(new Error(message), { code: "42501" }));
    expect(log).toHaveBeenLastCalledWith("Library request failed", {
      name: "Error",
      code: "42501",
    });
  }
});
it("logs safe database diagnostics without exposing SQL or personal record content", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = Object.assign(
    new Error("private note text and SQL parameters"),
    {
      code: "23503",
      table: "library_notes",
      constraint: "library_notes_book_id_fkey",
      detail: "private owner and note content",
      query: "private SQL",
      parameters: ["secret"],
    },
  );
  const response = failure(error);
  expect(response.status).toBe(500);
  expect(log).toHaveBeenCalledWith("Library request failed", {
    name: "Error",
    code: "23503",
  });
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret/);
  expect(await response.json()).toEqual({
    error:
      "저장소에 연결하지 못했습니다. 입력 내용은 그대로 두고 다시 시도해 주세요.",
  });
});
it("does not log arbitrary schema identifiers even when they look like library names", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  failure(
    Object.assign(new Error("private"), {
      code: "42501",
      table: "library_private_note_text",
      constraint: "library_private_owner_value",
    }),
  );
  expect(log).toHaveBeenCalledWith("Library request failed", {
    name: "Error",
    code: "42501",
  });
});
it("omits unrecognized diagnostic values and keeps expected errors unchanged", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  failure(
    Object.assign(new Error("private"), {
      code: "token=secret",
      table: "private data",
      constraint: "personal@example.com",
    }),
  );
  expect(log).toHaveBeenCalledWith("Library request failed", { name: "Error" });
  log.mockClear();
  expect(failure(new LibraryError(409, "다시 확인해 주세요.")).status).toBe(
    409,
  );
  expect(log).not.toHaveBeenCalled();
});
