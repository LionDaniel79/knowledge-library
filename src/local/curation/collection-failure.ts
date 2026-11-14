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
      e?.message === "fetch failed" || e?.name === "TimeoutError"
        ? "network"
        : "unexpected",
    frames: [
      ...String(e?.stack ?? "").matchAll(
        /[/\\]([a-z0-9._-]+\.(?:ts|mjs|js)):(\d+):(\d+)/gi,
      ),
    ]
      .slice(0, 4)
      .map((m) => `${m[1]}:${m[2]}:${m[3]}`),
  };
}
