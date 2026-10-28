import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { startCatalogWorker } from "./catalog-worker.mjs";
test("a crashed collector restarts while explicit shutdown cancels restarting", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const children = [];
  const c = {
    app: process.cwd(),
    node: process.execPath,
    operations: mkdtempSync(
      join(process.cwd(), ".superpowers", "catalog-supervision-"),
    ),
  };
  const fake = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit("exit", 0);
    children.push(child);
    return child;
  };
  const worker = startCatalogWorker(c, { YES24_API_KEY: "fixture" }, fake);
  assert.equal(children.length, 1);
  children[0].emit("exit", 1);
  t.mock.timers.tick(30000);
  assert.equal(children.length, 2);
  worker.kill();
  t.mock.timers.tick(60000);
  assert.equal(children.length, 2);
});
