import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { startDetachedLogos } from "./logos-detached.mjs";

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const stats = (changes = {}) => ({
  considered: 100,
  requests: 100,
  cached: 0,
  certain: 100,
  review: 0,
  missing: 0,
  applied: 100,
  failed: 0,
  deferred: 0,
  quarantined: 0,
  pending: 0,
  stopped: "complete",
  retryAt: "",
  ...changes,
});
test("maintenance pause preserves checkpoints without starting Logos on notifications", async (t) => {
  const f = fixture(t, { collectionPaused: true });
  await f.notify();
  assert.equal(f.children.length, 0);
  assert.equal(f.controller.status.state, "paused");
});

function fixture(t, changes = {}, extra = {}) {
  const config = {
    app: "C:/synthetic/app",
    node: "C:/synthetic/node.exe",
    dataRoot: "C:/synthetic/data",
    temp: "C:/synthetic/temp",
    origin: "https://invalid.example",
    logosCompletionApproved: true,
    ...changes,
  };
  const profile = {
    DATABASE_URL: "postgresql://library_web_runtime:secret@invalid.example/db",
    LIBRARY_OWNER_EMAIL: "owner@invalid.example",
    LIBRARY_CATALOG_OWNER_ID: "11111111-1111-4111-8111-111111111111",
    YES24_API_KEY: "provider-secret",
    NEON_AUTH_BASE_URL: "https://invalid.example/auth",
    NEON_AUTH_COOKIE_SECRET: "auth-secret",
    OPENAI_API_KEY: "ai-secret",
    LIBRARY_STAGE5_WRITE_ENABLED: "hostile",
    NODE_OPTIONS: "--inspect",
  };
  let now = Date.parse("2026-11-05T00:00:00.000Z"),
    id = 0,
    notification,
    callback;
  const timers = new Map(),
    children = [],
    reports = [],
    watches = [];
  const clock = {
    now: () => now,
    setTimeout(fn, delay) {
      const handle = ++id;
      timers.set(handle, { fn, due: now + delay });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
  };
  const advance = async (ms) => {
    now += ms;
    for (const [handle, timer] of [...timers])
      if (timer.due <= now) {
        timers.delete(handle);
        timer.fn();
      }
    await tick();
  };
  const fs = {
    existsSync: () => true,
    readFileSync: () => notification,
    openSync: () => 1,
    closeSync() {},
    readSync(_fd, bytes) {
      return Buffer.from(notification ?? "").copy(bytes);
    },
    lstatSync: () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      nlink: 1,
      size: Buffer.byteLength(notification ?? ""),
    }),
    watch(path, options, fn) {
      callback = fn;
      const watcher = new EventEmitter();
      watcher.close = () => {
        watcher.closed = true;
      };
      watches.push(watcher);
      return watcher;
    },
  };
  const spawn = (...args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.pid = 1;
    child.kill = () => {
      child.killed = true;
      child.emit("close", null, "SIGTERM");
    };
    child.finish = (value = stats(), code = 0) => {
      if (value !== null)
        child.stdout.write(
          typeof value === "string" ? value : JSON.stringify(value) + "\n",
        );
      child.emit("close", code, null);
    };
    children.push({ child, args });
    return child;
  };
  const controller = startDetachedLogos(
    config,
    "C:/synthetic/state/catalog-request.json",
    {
      fs,
      clock,
      spawn,
      unlockProfile: () => profile,
      debounceMs: 10,
      terminate: (child) => child.kill(),
      onStatus: (value) => reports.push(value),
      ...extra,
    },
  );
  t.after(() => controller.stop());
  const notify = async (
    requestId = "12345678-1234-1234-1234-123456789012",
    event = "rename",
    filename = "catalog-request.json",
  ) => {
    notification = JSON.stringify({
      requestId,
      requestedAt: new Date(now).toISOString(),
    });
    callback(event, filename);
    await advance(10);
  };
  return {
    config,
    profile,
    controller,
    children,
    reports,
    watches,
    timers,
    advance,
    notify,
    fs,
    setNotification: (value) => {
      notification = value;
    },
    callback: (...args) => callback(...args),
  };
}

test("requires explicit approval before decrypting or spawning", (t) => {
  for (const value of [undefined, false, "true", 1]) {
    let decrypted = false;
    assert.throws(
      () =>
        fixture(
          t,
          { logosCompletionApproved: value },
          {
            unlockProfile() {
              decrypted = true;
              throw Error("secret");
            },
          },
        ),
      /configuration unavailable/,
    );
    assert.equal(decrypted, false);
  }
});

