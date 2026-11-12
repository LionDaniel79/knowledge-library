import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  startDetachedCatalog,
  catalogPassArguments,
} from "./catalog-detached.mjs";

const flush = () => new Promise((done) => setTimeout(done, 15));
const progress = (values = {}) => ({
  at: new Date().toISOString(),
  checked: 10,
  completed: 10,
  pending: 0,
  failed: 0,
  ...values,
});
test("maintenance pause prevents startup and notification-triggered collection", async (t) => {
  const f = fixture(t, { config: { collectionPaused: true } });
  f.notify();
  await flush();
  assert.equal(f.children.length, 0);
  assert.equal(f.controller.status.state, "paused");
});

test("resumes deferred catalog work at its checkpoint without polling or unlimited retries", async (t) => {
  let now = Date.parse("2026-11-12T00:00:00.000Z");
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout(fn, delay) {
      const handle = {};
      timers.set(handle, { fn, delay });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
  };
  const f = fixture(t, { clock });
  for (let retry = 0; retry < 3; retry++) {
    f.children.at(-1).child.finish(
      progress({
        checked: 0,
        completed: 0,
        retryAt: new Date(now + 60000).toISOString(),
      }),
    );
    await flush();
    assert.equal(timers.size, 1);
    const [handle, timer] = [...timers][0];
    assert.equal(timer.delay, 60000);
    timers.delete(handle);
    now += 60000;
    timer.fn();
    await flush();
    assert.equal(f.children.length, retry + 2);
  }
  f.children.at(-1).child.finish(
    progress({
      checked: 0,
      completed: 0,
      retryAt: new Date(now + 60000).toISOString(),
    }),
  );
  await flush();
  assert.equal(timers.size, 0);
  assert.equal(f.controller.status.retryLimitReached, true);
});

test("invalid retry timestamps cannot schedule work and stopping cancels a valid timer", async (t) => {
  const timers = new Map();
  const now = Date.parse("2026-11-12T00:00:00.000Z");
  const clock = {
    now: () => now,
    setTimeout(fn, delay) {
      const h = {};
      timers.set(h, { fn, delay });
      return h;
    },
    clearTimeout(h) {
      timers.delete(h);
    },
  };
  const f = fixture(t, { clock });
  f.children[0].child.finish(
    progress({
      checked: 0,
      completed: 0,
      retryAt: "private invalid timestamp",
    }),
  );
  await flush();
  assert.equal(timers.size, 0);
  f.notify();
  await flush();
  f.children.at(-1).child.finish(
    progress({
      checked: 0,
      completed: 0,
      retryAt: new Date(now + 60000).toISOString(),
    }),
  );
  await flush();
  assert.equal(timers.size, 1);
  await f.controller.stop();
  assert.equal(timers.size, 0);
});

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "catalog-detached-"));
  t.after(() => {
    assert.ok(
      resolve(directory).startsWith(
        resolve(tmpdir()) + sep + "catalog-detached-",
      ),
    );
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "node_modules", "tsx", "dist"), {
    recursive: true,
  });
  writeFileSync(
    join(directory, "scripts", "catalog-supplement-worker.ts"),
    "// synthetic",
  );
  writeFileSync(
    join(directory, "node_modules", "tsx", "dist", "loader.mjs"),
    "// synthetic",
  );
  const notification = join(directory, "catalog-request.json");
  const config = {
    app: directory,
    node: process.execPath,
    profileFile: join(directory, "fake.dpapi.json"),
    dataRoot: directory,
    temp: directory,
    origin: "https://fixture.example.invalid",
    pdfRoot: "Z:/private-pdf-path",
    index: "Z:/private-pdf-index.sqlite",
    python: "Z:/private-python.exe",
  };
  const profile = {
    DATABASE_URL:
      "postgresql://library_web_runtime:fixture-secret@db.example.invalid/library",
    LIBRARY_OWNER_EMAIL: "fixture@example.invalid",
    YES24_API_KEY: "bibliography-fixture",
    NEON_AUTH_BASE_URL: "https://auth.example.invalid",
    NEON_AUTH_COOKIE_SECRET: "login-secret",
    OPENAI_API_KEY: "ai-secret",
    LIBRARY_DEVICE_TOKEN: "device-secret",
    NODE_OPTIONS: "untrusted-options",
  };
  const children = [],
    watches = [],
    statuses = [];
  let unlocks = 0;
  const spawn = (...args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kills = 0;
    child.kill = () => {
      child.kills++;
      child.emit("close", null, "SIGTERM");
      return true;
    };
    child.finish = (stats, code = 0) => {
      if (stats !== undefined)
        child.stdout.write(
          typeof stats === "string" ? stats : JSON.stringify(stats) + "\n",
        );
      child.stdout.end();
      child.emit("close", code, null);
    };
    children.push({ child, args });
    return child;
  };
  const watch = (path, watchOptions, callback) => {
    const watcher = new EventEmitter();
    watcher.closed = false;
    watcher.close = () => {
      watcher.closed = true;
    };
    watches.push({ path, watchOptions, callback, watcher });
    return watcher;
  };
  const configFile = join(directory, "pc-runtime.json");
  if (options.fromFile)
    writeFileSync(configFile, "\uFEFF" + JSON.stringify(config));
  Object.assign(config, options.config ?? {});
  const controller = startDetachedCatalog(
    options.fromFile ? configFile : config,
    notification,
    {
      unlockProfile: () => {
        unlocks++;
        return profile;
      },
      spawn,
      watch,
      debounceMs: 2,
      onStatus: (status) => statuses.push(status),
      ...options,
    },
  );
  t.after(async () => {
    await controller.stop();
  });
  const notify = (requestId = randomUUID(), file = notification) => {
    writeFileSync(
      file,
      JSON.stringify({ requestId, requestedAt: "2026-11-05T00:00:00.000Z" }),
    );
    watches[0].callback("rename", "catalog-request.json");
    return requestId;
  };
  return {
    directory,
    notification,
    config,
    profile,
    controller,
    children,
    watches,
    statuses,
    notify,
    unlocks: () => unlocks,
  };
}

