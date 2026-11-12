import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeEnvironment } from "./runtime-profile.mjs";
import { catalogWorkerEnvironment } from "./catalog-worker.mjs";

const configuration = {
  app: "D:/library/releases/current",
  dataRoot: "E:/library-data",
  temp: "E:/library-data/tmp",
};
const profile = {
  DATABASE_URL: "postgresql://library_web_runtime:fixture@db.example/db",
  LIBRARY_OWNER_EMAIL: "owner@example.invalid",
  LIBRARY_CATALOG_OWNER_ID: "11111111-1111-4111-8111-111111111111",
  YES24_API_KEY: "fixture",
};

test("registered-IP limits survive both detached environment boundaries", () => {
  const env = catalogWorkerEnvironment(
    runtimeEnvironment(
      {
        ...configuration,
        DATA4LIBRARY_IP_REGISTERED: "true",
        DATA4LIBRARY_DAILY_LIMIT: "30000",
      },
      profile,
    ),
  );
  assert.equal(env.DATA4LIBRARY_IP_REGISTERED, "true");
  assert.equal(env.DATA4LIBRARY_DAILY_LIMIT, "30000");
});

test("detached collectors need no web login, PDF paths, or private PC origin", () => {
  const environment = runtimeEnvironment(configuration, profile);
  assert.equal(environment.DATABASE_URL, profile.DATABASE_URL);
  assert.equal(environment.LIBRARY_OWNER_EMAIL, profile.LIBRARY_OWNER_EMAIL);
  assert.equal(
    environment.LIBRARY_CATALOG_OWNER_ID,
    profile.LIBRARY_CATALOG_OWNER_ID,
  );
  assert.equal(environment.YES24_API_KEY, "fixture");
  assert.equal(environment.TEMP, configuration.temp);
  for (const key of [
    "APP_ORIGIN",
    "LIBRARY_PC_ORIGIN",
    "LIBRARY_PC_PRIVATE_CONFIRMED",
    "LIBRARY_PDF_ROOT",
    "LIBRARY_PDF_INDEX",
    "LIBRARY_PYTHON",
  ])
    assert.equal(environment[key], undefined, key);
});

test("stored login and AI secrets cannot enter the detached environment", () => {
  const environment = runtimeEnvironment(configuration, {
    ...profile,
    NEON_AUTH_BASE_URL: "https://auth.example.invalid",
    NEON_AUTH_COOKIE_SECRET: "login-secret",
    OPENAI_API_KEY: "ai-secret",
    NODE_OPTIONS: "--inspect",
  });
  for (const key of [
    "NEON_AUTH_BASE_URL",
    "NEON_AUTH_COOKIE_SECRET",
    "OPENAI_API_KEY",
    "NODE_OPTIONS",
  ])
    assert.equal(environment[key], undefined, key);
});

test("administrator database connections and missing owner settings fail closed", () => {
  assert.throws(() =>
    runtimeEnvironment(configuration, {
      ...profile,
      DATABASE_URL: "postgresql://neondb_owner:fixture@db.example/db",
    }),
  );
  assert.throws(() =>
    runtimeEnvironment(configuration, {
      ...profile,
      LIBRARY_OWNER_EMAIL: "",
    }),
  );
});

test("catalog worker receives bibliography keys without other account credentials", () => {
  const environment = catalogWorkerEnvironment({
    ...runtimeEnvironment(configuration, profile),
    DATA4LIBRARY_KEY: "library-fixture",
    DATABASE_URL_UNPOOLED: "must-not-inherit",
    OPENAI_API_KEY: "must-not-inherit",
  });
  assert.equal(environment.DATA4LIBRARY_KEY, "library-fixture");
  assert.equal(environment.DATABASE_URL_UNPOOLED, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
});
