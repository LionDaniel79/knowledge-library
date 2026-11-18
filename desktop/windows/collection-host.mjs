import { writeCollectionState } from "./collection-state.mjs";
import { refreshCollectionOverview } from "./collection-overview.mjs";
import { automaticRetry, failureGuidance } from "./collection-recovery.mjs";
import { acquireCollectionLock } from "./collection-lock.mjs";
import fs from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  collectionClock,
  collectionSettings,
  dueCollections,
  collectionAllowance,
} from "./collection-settings.mjs";

export function readState(directory, name, fallback) {
  try {
    return JSON.parse(
      fs.readFileSync(join(directory, name), "utf8").replace(/^\uFEFF/, ""),
    );
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw Error("Invalid collection state");
  }
}
export function writeState(directory, name, value) {
  writeCollectionState(join(directory, name), value);
}
export function collectionSnapshot(directory, now = new Date()) {
  const { day } = collectionClock(now),
    settings = collectionSettings(
      readState(directory, "user-settings.json", {}),
    );
  const ledger = readState(directory, day + ".json", {
    sequences: [],
    logos: { reserved: 0, ids: [] },
    pdf: { reserved: 0, ids: [] },
  });
  const halted = readState(directory, "halted.json", null);
  return {
    day,
    settings,
    halted: !!halted,
    halt: halted,
    errorName: halted?.failure?.name ?? halted?.name ?? "",
    canRetry: halted?.failure?.retryable === true,
    haltAt: halted?.at,
    haltKind: halted?.kind,
    collectors: Object.fromEntries(
      ["pdf", "logos"].map((kind) => [
        kind,
        {
          ...settings[kind],
          today: (ledger[kind]?.ids ?? []).length,
          reserved: ledger[kind]?.reserved ?? 0,
          status: readState(directory, kind + "-status.json", {}),
        },
      ]),
    ),
  };
}
export async function host(
  config,
  { once = false, run, now = () => new Date() } = {},
) {
  const directory = resolve(config.stateDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const lock = join(directory, "desktop-host.lock");
  const release = acquireCollectionLock(lock);
  if (!release) return;
  let stopping = false,
    child;
  let overviewAt = 0;
  const stop = () => {
    stopping = true;
    if (child) child.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const execute =
    run ??
    ((kind, slot) =>
      new Promise((resolveRun) => {
        child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("./collection-run.mjs", import.meta.url)),
            "--config",
            config.configurationFile,
            "--kind",
            kind,
            "--slot",
            slot,
          ],
          { windowsHide: true, stdio: "ignore" },
        );
        child.once("error", () => resolveRun(1));
        child.once("close", (code) => {
          child = null;
          resolveRun(code ?? 1);
        });
      }));
  try {
    do {
      try {
        writeState(directory, "desktop-host.json", {
          state: "running",
          at: now().toISOString(),
          pid: process.pid,
        });
        if (Date.now() - overviewAt >= 15 * 60000) {
          overviewAt = Date.now();
          await refreshCollectionOverview(config);
        }
        const snap = collectionSnapshot(directory, now());
        const recovery = readState(directory, "desktop-request.json", {});
        const recovered = readState(
          directory,
          "desktop-handled-request.json",
          {},
        );
        if (
          snap.halted &&
          (snap.canRetry ||
            (recovery.reviewedFailure === true && !!snap.halt?.failure)) &&
          ["pdf", "logos"].includes(recovery.kind) &&
          recovery.retryHaltAt === snap.haltAt &&
          recovery.kind === snap.haltKind &&
          (!Number.isFinite(Date.parse(snap.halt?.failure?.retryAt)) ||
            now().getTime() >= Date.parse(snap.halt.failure.retryAt)) &&
          recovery.requestId !== recovered.requestId &&
          /^[a-zA-Z0-9-]{1,80}$/.test(recovery.requestId ?? "") &&
          collectionAllowance(
            snap.settings,
            recovery.kind,
            snap.collectors[recovery.kind].reserved,
          ) > 0
        ) {
          // Explicit user retry of this exact transient halt; retain its history.
          fs.renameSync(
            join(directory, "halted.json"),
            join(directory, "halted-retry-" + recovery.requestId + ".json"),
          );
          snap.halted = false;
        }
        const attempts = readState(directory, "automatic-retry.json", {});
        const retry = snap.halted
          ? automaticRetry(snap.halt, attempts[snap.haltKind], now().getTime())
          : { allowed: false };
        writeState(directory, "retry-status.json", {
          ...retry,
          kind: snap.haltKind,
          haltAt: snap.haltAt,
          waitingForAllowance:
            !!retry.allowed &&
            collectionAllowance(
              snap.settings,
              snap.haltKind,
              snap.collectors[snap.haltKind]?.reserved ?? 0,
            ) <= 0,
        });
        if (
          snap.halted &&
          retry.allowed &&
          retry.due &&
          ["pdf", "logos"].includes(snap.haltKind) &&
          collectionAllowance(
            snap.settings,
            snap.haltKind,
            snap.collectors[snap.haltKind].reserved,
          ) > 0
        ) {
          const requestId =
            "auto-" +
            snap.haltKind +
            "-" +
            (retry.count + 1) +
            "-" +
            now().getTime();
          // Persist before launch so restarts and day boundaries cannot reset the bound.
          attempts[snap.haltKind] = { count: retry.count + 1 };
          writeState(directory, "automatic-retry.json", attempts);
          writeState(directory, "desktop-request.json", {
            kind: snap.haltKind,
            requestId,
          });
          fs.renameSync(
            join(directory, "halted.json"),
            join(directory, "halted-retry-" + requestId + ".json"),
          );
          snap.halted = false;
        }
        if (!snap.halted) {
          const ledger = readState(directory, snap.day + ".json", {
            sequences: [],
            logos: { reserved: 0, ids: [] },
            pdf: { reserved: 0, ids: [] },
          });
          const request = readState(directory, "desktop-request.json", {});
          const handled = readState(
            directory,
            "desktop-handled-request.json",
            {},
          );
          let due = dueCollections(ledger, snap.settings, now());
          if (
            ["logos", "pdf"].includes(request.kind) &&
            request.requestId !== handled.requestId &&
            /^[a-zA-Z0-9-]{1,80}$/.test(request.requestId ?? "") &&
            !ledger.sequences.some(
              (s) =>
                s.session === `${request.kind}:manual-${request.requestId}`,
            ) &&
            collectionAllowance(
              snap.settings,
              request.kind,
              ledger[request.kind]?.reserved ?? 0,
            ) > 0
          ) {
            // A request is one-shot across day boundaries and process restarts.
            writeState(directory, "desktop-handled-request.json", {
              requestId: request.requestId,
            });
            due = [[request.kind, "manual-" + request.requestId]];
          }
          if (due.length) {
            // The runner and old scheduler share running.lock and daily reservations.
            const code = await execute(...due[0]);
            await refreshCollectionOverview(config);
            overviewAt = Date.now();
            if (
              code === 0 &&
              !fs.existsSync(join(directory, "halted.json")) &&
              readState(directory, due[0][0] + "-status.json", {}).sequence
                ?.success === true &&
              readState(directory, due[0][0] + "-status.json", {}).sequence
                ?.session ===
                due[0][0] + ":" + due[0][1]
            ) {
              attempts[due[0][0]] = { count: 0 };
              writeState(directory, "automatic-retry.json", attempts);
            }
            if (code !== 0 && !fs.existsSync(join(directory, "halted.json")))
              writeState(directory, "halted.json", {
                kind: due[0][0],
                name: "CollectorExit",
                at: now().toISOString(),
              });
          }
        }
      } catch {
        writeState(directory, "desktop-host.json", {
          state: "error",
          at: now().toISOString(),
          message: "수집 설정 또는 상태 파일을 확인하세요.",
          ...failureGuidance({ kind: "configuration" }),
        });
      }
      if (once || stopping) break;
      await new Promise((r) => setTimeout(r, 30000));
    } while (!stopping);
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    writeState(directory, "desktop-host.json", {
      state: "stopped",
      at: now().toISOString(),
    });
    release();
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const i = process.argv.indexOf("--config");
  if (i < 0) throw Error("Configuration required");
  const configurationFile = resolve(process.argv[i + 1]);
  const config = JSON.parse(
    fs.readFileSync(configurationFile, "utf8").replace(/^\uFEFF/, ""),
  );
  await host({ ...config, configurationFile });
}
