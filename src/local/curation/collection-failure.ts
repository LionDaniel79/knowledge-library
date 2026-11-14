/** Log codes and repository file locations, never provider payloads or credentials. */
export function collectionFailure(error: unknown, phase: string) {
  const e = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: { code?: unknown };
    stack?: unknown;
  } | null;
  const code = e?.code ?? e?.cause?.code;
  return {
    name: /^[A-Za-z]{1,50}$/.test(String(e?.name ?? ""))
      ? String(e?.name)
      : "Error",
    phase,
    code: /^[A-Z0-9_]{1,50}$/.test(String(code ?? ""))
      ? String(code)
      : undefined,
    kind:
      e?.message === "Query read timeout" || code === "57014"
        ? "database-timeout"
        : e?.message === "fetch failed" || e?.name === "TimeoutError"
          ? "network"
          : "unexpected",
    retryable:
      e?.message === "Query read timeout" ||
      [
        "57014",
        "ECONNRESET",
        "ETIMEDOUT",
        "ECONNREFUSED",
        "EAI_AGAIN",
        "08006",
        "08001",
        "57P01",
      ].includes(String(code ?? "")),
    frames: [
      ...String(e?.stack ?? "").matchAll(
        /[/\\]([a-z0-9._-]+\.(?:ts|mjs|js)):(\d+):(\d+)/gi,
      ),
    ]
      .slice(0, 4)
      .map((m) => `${m[1]}:${m[2]}:${m[3]}`),
  };
}
