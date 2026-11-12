import {
  existsSync,
  lstatSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  watch,
} from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { runtimeEnvironment, unlockProfile } from "./runtime-profile.mjs";
import { catalogWorkerEnvironment } from "./catalog-worker.mjs";
import { startDetachedLogos } from "./logos-detached.mjs";

const MAX_OUTPUT = 64 * 1024;
const MAX_PASSES = 1000;
const MAX_RETRIES = 3;
const MIN_RETRY = 60_000;
const MAX_RETRY = 7 * 86_400_000;

// The existing collector is deliberately one-shot. It writes a private
// checkpoint, so this wrapper exposes only its fresh aggregate stats to the
// supervisor without changing the collector or launching the HTTP runtime.
const PASS_WRAPPER = `
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const started = Date.now();
try {
  await import(pathToFileURL(process.argv[1]).href);
  const file = await open(join(process.env.CATALOG_CACHE_DIR, 'supplement', 'status.json'), 'r');
  let raw;
  try {
    const data = Buffer.alloc(65537);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > 65536) throw Error('Invalid checkpoint');
    raw = JSON.parse(data.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
  if (!Number.isFinite(Date.parse(raw.at)) || Date.parse(raw.at) < started || Date.parse(raw.at) > Date.now()) throw Error('Stale checkpoint');
  console.log(JSON.stringify(raw));
} catch {
  process.exitCode = 1;
}
`;

export function catalogPassArguments(config) {
  return [
    "--import",
    pathToFileURL(join(config.app, "node_modules", "tsx", "dist", "loader.mjs"))
      .href,
    "--input-type=module",
    "--eval",
    PASS_WRAPPER,
    join(config.app, "scripts", "catalog-supplement-worker.ts"),
  ];
}

function notificationFingerprint(path) {
  let descriptor;
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 4096
    )
      return null;
    descriptor = openSync(path, "r");
    const bytes = Buffer.alloc(4097);
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
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
    return createHash("sha256")
      .update(
        JSON.stringify([
          value.requestId.toLowerCase(),
          new Date(value.requestedAt).toISOString(),
        ]),
      )
      .digest("hex");
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function lastStats(chunks, overflow) {
  if (overflow) return null;
  try {
    const line = Buffer.concat(chunks)
      .toString("utf8")
      .trim()
      .split(/\r?\n/)
      .at(-1);
    const value = JSON.parse(line);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value)
        .filter((key) => key !== "retryAt")
        .sort()
        .join(",") !== "at,checked,completed,failed,pending" ||
      typeof value.at !== "string" ||
      !Number.isFinite(Date.parse(value.at)) ||
      new Date(value.at).toISOString() !== value.at
    )
      return null;
    if (
      value.retryAt !== undefined &&
      (typeof value.retryAt !== "string" ||
        (value.retryAt !== "" &&
          (!Number.isFinite(Date.parse(value.retryAt)) ||
            new Date(value.retryAt).toISOString() !== value.retryAt)))
    )
      return null;
    for (const field of ["checked", "completed", "pending", "failed"])
      if (
        !Number.isSafeInteger(value[field]) ||
        value[field] < 0 ||
        value[field] > 10000000
      )
        return null;
    if (value.checked > 10 || value.completed + value.pending > value.checked)
      return null;
    return {
      at: value.at,
      checked: value.checked,
      completed: value.completed,
      pending: value.pending,
      failed: value.failed,
      retryAt: value.retryAt ?? "",
    };
  } catch {
    return null;
  }
}

function terminateCatalog(child) {
  if (
    process.platform === "win32" &&
    Number.isSafeInteger(child.pid) &&
    child.pid > 0
  ) {
    // Stop the owned collector tree, including any short-lived transpiler
    // helper. No credentials, PDF paths or connection strings are arguments.
    const environment = {};
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "PATH", "Path"])
      if (process.env[key]) environment[key] = process.env[key];
    try {
      const result = spawnSync(
        join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        {
          windowsHide: true,
          shell: false,
          stdio: "ignore",
          timeout: 5000,
          env: environment,
        },
      );
      if (result.status === 0) return;
    } catch {
      /* Fall back to terminating the directly owned process. */
    }
  }
  child.kill();
}