test("starts one finite collector with only bibliography environment and no HTTP launcher", async (t) => {
  const f = fixture(t);
  assert.equal(f.unlocks(), 1);
  assert.equal(f.children.length, 1);
  const [node, args, spawnOptions] = f.children[0].args;
  assert.equal(node, process.execPath);
  assert.equal(
    args.at(-1),
    join(f.config.app, "scripts", "catalog-supplement-worker.ts"),
  );
  assert.ok(!args.includes("--watch"));
  assert.ok(
    !args.some(
      (value) =>
        String(value).includes("start-private-pc.mjs") ||
        String(value).includes("next/dist"),
    ),
  );
  assert.equal(spawnOptions.windowsHide, true);
  assert.equal(spawnOptions.shell, false);
  assert.deepEqual(spawnOptions.stdio, ["ignore", "pipe", "ignore"]);
  assert.equal(spawnOptions.env.DATABASE_URL, f.profile.DATABASE_URL);
  assert.equal(spawnOptions.env.YES24_API_KEY, f.profile.YES24_API_KEY);
  for (const key of [
    "NEON_AUTH_BASE_URL",
    "NEON_AUTH_COOKIE_SECRET",
    "OPENAI_API_KEY",
    "LIBRARY_DEVICE_TOKEN",
    "LIBRARY_PDF_ROOT",
    "LIBRARY_PDF_INDEX",
    "LIBRARY_PYTHON",
    "NODE_OPTIONS",
  ])
    assert.equal(spawnOptions.env[key], undefined, key);
  assert.ok(!JSON.stringify(args).includes("fixture-secret"));
  assert.ok(!JSON.stringify(args).includes(f.config.pdfRoot));
  f.children[0].child.finish(progress({ checked: 0, completed: 0 }));
  await flush();
  assert.equal(f.children.length, 1);
});

test("coalesces actual notifications and ignores duplicate or unrelated filesystem events", async (t) => {
  const f = fixture(t, { startup: false });
  assert.equal(f.children.length, 0);
  const id = f.notify();
  f.notify(id);
  f.watches[0].callback("change", "unrelated.json");
  await flush();
  assert.equal(f.children.length, 1);
  f.children[0].child.finish(progress({ checked: 1, completed: 1 }));
  f.notify(id);
  await flush();
  assert.equal(f.children.length, 1);
  f.notify();
  await flush();
  assert.equal(f.children.length, 2);
});

test("accepts an existing BOM-prefixed runtime JSON without opening a real profile", async (t) => {
  const f = fixture(t, { startup: false, fromFile: true });
  assert.equal(f.unlocks(), 1);
  f.notify();
  await flush();
  assert.equal(f.children.length, 1);
  assert.equal(f.children[0].args[2].cwd, f.config.app);
});

test("does not run for malformed, oversized or secret-bearing notifications", async (t) => {
  const f = fixture(t, { startup: false });
  for (const value of [
    "not JSON",
    "x".repeat(4097),
    JSON.stringify({
      requestId: randomUUID(),
      requestedAt: new Date().toISOString(),
      token: "secret-token",
    }),
  ]) {
    writeFileSync(f.notification, value);
    f.watches[0].callback("change", "catalog-request.json");
    await flush();
    assert.equal(f.children.length, 0);
  }
});

test("drains finite progress batches and coalesces a running request after the drain", async (t) => {
  const f = fixture(t);
  f.notify();
  f.notify();
  await flush();
  assert.equal(f.children.length, 1);
  f.children[0].child.finish(progress());
  await flush();
  assert.equal(f.children.length, 2);
  f.children[1].child.finish(progress({ checked: 3, completed: 3 }));
  await flush();
  assert.equal(f.children.length, 3);
  f.children[2].child.finish(progress({ checked: 0, completed: 0 }));
  await flush();
  assert.equal(f.children.length, 3);
});

