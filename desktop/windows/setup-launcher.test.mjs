import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeEnvironment, serverArguments } from "./start-private-pc.mjs";
const c = {
  app: "D:/new library/releases/a",
  python: "D:/new library/runtime/python/python.exe",
  origin: "https://new-pc.tail123.ts.net",
  pdfRoot: "E:/books",
  index: "E:/data/pdf.sqlite",
  dataRoot: "E:/data",
  temp: "E:/data/tmp",
};
const p = {
  DATABASE_URL: "postgresql://library_web_runtime:fixture@db.example/db",
  NEON_AUTH_BASE_URL: "https://auth.example/auth",
  NEON_AUTH_COOKIE_SECRET: "fixture",
  LIBRARY_OWNER_EMAIL: "owner@example.invalid",
  YES24_API_KEY: "fixture",
  OPENAI_API_KEY: "must-not-inherit",
  NODE_OPTIONS: "must-not-inherit",
};
test("new PC uses its own paths, inherits only library connection fields", () => {
  const env = runtimeEnvironment(c, p);
  assert.equal(env.LIBRARY_PYTHON, c.python);
  assert.equal(env.LIBRARY_PDF_INDEX, c.index);
  assert.equal(env.LIBRARY_PC_ORIGIN, c.origin);
  assert.equal(env.YES24_API_KEY, "fixture");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.TEMP, c.temp);
});
test("server stays bound to loopback without shell arguments", () => {
  assert.deepEqual(serverArguments(c).slice(1), [
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3001",
  ]);
});
test("administrator DB connection is rejected", () =>
  assert.throws(() =>
    runtimeEnvironment(c, {
      ...p,
      DATABASE_URL: "postgresql://neondb_owner:x@db.example/db",
    }),
  ));
test("incomplete connection fails closed", () =>
  assert.throws(() =>
    runtimeEnvironment(c, { ...p, LIBRARY_OWNER_EMAIL: "" }),
  ));