export function startDetachedCatalog(
  configuration,
  notificationPath,
  options = {},
) {
  const spawnWorker = options.spawn || spawn;
  const watchDirectory = options.watch || watch;
  const decrypt = options.unlockProfile || unlockProfile;
  const terminate = options.terminate || terminateCatalog;
  const clock = options.clock ?? { now: Date.now, setTimeout, clearTimeout };
  const debounceMs = options.debounceMs ?? 200;
  const maxPasses = options.maxPasses ?? MAX_PASSES;
  if (
    !Number.isInteger(debounceMs) ||
    debounceMs < 0 ||
    debounceMs > 5000 ||
    !Number.isInteger(maxPasses) ||
    maxPasses < 1 ||
    maxPasses > MAX_PASSES
  )
    throw Error("Independent catalog configuration unavailable.");
  let config, environment, notification;
  try {
    config =
      typeof configuration === "string"
        ? JSON.parse(readFileSync(configuration, "utf8").replace(/^\uFEFF/, ""))
        : configuration;
    notification = resolve(notificationPath);
    if (
      !config ||
      typeof config.node !== "string" ||
      !existsSync(config.node) ||
      !existsSync(
        join(config.app, "scripts", "catalog-supplement-worker.ts"),
      ) ||
      !existsSync(join(config.app, "node_modules", "tsx", "dist", "loader.mjs"))
    )
      throw Error();
    environment = catalogWorkerEnvironment(
      runtimeEnvironment(config, decrypt(config)),
    );
    if (!environment.YES24_API_KEY && !environment.DATA4LIBRARY_KEY)
      throw Error();
  } catch {
    throw Error("Independent catalog configuration unavailable.");
  }

  let child = null,
    watcher,
    debounce,
    forceStop,
    retryTimer;
  let retries = 0,
    retryAt = "",
    retryLimitReached = false;
  let stopped = false,
    busy = false,
    queued = false,
    failed = false,
    limitReached = false;
  let passes = 0,
    runs = 0,
    completionCode = 0;
  const totals = { checked: 0, completed: 0, pending: 0, failed: 0 };
  let fingerprint = notificationFingerprint(notification);
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const snapshot = () => ({
    state: stopped
      ? "stopped"
      : config.collectionPaused === true
        ? "paused"
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
    retryLimitReached,
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
      /* A UI callback cannot expose a raw child error or stop cleanup. */
    }
  };
  const finishStop = () => {
    if (!stopped || child) return;
    clearTimeout(forceStop);
    resolveDone(completionCode);
  };
  const stop = () => {
    if (!stopped) {
      stopped = true;
      busy = false;
      queued = false;
      clearTimeout(debounce);
      clock.clearTimeout(retryTimer);
      retryTimer = undefined;
      retryAt = "";
      watcher?.close();
      options.signal?.removeEventListener("abort", stop);
      if (child) {
        forceStop = setTimeout(() => {
          try {
            child?.kill("SIGKILL");
          } catch {
            /* No raw error logging. */
          }
        }, 3000);
        forceStop.unref?.();
        try {
          terminate(child);
        } catch {
          try {
            child?.kill("SIGKILL");
          } catch {
            /* No raw error logging. */
          }
        }
      }
      report("stopped");
    }
    finishStop();
    return done;
  };
  const begin = () => {
    if (stopped || config.collectionPaused === true) return;
    clock.clearTimeout(retryTimer);
    retryTimer = undefined;
    retryAt = "";
    busy = true;
    failed = false;
    limitReached = false;
    passes = 0;
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
      const stats = code === 0 ? lastStats(chunks, overflow) : null;
      chunks = [];
      failed = !stats || stats.failed > 0;
      if (stats)
        for (const key of Object.keys(totals)) totals[key] += stats[key];
      report("pass", stats);
      const progressing =
        stats &&
        stats.checked >= 10 &&
        stats.failed === 0 &&
        stats.completed > 0;
      if (progressing && passes < maxPasses) {
        queueMicrotask(launch);
        return;
      }
      limitReached = Boolean(progressing && passes === maxPasses);
      busy = false;
      const delay = Date.parse(stats?.retryAt) - clock.now();
      const resumable =
        stats &&
        !failed &&
        !limitReached &&
        Number.isFinite(delay) &&
        delay > 0 &&
        delay <= MAX_RETRY;
      retryLimitReached = Boolean(resumable && retries >= MAX_RETRIES);
      if (resumable && !retryLimitReached && !queued) {
        retryAt = stats.retryAt;
        retryTimer = clock.setTimeout(
          () => {
            retryTimer = undefined;
            retries++;
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
      current = spawnWorker(config.node, catalogPassArguments(config), {
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
  const changed = (_event, filename) => {
    if (
      stopped ||
      (filename !== null &&
        filename !== undefined &&
        String(filename).toLowerCase() !== basename(notification).toLowerCase())
    )
      return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (stopped) return;
      const next = notificationFingerprint(notification);
      if (next === null || next === fingerprint) return;
      fingerprint = next;
      retries = 0;
      retryLimitReached = false;
      if (busy) {
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
      throw Error("Independent catalog notification unavailable.");
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

export function startCatalogServices(
  configuration,
  notificationPath,
  options = {},
) {
  let config, catalog;
  const controllers = [];
  const status = (service) => (value) =>
    options.onStatus?.({ ...value, service });
  try {
    config =
      typeof configuration === "string"
        ? JSON.parse(readFileSync(configuration, "utf8").replace(/^\uFEFF/, ""))
        : configuration;
    catalog = (options.startCatalog || startDetachedCatalog)(
      config,
      notificationPath,
      { onStatus: status("catalog") },
    );
    controllers.push(catalog);
  } catch {
    throw Error("Independent catalog services unavailable.");
  }
  if (config.logosCompletionApproved === true) {
    try {
      controllers.push(
        (options.startLogos || startDetachedLogos)(config, notificationPath, {
          onStatus: status("logos"),
        }),
      );
    } catch {
      options.onWarning?.(
        "Logos completion unavailable; pending work is retained.",
      );
    }
  }
  // A failed watcher must not silently leave the other service detached.
  for (const current of controllers)
    current.done.then(() => {
      for (const other of controllers) if (other !== current) other.stop();
    });
  const done = Promise.all(controllers.map((c) => c.done)).then((codes) =>
    codes.some((c) => c !== 0) ? 1 : 0,
  );
  const stop = () => {
    for (const c of controllers) c.stop();
    return done;
  };
  return { stop, kill: stop, done };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let controller;
  const stop = () => controller?.stop();
  try {
    const args = process.argv.slice(2);
    if (
      args.length !== 4 ||
      args[0] !== "--config" ||
      args[2] !== "--notification"
    )
      throw Error();
    controller = startCatalogServices(args[1], args[3], {
      onStatus(status) {
        if (status.event === "pass")
          console.log(
            JSON.stringify({
              service: status.service,
              runs: status.runs,
              ...status.totals,
            }),
          );
      },
    });
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.exitCode = await controller.done;
  } catch {
    console.error("Independent catalog unavailable; queued work is retained.");
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (controller) await controller.stop();
  }
}