test("runs one finite approved pass with child-only minimal environment and no HTTP", (t) => {
  const before = process.env.LIBRARY_STAGE5_WRITE_ENABLED;
  const f = fixture(t);
  const [node, args, options] = f.children[0].args;
  assert.equal(node, f.config.node);
  assert.deepEqual(args.slice(-5), [
    join(f.config.app, "scripts", "complete-logos.ts"),
    "--online",
    "--apply",
    "--limit",
    "100",
  ]);
  assert.equal(args[0], "--import");
  assert.equal(options.env.LIBRARY_STAGE5_WRITE_ENABLED, "true");
  assert.equal(options.env.DATABASE_URL, f.profile.DATABASE_URL);
  assert.equal(
    options.env.LIBRARY_CATALOG_OWNER_ID,
    f.profile.LIBRARY_CATALOG_OWNER_ID,
  );
  for (const key of [
    "NODE_OPTIONS",
    "OPENAI_API_KEY",
    "NEON_AUTH_COOKIE_SECRET",
    "NEON_AUTH_BASE_URL",
    "LIBRARY_PDF_ROOT",
    "LIBRARY_DEVICE_TOKEN",
  ])
    assert.equal(options.env[key], undefined);
  assert.equal(process.env.LIBRARY_STAGE5_WRITE_ENABLED, before);
  assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
});

test("continues useful finite passes and then idles without a polling timer", async (t) => {
  const f = fixture(t);
  f.children[0].child.finish(stats({ pending: 120 }));
  await tick();
  assert.equal(f.children.length, 2);
  f.children[1].child.finish(stats({ pending: 0 }));
  await tick();
  assert.equal(f.controller.status.state, "idle");
  assert.equal(f.timers.size, 0);
  await f.advance(8 * 86400000);
  assert.equal(f.children.length, 2);
});

test("quota exit code schedules one explicit future retry and notification cannot bypass it", async (t) => {
  const f = fixture(t);
  f.children[0].child.finish(
    stats({
      applied: 0,
      considered: 0,
      requests: 0,
      certain: 0,
      pending: 20,
      stopped: "quota",
      retryAt: "2026-11-05T00:02:00.000Z",
    }),
    1,
  );
  assert.equal(f.controller.status.state, "waiting");
  await f.notify();
  assert.equal(f.children.length, 1);
  await f.advance(119989);
  assert.equal(f.children.length, 1);
  await f.advance(1);
  assert.equal(f.children.length, 2);
});

test("deferred covers resume at future retryAt with a minimum sixty-second delay", async (t) => {
  const f = fixture(t);
  f.children[0].child.finish(
    stats({
      applied: 0,
      pending: 3,
      deferred: 3,
      retryAt: "2026-11-05T00:00:10.000Z",
    }),
  );
  await f.advance(59999);
  assert.equal(f.children.length, 1);
  await f.advance(1);
  assert.equal(f.children.length, 2);
});

test("invalid, past, or excessive retry dates cannot create automatic retry loops", async (t) => {
  for (const retryAt of [
    "",
    "secret",
    "2026-11-04T00:00:00.000Z",
    "2027-01-01T00:00:00.000Z",
  ]) {
    const f = fixture(t);
    f.children[0].child.finish(
      stats({ applied: 0, pending: 3, stopped: "quota", retryAt }),
      1,
    );
    await tick();
    assert.equal(f.children.length, 1);
    assert.equal(f.timers.size, 0);
  }
});

test("zero pending and quarantine-only quota records never schedule timers", async (t) => {
  for (const values of [{ pending: 0 }, { pending: 2, quarantined: 2 }]) {
    const f = fixture(t);
    f.children[0].child.finish(
      stats({
        applied: 0,
        stopped: "quota",
        retryAt: "2026-11-05T00:02:00.000Z",
        ...values,
      }),
      1,
    );
    await tick();
    assert.equal(f.timers.size, 0);
  }
});

test("malformed, secret-bearing and linked notification files cannot authorize a pass", async (t) => {
  const f = fixture(t);
  f.children[0].child.finish();
  await tick();
  for (const raw of [
    "{",
    "x".repeat(4097),
    JSON.stringify({
      requestId: "secret",
      requestedAt: "2026-11-05T00:00:00.000Z",
    }),
    JSON.stringify({
      requestId: "12345678-1234-1234-1234-123456789012",
      requestedAt: "2026-11-05T00:00:00.000Z",
      token: "provider-secret",
    }),
  ]) {
    f.setNotification(raw);
    f.callback("rename", "catalog-request.json");
    await f.advance(10);
  }
  assert.equal(f.children.length, 1);
  f.fs.lstatSync = () => ({
    isFile: () => true,
    isSymbolicLink: () => false,
    nlink: 2,
    size: 10,
  });
  await f.notify("22345678-1234-1234-1234-123456789012");
  assert.equal(f.children.length, 1);
  assert.ok(!JSON.stringify(f.reports).includes("provider-secret"));
});

test("error, no progress, paused, and quarantine-only work stay idle until a new notification", async (t) => {
  for (const values of [
    { applied: 0, pending: 2 },
    { pending: 2, quarantined: 2 },
    { stopped: "error", pending: 2 },
    { stopped: "paused", pending: 2 },
  ]) {
    const f = fixture(t);
    f.children[0].child.finish(stats(values));
    await tick();
    assert.equal(f.children.length, 1);
    assert.equal(f.timers.size, 0);
    await f.notify();
    assert.equal(f.children.length, 2);
  }
});