test("stops draining on no progress, failures, nonzero exits, malformed stats and oversized stdout", async (t) => {
  const f = fixture(t, { startup: false });
  const cases = [
    [progress({ completed: 0, pending: 10 }), 0],
    [progress({ failed: 1 }), 0],
    [progress(), 1],
    ["{not valid json}\n", 0],
    [JSON.stringify({ ...progress(), unexpected: "secret-token" }), 0],
    [progress({ at: "Thu, 01 Jan 2026 00:00:00 GMT (secret-token)" }), 0],
    ["x".repeat(65537) + "\n" + JSON.stringify(progress()), 0],
  ];
  for (const [stats, code] of cases) {
    f.notify();
    await flush();
    const count = f.children.length;
    f.children.at(-1).child.finish(stats, code);
    await flush();
    assert.equal(f.children.length, count);
  }
  const status = JSON.stringify(f.statuses);
  for (const forbidden of [
    "secret-token",
    "fixture-secret",
    "login-secret",
    "ai-secret",
    f.config.pdfRoot,
  ])
    assert.ok(!status.includes(forbidden));
});

test("caps a single finite drain at 1000 passes and waits for a new notification", async (t) => {
  const f = fixture(t);
  for (let pass = 0; pass < 1000; pass++) {
    assert.equal(f.children.length, pass + 1);
    f.children.at(-1).child.finish(progress());
    await Promise.resolve();
  }
  await flush();
  assert.equal(f.children.length, 1000);
  assert.equal(f.controller.status.limitReached, true);
  f.notify();
  await flush();
  assert.equal(f.children.length, 1001);
});

test("spawn failure does not restart until a changed notification arrives", async (t) => {
  const f = fixture(t);
  f.children[0].child.emit(
    "error",
    new Error("secret-token connection string private path"),
  );
  await flush();
  assert.equal(f.children.length, 1);
  f.notify();
  await flush();
  assert.equal(f.children.length, 2);
  assert.ok(!JSON.stringify(f.statuses).includes("secret-token"));
});

test("abort cancels the watcher, active child, queued notification and future drain", async (t) => {
  const abort = new AbortController();
  const f = fixture(t, { signal: abort.signal });
  f.notify();
  await flush();
  abort.abort();
  await f.controller.done;
  assert.equal(f.watches[0].watcher.closed, true);
  assert.equal(f.children[0].child.kills, 1);
  f.notify();
  await flush();
  assert.equal(f.children.length, 1);
  assert.equal(f.controller.status.state, "stopped");
});

test("real filesystem watcher notices atomic replacement without polling", async (t) => {
  const { watch } = await import("node:fs");
  const f = fixture(t, { startup: false, watch, debounceMs: 5 });
  const temporary = join(f.directory, "catalog-request.tmp");
  writeFileSync(
    temporary,
    JSON.stringify({
      requestId: randomUUID(),
      requestedAt: new Date().toISOString(),
    }),
  );
  renameSync(temporary, f.notification);
  for (let attempt = 0; attempt < 100 && !f.children.length; attempt++)
    await flush();
  assert.equal(f.children.length, 1);
});

test("one-shot wrapper emits only a fresh finite worker checkpoint and rejects stale/future checkpoints", (t) => {
  const f = fixture(t, { startup: false });
  const cache = join(f.directory, "cache");
  mkdirSync(join(cache, "supplement"), { recursive: true });
  const worker = join(f.directory, "scripts", "catalog-supplement-worker.ts");
  const checkpoint = join(cache, "supplement", "status.json");
  const args = catalogPassArguments(f.config);
  const run = () =>
    spawnSync(process.execPath, args, {
      cwd: f.directory,
      windowsHide: true,
      shell: false,
      encoding: "utf8",
      timeout: 10000,
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        CATALOG_CACHE_DIR: cache,
      },
    });
  writeFileSync(
    worker,
    `import {writeFileSync} from 'node:fs';import {join} from 'node:path';writeFileSync(join(process.env.CATALOG_CACHE_DIR,'supplement','status.json'),JSON.stringify({at:new Date().toISOString(),checked:3,completed:3,pending:0,failed:0}));`,
  );
  const fresh = run();
  assert.equal(fresh.status, 0);
  assert.equal(JSON.parse(fresh.stdout).checked, 3);
  writeFileSync(
    worker,
    "// finite worker fixture intentionally leaves no new checkpoint",
  );
  for (const at of ["2000-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z"]) {
    writeFileSync(checkpoint, JSON.stringify(progress({ at })));
    const stale = run();
    assert.equal(stale.status, 1);
    assert.equal(stale.stdout, "");
  }
  writeFileSync(worker, "throw Error('must-not-log-connection-secret');");
  const failed = run();
  assert.equal(failed.status, 1);
  assert.ok(
    !(failed.stdout + failed.stderr).includes("must-not-log-connection-secret"),
  );
});
