import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { acquireCollectionLock } from "./collection-lock.mjs";
test("live locks and interrupted recovery fail closed", () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kl-lock-")),
    file = join(dir, "running.lock");
  try {
    const release = acquireCollectionLock(file);
    assert.equal(acquireCollectionLock(file), null);
    release();
    fs.writeFileSync(file + ".recovery", "");
    assert.equal(acquireCollectionLock(file), null);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
test("two processes reclaiming a stale lock have one owner", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kl-lock-")),
    file = join(dir, "running.lock");
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: 2147483647 }));
    const script = `import {acquireCollectionLock} from ${JSON.stringify(new URL("./collection-lock.mjs", import.meta.url).href)};const release=acquireCollectionLock(process.argv[1]);console.log(release?'owner':'busy');if(release){await new Promise(r=>setTimeout(r,1000));release();}`;
    const start = () =>
      new Promise((resolve, reject) => {
        const p = spawn(
          process.execPath,
          ["--input-type=module", "-e", script, file],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        p.stdout.on("data", (b) => (out += b));
        p.once("error", reject);
        p.once("close", (code) =>
          code === 0 ? resolve(out.trim()) : reject(Error("Lock child failed")),
        );
      });
    const results = await Promise.all([start(), start()]);
    assert.deepEqual(results.sort(), ["busy", "owner"]);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("accepts file URLs used by the bounded runner", () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kl-lock-url-")),
    file = join(dir, "running.lock");
  try {
    const release = acquireCollectionLock(
      new URL("file:///" + file.replace(/\\/g, "/")),
    );
    assert.ok(release);
    release();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
