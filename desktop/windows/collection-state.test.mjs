import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { writeCollectionState } from "./collection-state.mjs";

test("transient replacement errors retry without truncating the old ledger", () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kl-state-"));
  try {
    const file = join(dir, "ledger.json");
    fs.writeFileSync(file, '{"reserved":100}');
    let attempts = 0;
    writeCollectionState(
      file,
      { reserved: 200 },
      {
        io: {
          ...fs,
          renameSync: (a, b) => {
            assert.equal(fs.readFileSync(file, "utf8"), '{"reserved":100}');
            if (++attempts < 3)
              throw Object.assign(Error("busy"), { code: "EPERM" });
            fs.renameSync(a, b);
          },
        },
        wait: () => {},
      },
    );
    assert.equal(attempts, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { reserved: 200 });
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
test("persistent failures preserve the original, stop at a bound, and clean temporary files", () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kl-state-"));
  try {
    const file = join(dir, "ledger.json");
    fs.writeFileSync(file, '{"reserved":100}');
    let attempts = 0;
    assert.throws(
      () =>
        writeCollectionState(
          file,
          { reserved: 200 },
          {
            io: {
              ...fs,
              renameSync: () => {
                attempts++;
                throw Object.assign(Error("busy"), { code: "EPERM" });
              },
            },
            wait: () => {},
          },
        ),
      (e) => e.code === "EPERM" && e.collectionStateWrite,
    );
    assert.equal(attempts, 10);
    assert.equal(fs.readFileSync(file, "utf8"), '{"reserved":100}');
    assert.deepEqual(fs.readdirSync(dir), ["ledger.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
test(
  "Windows status-reader handle can close before replacement succeeds",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "kl-state-"));
    const file = join(dir, "ledger.json");
    fs.writeFileSync(file, "{}");
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$s=[IO.File]::Open('${file.replaceAll("'", "''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{[Console]::WriteLine('ready');Start-Sleep -Milliseconds 350}finally{$s.Dispose()}`,
      ],
      { windowsHide: true },
    );
    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    try {
      await new Promise((resolve, reject) => {
        child.stdout.once("data", resolve);
        child.once("error", reject);
        child.once("exit", () => reject(Error("reader exited before ready")));
      });
      writeCollectionState(file, { reserved: 100 });
      assert.deepEqual(JSON.parse(fs.readFileSync(file)), { reserved: 100 });
      await done;
    } finally {
      child.kill();
      fs.rmSync(dir, { recursive: true });
    }
  },
);
