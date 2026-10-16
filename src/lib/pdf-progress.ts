export type PdfWorkerStatus = {
  status: "running" | "paused" | "completed" | "failed" | "stale" | "unknown";
  updatedAt?: string;
  reason?: string;
};
export type PdfSummary = {
  total?: number;
  basicOnly?: number;
  states: Record<string, number>;
  pages: number;
  textPages: number;
  knownPages?: number;
  unavailablePages?: number;
  pageMethods?: Record<string, number> | null;
  hashes?: { stored: number; total: number };
  workers?: { ocr: PdfWorkerStatus; hash: PdfWorkerStatus };
};
