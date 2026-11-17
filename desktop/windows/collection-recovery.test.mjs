import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { automaticRetry } from "./collection-recovery.mjs";
import { host, readState, writeState } from "./collection-host.mjs";
const failure = {
  kind: "network",
  retryable: true,
  safeToRetry: true,
  phase: "lookup",
};
test("only known safe connection failures receive bounded delayed recovery", () => {
  const at = "2026-11-17T00:00:00Z",
    t = Date.parse(at);
  assert.equal(automaticRetry({ failure, at }, {}, t + 59999).due, false);
  assert.equal(automaticRetry({ failure, at }, {}, t + 60000).due, true);
  assert.equal(
    automaticRetry({ failure, at }, { count: 1 }, t + 300000).due,
    true,
  );
  assert.equal(
    automaticRetry({ failure, at }, { count: 2 }, t + 900000).due,
    true,
  );
  assert.equal(
    automaticRetry({ failure, at }, { count: 3 }, t + 9999999).exhausted,
    true,
  );
  for (const kind of [
    "authentication",
    "quota",
    "storage",
    "configuration",
    "unexpected",
  ])
    assert.equal(
      automaticRetry({ at, failure: { ...failure, kind } }, {}, t + 9999999)
        .allowed,
      false,
    );
  assert.equal(
    automaticRetry(
      { at, failure: { ...failure, safeToRetry: false } },
      {},
      t + 9999999,
    ).allowed,
    false,
  );
});
test("attempts persist across host restarts, stop at three, and keep halt evidence", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kl-auto-retry-"));
  let now = new Date("2026-11-17T00:00:00Z"),
    calls = 0;
  try {
    writeState(dir, "user-settings.json", {
      pdf: { mode: "manual" },
      logos: { mode: "manual" },
    });
    writeState(dir, "halted.json", {
      kind: "pdf",
      at: now.toISOString(),
      failure,
    });
    const run = async (kind) => {
      calls++;
      assert.equal(kind, "pdf");
      writeState(dir, "halted.json", { kind, at: now.toISOString(), failure });
      return 1;
    };
    for (const delay of [60000, 300000, 900000]) {
      await host({ stateDirectory: dir }, { once: true, now: () => now, run });
      assert.equal(
        calls,
        readState(dir, "automatic-retry.json", {}).pdf?.count ?? 0,
      );
      now = new Date(now.getTime() + delay);
      await host({ stateDirectory: dir }, { once: true, now: () => now, run });
    }
    assert.equal(calls, 3);
    now = new Date(now.getTime() + 86400000);
    await host({ stateDirectory: dir }, { once: true, now: () => now, run });
    assert.equal(calls, 3);
    assert.equal(readState(dir, "retry-status.json", {}).exhausted, true);
    assert.equal(
      fs.readdirSync(dir).filter((x) => x.startsWith("halted-retry-")).length,
      3,
    );
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
test("paused collection cannot auto retry or discard its halt", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kl-auto-retry-"));
  try {
    writeState(dir, "user-settings.json", { pdf: { paused: true } });
    writeState(dir, "halted.json", {
      kind: "pdf",
      at: "2026-11-17T00:00:00Z",
      failure,
    });
    await host(
      { stateDirectory: dir },
      {
        once: true,
        now: () => new Date("2026-11-17T01:00:00Z"),
        run: () => {
          throw Error("must not run");
        },
      },
    );
    assert.equal(
      readState(dir, "retry-status.json", {}).waitingForAllowance,
      true,
    );
    assert.ok(fs.existsSync(join(dir, "halted.json")));
    assert.ok(!fs.existsSync(join(dir, "automatic-retry.json")));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
test("authentication needs explicit acknowledgement and a successful new run resets attempts", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kl-auto-retry-"));
  try {
    writeState(dir, "user-settings.json", {
      pdf: { mode: "manual" },
      logos: { mode: "manual" },
    });
    writeState(dir, "halted.json", {
      kind: "pdf",
      at: "one",
      failure: { kind: "authentication", retryable: false },
    });
    writeState(dir, "desktop-request.json", {
      kind: "pdf",
      requestId: "review",
      retryHaltAt: "one",
    });
    let calls = 0;
    const run = async (kind, slot) => {
      calls++;
      writeState(dir, kind + "-status.json", {
        sequence: { success: true, session: kind + ":" + slot },
      });
      return 0;
    };
    await host({ stateDirectory: dir }, { once: true, run });
    assert.equal(calls, 0);
    writeState(dir, "automatic-retry.json", { pdf: { count: 3 } });
    writeState(dir, "desktop-request.json", {
      kind: "pdf",
      requestId: "review",
      retryHaltAt: "one",
      reviewedFailure: true,
    });
    await host({ stateDirectory: dir }, { once: true, run });
    assert.equal(calls, 1);
    assert.equal(readState(dir, "automatic-retry.json", {}).pdf.count, 0);
    assert.ok(fs.existsSync(join(dir, "halted-retry-review.json")));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
