import { expect, it } from "vitest";
import { authorize, validateWriteOrigin } from "../src/server/access";
it("denies missing sessions and accounts outside the private library", () => {
  expect(() => authorize(null, "owner@example.com")).toThrow();
  expect(() =>
    authorize(
      { id: "2", email: "other@example.com", emailVerified: true },
      "owner@example.com",
    ),
  ).toThrow();
  expect(() =>
    authorize(
      { id: "1", email: "owner@example.com", emailVerified: false },
      "owner@example.com",
    ),
  ).toThrow();
  expect(
    authorize(
      { id: "1", email: "owner@example.com", emailVerified: true },
      "owner@example.com",
    ),
  ).toBe("1");
});
it("fails closed when the owner's email is not configured", () => {
  expect(() =>
    authorize({ id: "1", email: "owner@example.com", emailVerified: true }, ""),
  ).toThrow();
});
it("rejects cross-origin or missing-origin cookie-authenticated writes", () => {
  expect(() =>
    validateWriteOrigin(
      new Request("http://localhost:3000/api/library", {
        headers: { origin: "https://evil.example" },
      }),
      "http://localhost:3000",
    ),
  ).toThrow();
  expect(() =>
    validateWriteOrigin(
      new Request("http://localhost:3000/api/library"),
      "http://localhost:3000",
    ),
  ).toThrow();
  expect(() =>
    validateWriteOrigin(
      new Request("http://localhost:3000/api/library", {
        headers: { origin: "http://localhost:3000" },
      }),
      "http://localhost:3000",
    ),
  ).not.toThrow();
});
