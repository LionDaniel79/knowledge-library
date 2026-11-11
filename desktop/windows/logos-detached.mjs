import * as nodeFs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { runtimeEnvironment, unlockProfile } from "./start-private-pc.mjs";
import { catalogWorkerEnvironment } from "./catalog-worker.mjs";

const MAX_OUTPUT = 64 * 1024;
const MAX_PASSES = 1000;
const MIN_RETRY = 60_000;
const MAX_RETRY = 7 * 86_400_000;
const NUMBERS = [
  "considered",
  "requests",
  "cached",
  "certain",
  "review",
  "missing",
  "applied",
  "failed",
  "deferred",
  "quarantined",
  "pending",
];

export function logosPassArguments(config) {
  return [
    "--import",
    pathToFileURL(join(config.app, "node_modules", "tsx", "dist", "loader.mjs"))
      .href,
    join(config.app, "scripts", "complete-logos.ts"),
    "--online",
    "--apply",
    "--limit",
    "100",
  ];
}

function notificationFingerprint(fs, path) {
  let descriptor;
  try {
    const stamp = fs.lstatSync(path);
    if (
      !stamp.isFile() ||
      stamp.isSymbolicLink() ||
      stamp.nlink !== 1 ||
      stamp.size > 4096
    )
      return null;
    descriptor = fs.openSync(path, "r");
    const bytes = Buffer.alloc(4097);
    const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length > 4096) return null;
    const value = JSON.parse(
      bytes
        .subarray(0, length)
        .toString("utf8")
        .replace(/^\uFEFF/, ""),
    );
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "requestId,requestedAt" ||
      typeof value.requestId !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.requestId) ||
      typeof value.requestedAt !== "string" ||
      !/(?:Z|\+00:00)$/.test(value.requestedAt) ||
      !Number.isFinite(Date.parse(value.requestedAt))
    )
      return null;
    // An opaque request ID is the idempotency token; rewriting its timestamp
    // cannot turn one request into several database passes.
    return createHash("sha256")
      .update(value.requestId.toLowerCase())
      .digest("hex");
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function lastStats(chunks, overflow) {
  if (overflow) return null;
  try {
    const value = JSON.parse(
      Buffer.concat(chunks).toString("utf8").trim().split(/\r?\n/).at(-1),
    );
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !==
        [...NUMBERS, "stopped", "retryAt"].sort().join(",") ||
      !["complete", "quota", "error", "paused"].includes(value.stopped) ||
      typeof value.retryAt !== "string" ||
      (value.retryAt !== "" &&
        (!Number.isFinite(Date.parse(value.retryAt)) ||
          new Date(value.retryAt).toISOString() !== value.retryAt))
    )
      return null;
    for (const field of NUMBERS)
      if (
        !Number.isSafeInteger(value[field]) ||
        value[field] < 0 ||
        value[field] > 10_000_000
      )
        return null;
    if (
      value.considered > 100 ||
      value.requests > 100 ||
      value.applied + value.failed > value.considered ||
      value.deferred > value.pending ||
      value.quarantined > value.pending
    )
      return null;
    return Object.fromEntries(
      [...NUMBERS, "stopped", "retryAt"].map((key) => [key, value[key]]),
    );
  } catch {
    return null;
  }
}

function terminateLogos(child) {
  if (
    process.platform === "win32" &&
    Number.isSafeInteger(child.pid) &&
    child.pid > 0
  ) {
    const env = {};
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "PATH", "Path"])
      if (process.env[key]) env[key] = process.env[key];
    try {
      const result = spawnSync(
        join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        {
          env,
          stdio: "ignore",
          windowsHide: true,
          shell: false,
          timeout: 5000,
        },
      );
      if (result.status === 0) return;
    } catch {
      /* Cleanup never logs child errors or credentials. */
    }
  }
  child.kill();
}

