import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { refreshCollectionOverview } from "./collection-overview.mjs";
for (const mode of ["error", "timeout"])
  test(
    "overview " + mode + " keeps last counts and marks refresh failed",
    async () => {
      const dir = fs.mkdtempSync(join(os.tmpdir(), "kl-overview-host-"));
      try {
        fs.mkdirSync(join(dir, "scripts"));
        fs.writeFileSync(join(dir, "scripts", "collection-overview.ts"), "");
        fs.writeFileSync(
          join(dir, "runtime.json"),
          JSON.stringify({ app: dir }),
        );
        fs.writeFileSync(
          join(dir, "overview.json"),
          JSON.stringify({ pdf: { total: 123 } }),
        );
        fs.writeFileSync(
          join(dir, "overview-refresh.json"),
          JSON.stringify({ ok: true }),
        );
        await refreshCollectionOverview(
          {
            runtimeConfiguration: join(dir, "runtime.json"),
            configurationFile: "fixture",
            stateDirectory: dir,
          },
          {
            timeoutMs: 5,
            launch: () => {
              const child = new EventEmitter();
              child.kill = () => {
                child.emit("close", null);
              };
              if (mode === "error")
                queueMicrotask(() => child.emit("error", Error("fixture")));
              return child;
            },
          },
        );
        assert.equal(
          JSON.parse(fs.readFileSync(join(dir, "overview-refresh.json"))).ok,
          false,
        );
        assert.equal(
          JSON.parse(fs.readFileSync(join(dir, "overview.json"))).pdf.total,
          123,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
