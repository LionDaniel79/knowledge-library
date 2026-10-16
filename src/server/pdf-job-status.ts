import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { PdfWorkerStatus } from "../lib/pdf-progress";

export function pdfWorkerStatus(
  index: string,
  kind: "ocr" | "hash",
): PdfWorkerStatus {
  try {
    const file =
      index.slice(0, index.length - extname(index).length) +
      `.${kind}-status.json`;
    if (statSync(file).size > 65536) return { status: "unknown" };
    const value = JSON.parse(readFileSync(file, "utf8"));
    const age = Date.now() - Date.parse(value.updatedAt);
    if (
      value.version !== 1 ||
      value.kind !== kind ||
      !Number.isFinite(age) ||
      age < -30000 ||
      !["running", "paused", "completed", "failed"].includes(value.status)
    )
      return { status: "unknown" };
    return {
      status:
        value.status === "running" && age > 120000 ? "stale" : value.status,
      updatedAt: value.updatedAt,
      reason: [
        "low_disk",
        "batch_limit",
        "interrupted",
        "engine_unavailable",
        "requested_stop",
      ].includes(value.reason)
        ? value.reason
        : undefined,
    };
  } catch {
    return { status: "unknown" };
  }
}