test("coalesces atomic notification replacement and ignores other writes and duplicate IDs", async (t) => {
  const f = fixture(t);
  await f.notify();
  await f.notify();
  assert.equal(f.children.length, 1);
  f.children[0].child.finish();
  await tick();
  assert.equal(f.children.length, 2);
  f.children[1].child.finish();
  await tick();
  await f.notify();
  assert.equal(f.children.length, 2);
  await f.notify("22345678-1234-1234-1234-123456789012", "change");
  await f.notify(
    "32345678-1234-1234-1234-123456789012",
    "rename",
    "other.json",
  );
  assert.equal(f.children.length, 2);
  await f.notify("42345678-1234-1234-1234-123456789012");
  assert.equal(f.children.length, 3);
});

test("bounds each automatic chain even when every pass reports progress", async (t) => {
  const f = fixture(t, {}, { maxPasses: 3 });
  for (let n = 0; n < 3; n++) {
    f.children[n].child.finish(stats({ pending: 100 }));
    await tick();
  }
  assert.equal(f.children.length, 3);
  assert.equal(f.controller.status.limitReached, true);
  assert.equal(f.timers.size, 0);
});

test("default drain cannot exceed one thousand finite children", async (t) => {
  const f = fixture(t);
  for (let n = 0; n < 1000; n++) {
    f.children[n].child.finish(stats({ pending: 100 }));
    await tick();
  }
  assert.equal(f.children.length, 1000);
  assert.equal(f.controller.status.limitReached, true);
  assert.throws(
    () => fixture(t, {}, { maxPasses: 1001 }),
    /configuration unavailable/,
  );
});

test("startup can be disabled and watcher failure stops the owned child without raw errors", async (t) => {
  const f = fixture(t, {}, { startup: false });
  assert.equal(f.children.length, 0);
  assert.equal(f.timers.size, 0);
  await f.notify();
  assert.equal(f.children.length, 1);
  f.watches[0].emit("error", Error("provider-secret"));
  assert.equal(await f.controller.done, 1);
  assert.equal(f.children[0].child.killed, true);
  assert.ok(!JSON.stringify(f.reports).includes("provider-secret"));
});

test("child error followed by close is counted once and never causes a retry", async (t) => {
  const f = fixture(t);
  f.children[0].child.emit("error", Error("provider-secret"));
  f.children[0].child.finish(stats({ pending: 100 }));
  await tick();
  assert.equal(f.controller.status.state, "failed");
  assert.equal(f.children.length, 1);
  assert.equal(f.reports.filter((report) => report.event === "pass").length, 1);
});

test("oversized, unknown-field, nonnumeric and raw secret output never leaks to status or restarts", async (t) => {
  for (const output of [
    "secret".repeat(12000),
    { ...stats(), secret: "provider-secret" },
    { ...stats(), applied: "100" },
    "provider-secret\nnot json",
  ]) {
    const f = fixture(t);
    f.children[0].child.finish(output);
    await tick();
    assert.equal(f.children.length, 1);
    assert.equal(f.controller.status.state, "failed");
    assert.ok(!JSON.stringify(f.reports).includes("provider-secret"));
  }
});

test("uses only the last aggregate record and safely handles spawn errors", async (t) => {
  const f = fixture(t);
  f.children[0].child.finish(
    "provider-secret\n" + JSON.stringify(stats()) + "\n",
  );
  await tick();
  assert.equal(f.controller.status.state, "idle");
  const failed = fixture(
    t,
    {},
    {
      spawn() {
        throw Error("provider-secret");
      },
    },
  );
  assert.equal(failed.controller.status.state, "failed");
  assert.ok(!JSON.stringify(failed.reports).includes("provider-secret"));
});

test("stop terminates owned child tree, closes watch, clears timers and resolves once", async (t) => {
  const f = fixture(t);
  const child = f.children[0].child;
  await f.controller.stop();
  await f.controller.done;
  assert.equal(child.killed, true);
  assert.equal(f.watches[0].closed, true);
  assert.equal(f.timers.size, 0);
  await f.notify();
  assert.equal(f.children.length, 1);
  await f.controller.stop();
});

test("abort signal stops both active work and deferred wakeups", async (t) => {
  const signal = new AbortController();
  const f = fixture(t, {}, { signal: signal.signal });
  f.children[0].child.finish(
    stats({
      applied: 0,
      pending: 3,
      deferred: 3,
      retryAt: "2026-11-05T00:02:00.000Z",
    }),
  );
  signal.abort();
  await f.controller.done;
  await f.advance(180000);
  assert.equal(f.children.length, 1);
  assert.equal(f.timers.size, 0);
});
