import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { collectionSnapshot, writeState, host } from "./collection-host.mjs";
test("explicit retry is bound to the exact transient halt and does not unlock an unknown error", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kl-retry-"));
  try {
    writeState(dir, "halted.json", {
      kind: "pdf",
      at: "one",
      failure: { retryable: false },
    });
    writeState(dir, "desktop-request.json", {
      kind: "pdf",
      requestId: "retry",
      retryHaltAt: "one",
    });
    let calls = 0;
    const run = async () => {
      calls++;
      return 0;
    };
    const now = () => new Date("2026-11-15T00:00:00Z");
    await host({ stateDirectory: dir }, { once: true, run, now });
    expectNoRun();
    writeState(dir, "halted.json", {
      kind: "pdf",
      at: "two",
      failure: { retryable: true },
    });
    await host({ stateDirectory: dir }, { once: true, run, now });
    expectNoRun();
    writeState(dir, "desktop-request.json", {
      kind: "pdf",
      requestId: "retry",
      retryHaltAt: "two",
    });
    await host({ stateDirectory: dir }, { once: true, run, now });
    assert.equal(calls, 1);
    assert.ok(fs.existsSync(join(dir, "halted-retry-retry.json")));
    function expectNoRun() {
      assert.equal(calls, 0);
      assert.ok(fs.existsSync(join(dir, "halted.json")));
    }
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
test("halt is visible, blocks writes and preserves previous settings and ledger", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kl-host-"));
  try {
    writeState(dir, "halted.json", { failure: { name: "TypeError" } });
    writeState(dir, "user-settings.json", { pdf: { dailyLimit: 37 } });
    let called = 0;
    await host(
      { stateDirectory: dir },
      {
        once: true,
        run: async () => {
          called++;
          return 0;
        },
      },
    );
    const snap = collectionSnapshot(dir);
    assert.equal(called, 0);
    assert.equal(snap.halted, true);
    assert.equal(snap.errorName, "TypeError");
    assert.equal(snap.settings.pdf.dailyLimit, 37);
    assert.equal(fs.existsSync(join(dir, "desktop-host.lock")), false);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
test("manual request is bounded, already handled request is not replayed", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kl-host-"));
  const now = () => new Date("2026-11-14T01:00:00Z");
  try {
    writeState(dir, "desktop-request.json", { kind: "pdf", requestId: "test" });
    let calls = 0;
    const run = async (kind, slot) => {
      calls++;
      assert.equal(kind, "pdf");
      assert.equal(slot, "manual-test");
      writeState(dir, "2026-11-14.json", {
        sequences: [
          { session: "pdf:manual-test" },
          { session: "logos:morning" },
        ],
        pdf: { reserved: 100, ids: [] },
        logos: { reserved: 300, ids: [] },
      });
      return 0;
    };
    await host({ stateDirectory: dir }, { once: true, now, run });
    await host({ stateDirectory: dir }, { once: true, now, run });
    assert.equal(calls, 1);
    await host(
      { stateDirectory: dir },
      {
        once: true,
        now: () => new Date("2026-11-15T00:00:00Z"),
        run: async (kind, slot) => {
          assert.equal(kind, "logos");
          assert.equal(slot, "morning");
          return 0;
        },
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