/** Owns one finite CLI child at a time; idle means only a filesystem watch. */
export function startDetachedLogos(
  configuration,
  notificationPath,
  options = {},
) {
  const fs = options.fs || nodeFs;
  const spawnWorker = options.spawn || spawn;
  const watchDirectory = options.watch || fs.watch;
  const decrypt = options.unlockProfile || unlockProfile;
  const terminate = options.terminate || terminateLogos;
  const clock = options.clock || { now: Date.now, setTimeout, clearTimeout };
  const debounceMs = options.debounceMs ?? 200;
  const maxPasses = options.maxPasses ?? MAX_PASSES;
  let config, environment, notification;
  try {
    config =
      typeof configuration === "string"
        ? JSON.parse(
            fs.readFileSync(configuration, "utf8").replace(/^\uFEFF/, ""),
          )
        : configuration;
    if (
      !config ||
      config.logosCompletionApproved !== true ||
      typeof config.app !== "string" ||
      typeof config.node !== "string" ||
      !fs.existsSync(config.node) ||
      !fs.existsSync(join(config.app, "scripts", "complete-logos.ts")) ||
      !fs.existsSync(
        join(config.app, "node_modules", "tsx", "dist", "loader.mjs"),
      ) ||
      !Number.isInteger(debounceMs) ||
      debounceMs < 0 ||
      debounceMs > 5000 ||
      !Number.isInteger(maxPasses) ||
      maxPasses < 1 ||
      maxPasses > MAX_PASSES
    )
      throw Error();
    notification = resolve(notificationPath);
    if (basename(notification).toLowerCase() !== "catalog-request.json")
      throw Error();
    environment = {
      ...catalogWorkerEnvironment(runtimeEnvironment(config, decrypt(config))),
      LIBRARY_STAGE5_WRITE_ENABLED: "true",
    };
    if (!environment.YES24_API_KEY && !environment.DATA4LIBRARY_KEY)
      throw Error();
  } catch {
    throw Error("Independent Logos configuration unavailable.");
  }

  let child = null,
    watcher,
    debounce,
    retryTimer,
    forceStop;
  let stopped = false,
    busy = false,
    queued = false,
    failed = false,
    limitReached = false;
  let passes = 0,
    runs = 0,
    completionCode = 0,
    retryAt = "";
  const totals = Object.fromEntries(NUMBERS.map((field) => [field, 0]));
  let fingerprint = notificationFingerprint(fs, notification);
  let resolveDone;
  const done = new Promise((resolveDoneValue) => {
    resolveDone = resolveDoneValue;
  });
  const snapshot = () => ({
    state: stopped
      ? "stopped"
      : busy
        ? "running"
        : failed
          ? "failed"
          : retryTimer !== undefined
            ? "waiting"
            : "idle",
    running: child !== null,
    queued,
    passes,
    runs,
    limitReached,
    retryAt,
    totals: { ...totals },
  });
  const report = (event, stats) => {
    try {
      options.onStatus?.({
        ...snapshot(),
        event,
        ...(stats ? { stats: { ...stats } } : {}),
      });
    } catch {
      /* Status callbacks cannot interrupt owned-process cleanup. */
    }
  };
  const finishStop = () => {
    if (!stopped || child) return;
    clock.clearTimeout(forceStop);
    resolveDone(completionCode);
  };
  const stop = () => {
    if (!stopped) {
      stopped = true;
      busy = false;
      queued = false;
      retryAt = "";
      clock.clearTimeout(debounce);
      clock.clearTimeout(retryTimer);
      retryTimer = undefined;
      watcher?.close();
      options.signal?.removeEventListener("abort", stop);
      if (child) {
        forceStop = clock.setTimeout(() => {
          try {
            if (child) terminate(child);
          } catch {
            try {
              child?.kill("SIGKILL");
            } catch {}
          }
        }, 3000);
        forceStop?.unref?.();
        try {
          terminate(child);
        } catch {
          try {
            child?.kill("SIGKILL");
          } catch {}
        }
      }
      report("stopped");
    }
    finishStop();
    return done;
  };
  const begin = () => {
    if (stopped || busy || retryTimer !== undefined) return;
    queued = false;
    busy = true;
    failed = false;
    limitReached = false;
    passes = 0;
    retryAt = "";
    launch();
  };
  const launch = () => {
    if (stopped) return;
    passes++;
    runs++;
    let current,
      settled = false,
      chunks = [],
      size = 0,
      overflow = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (child === current) child = null;
      if (stopped) {
        finishStop();
        return;
      }
      const parsed = lastStats(chunks, overflow);
      // Quota is deliberately CLI exit 1; only its strictly validated aggregate
      // may authorize a future timer. Other unsuccessful exits never retry.
      const stats =
        code === 0 || (code === 1 && parsed?.stopped === "quota")
          ? parsed
          : null;
      chunks = [];
      failed = !stats || stats.stopped === "error";
      if (stats)
        for (const field of NUMBERS)
          totals[field] =
            field === "pending" ? stats[field] : totals[field] + stats[field];
      report("pass", stats);
      const progressing =
        stats?.stopped === "complete" &&
        stats.applied > 0 &&
        stats.pending > stats.quarantined + stats.deferred;
      if (progressing && passes < maxPasses) {
        queueMicrotask(launch);
        return;
      }
      limitReached = Boolean(progressing && passes === maxPasses);
      busy = false;
      const delay = stats ? Date.parse(stats.retryAt) - clock.now() : NaN;
      const deferred =
        stats &&
        stats.pending > stats.quarantined &&
        (stats.stopped === "quota" ||
          (stats.stopped === "complete" &&
            (stats.deferred > 0 || stats.failed > 0)));
      if (
        !limitReached &&
        deferred &&
        Number.isFinite(delay) &&
        delay > 0 &&
        delay <= MAX_RETRY
      ) {
        retryAt = stats.retryAt;
        retryTimer = clock.setTimeout(
          () => {
            retryTimer = undefined;
            begin();
          },
          Math.max(MIN_RETRY, delay),
        );
        report("waiting");
        return;
      }
      report("waiting");
      if (queued) {
        queued = false;
        queueMicrotask(begin);
      }
    };
    try {
      current = spawnWorker(config.node, logosPassArguments(config), {
        cwd: config.app,
        env: { ...environment },
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
      child = current;
      current.stdout?.on("data", (value) => {
        if (overflow) return;
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += bytes.length;
        if (size > MAX_OUTPUT) {
          overflow = true;
          chunks = [];
        } else chunks.push(bytes);
      });
      current.once("error", () => finish(null));
      current.once("close", (code) => finish(code));
      report("running");
    } catch {
      finish(null);
    }
  };
  const changed = (event, filename) => {
    if (
      stopped ||
      event !== "rename" ||
      (filename !== null &&
        filename !== undefined &&
        String(filename).toLowerCase() !== basename(notification).toLowerCase())
    )
      return;
    clock.clearTimeout(debounce);
    debounce = clock.setTimeout(() => {
      debounce = undefined;
      if (stopped) return;
      const next = notificationFingerprint(fs, notification);
      if (next === null || next === fingerprint) return;
      fingerprint = next;
      if (busy || retryTimer !== undefined) {
        queued = true;
        report("queued");
      } else begin();
    }, debounceMs);
  };
  if (options.signal?.aborted) stop();
  else {
    try {
      watcher = watchDirectory(
        dirname(notification),
        { persistent: true },
        changed,
      );
      watcher.on("error", () => {
        completionCode = 1;
        stop();
      });
    } catch {
      throw Error("Independent Logos notification unavailable.");
    }
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.startup !== false) begin();
  }
  return {
    stop,
    kill: stop,
    done,
    get status() {
      return snapshot();
    },
  };
}
