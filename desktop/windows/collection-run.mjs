import { acquireCollectionLock } from "./collection-lock.mjs";
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { validateBatch } from "./collection-capacity.mjs";
import { runtimeEnvironment, unlockProfile } from "./runtime-profile.mjs";
import {
  collectionSettings,
  collectionAllowance,
  collectionClock,
} from "./collection-settings.mjs";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes("--config")) throw Error("Configuration required");
const config = JSON.parse(
  fs.readFileSync(arg("--config"), "utf8").replace(/^\uFEFF/, ""),
);
const base = pathToFileURL(config.stateDirectory.replace(/[\\/]$/, "") + "/");
fs.mkdirSync(base, { recursive: true });
const file = (n) => new URL(n, base),
  read = (n, fallback) => {
    try {
      return JSON.parse(
        fs.readFileSync(file(n), "utf8").replace(/^\uFEFF/, ""),
      );
    } catch (e) {
      if (e.code === "ENOENT") return fallback;
      throw Error("Invalid collection state");
    }
  },
  write = (n, v) => {
    const temp = file(n + "." + process.pid + ".tmp");
    fs.writeFileSync(temp, JSON.stringify(v, null, 2));
    fs.renameSync(temp, file(n));
  };
const kind = arg("--kind"),
  slot = arg("--slot"),
  check = process.argv.includes("--check"),
  day = collectionClock().day;
if (
  !["logos", "pdf"].includes(kind) ||
  !/^(morning|evening|daily|manual-[a-zA-Z0-9-]+)$/.test(slot)
)
  throw Error("Invalid collection invocation");
if (fs.existsSync(file("halted.json"))) process.exit(1);
const lock = file("running.lock");
let step = "startup";
let release;
const leave = (code) => {
  if (release) {
    release();
    release = null;
  }
  process.exit(code);
};
try {
  release = acquireCollectionLock(lock, { kind, at: new Date().toISOString() });
  if (!release) leave(0);
  const settings = read("user-settings.json", {}),
    ledgerName = day + ".json",
    ledger = read(ledgerName, {
      day,
      stage: 1,
      sequences: [],
      logos: { reserved: 0, ids: [] },
      pdf: { reserved: 0, ids: [] },
    }),
    caps = collectionSettings(settings),
    session = kind + ":" + slot;
  if (ledger.sequences.some((s) => s.session === session)) leave(0);
  const allowance = Math.min(
    kind === "logos" && !slot.startsWith("manual-") ? 300 : 600,
    collectionAllowance(settings, kind, ledger[kind].reserved),
  );
  if (!allowance) leave(0);
  const c = JSON.parse(
      fs
        .readFileSync(config.runtimeConfiguration, "utf8")
        .replace(/^\uFEFF/, ""),
    ),
    installed = JSON.parse(
      fs.readFileSync(config.libraryConfiguration, "utf8"),
    ),
    env = {
      ...process.env,
      ...runtimeEnvironment(c, unlockProfile(c)),
      LIBRARY_STAGE5_WRITE_ENABLED: "true",
    },
    app = c.app;
  if (check) {
    if (
      !fs.existsSync(
        join(
          app,
          "scripts",
          kind === "pdf" ? "complete-pdfs.ts" : "complete-logos.ts",
        ),
      )
    )
      throw Error("Installed source missing");
    console.log(
      JSON.stringify({
        preflight: "PASS",
        stage: ledger.stage,
        caps,
        allowance,
      }),
    );
    leave(0);
  }
  const sequence = {
    session,
    kind,
    slot,
    stage: ledger.stage,
    success: false,
    batches: [],
    at: new Date().toISOString(),
  };
  ledger.sequences.push(sequence);
  write(ledgerName, ledger);
  for (let i = 0, remaining = allowance; remaining > 0; i++) {
    const limit = Math.min(
      100,
      remaining,
      collectionAllowance(
        read("user-settings.json", {}),
        kind,
        ledger[kind].reserved,
      ),
    );
    if (!limit) break;
    remaining -= limit;
    const started = Date.now(),
      out = join(config.stateDirectory, day, kind, slot, String(i + 1));
    fs.mkdirSync(out, { recursive: true });
    ledger[kind].reserved += limit;
    write(ledgerName, ledger);
    const childEnv = {
      ...env,
      COLLECTION_PROGRESS_FILE: join(
        config.stateDirectory,
        "live-" + kind + ".json",
      ),
      COLLECTION_LEDGER: join(config.stateDirectory, ledgerName),
      COLLECTION_STOP_AT: String(
        Date.parse(day + "T00:00:00+09:00") + 86400000,
      ),
      LIBRARY_PDF_ROOT: installed.root,
      LIBRARY_PDF_INDEX: installed.index,
      PDF_IDENTITY_PYTHON: installed.python,
      PDF_AUTO_LEGACY_REPORT_DIR: config.legacyReportDirectory,
      PDF_AUTO_REPORT_DIR: out,
      PDF_FRONTIER_CACHE_DIR: config.frontierDirectory,
    };
    write(kind + "-status.json", {
      state: "running",
      stage: ledger.stage,
      batch: i + 1,
      at: new Date().toISOString(),
    });
    let output = "";
    const child = spawn(
      c.node,
      [
        "--import",
        pathToFileURL(join(app, "node_modules/tsx/dist/loader.mjs")).href,
        join(
          app,
          "scripts",
          kind === "pdf" ? "complete-pdfs.ts" : "complete-logos.ts",
        ),
        "--online",
        "--apply",
        "--limit",
        String(limit),
      ],
      {
        cwd: app,
        env: childEnv,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (b) => {
      if (stderr.length < 4096) stderr += b.toString();
    });
    child.stdout.on("data", (b) => {
      if (output.length < 65536) output += b.toString();
    });
    const code = await new Promise((resolve) => {
      child.once("error", () => resolve(-1));
      child.once("close", resolve);
    });
    let result;
    try {
      result = JSON.parse(output.trim().split(/\r?\n/).at(-1));
    } catch {}
    step = "child-result";
    if (
      !result ||
      code !== 0 ||
      !["complete", "budget", "busy", "paused"].includes(result.stopped)
    ) {
      write("halted.json", {
        kind,
        at: new Date().toISOString(),
        reason: "Global collection failure",
        processCode: code,
        result:
          result &&
          Object.fromEntries(
            [
              "stopped",
              "considered",
              "requests",
              "applied",
              "failed",
              "errors",
              "pending",
              "retryAt",
            ]
              .filter((k) => k in result)
              .map((k) => [k, result[k]]),
          ),
        failure: (() => {
          try {
            const f =
              kind === "logos"
                ? join(
                    env.CATALOG_CACHE_DIR,
                    "logos",
                    createHash("sha256")
                      .update(env.LIBRARY_CATALOG_OWNER_ID)
                      .digest("hex"),
                    "last-pass-books.json",
                  )
                : join(out, "investigated.json");
            const a = JSON.parse(fs.readFileSync(f, "utf8"));
            return Date.parse(a.at) >= started ? a.failure : undefined;
          } catch {
            return undefined;
          }
        })(),
        startupCode: (stderr.match(/ERR_[A-Z_]+/) ?? [])[0],
      });
      throw Error("Global collection failure");
    }
    if (result.stopped === "busy") {
      sequence.reason = "Existing collector lock active";
      break;
    }
    step = "audit-load";
    const auditPath =
      kind === "pdf"
        ? join(out, "investigated.json")
        : join(
            env.CATALOG_CACHE_DIR,
            "logos",
            createHash("sha256")
              .update(env.LIBRARY_CATALOG_OWNER_ID)
              .digest("hex"),
            "last-pass-books.json",
          );
    const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
    if (Date.parse(audit.at) < started)
      throw Error("Stale investigation audit");
    if (audit.ids.length > limit) throw Error("Batch exceeded reservation");
    const localError = (result.failed ?? result.errors ?? 0) > 0;
    step = "audit-validate";
    validateBatch(
      kind,
      {
        ...result,
        stopped: result.stopped === "paused" ? "complete" : result.stopped,
        failed: 0,
        errors: 0,
      },
      audit.ids,
      ledger[kind].ids,
    );
    ledger[kind].ids.push(...audit.ids);
    sequence.batches.push(result);
    write(ledgerName, ledger);
    write(kind + "-status.json", {
      state: localError ? "resource_deferred" : "running",
      stage: ledger.stage,
      at: new Date().toISOString(),
      newToday: ledger[kind].ids.length,
      dayLimit: caps[kind].dailyLimit,
      result,
    });
    if (result.stopped === "paused") {
      sequence.reason = "Day boundary reached";
      break;
    }
    if (localError) {
      sequence.reason = "Resource errors; expansion held";
      break;
    }
    if (remaining === 0 || audit.ids.length === 0) {
      sequence.success = true;
      break;
    }
  }
  write(ledgerName, ledger);
  write(kind + "-status.json", {
    state: sequence.success ? "complete" : "deferred",
    stage: ledger.stage,
    at: new Date().toISOString(),
    newToday: ledger[kind].ids.length,
    dayLimit: caps[kind].dailyLimit,
    sequence,
  });
} catch (e) {
  write("halted.json", {
    ...read("halted.json", {}),
    kind,
    step,
    name: e.name,
    code: e.code,
    at: new Date().toISOString(),
    reason: "Startup, audit or global failure; operator review required",
  });
  write(kind + "-status.json", {
    state: "halted",
    at: new Date().toISOString(),
  });
  process.exitCode = 1;
} finally {
  if (release) release();
}
