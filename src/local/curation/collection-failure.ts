/** Log codes and repository file locations, never provider payloads or credentials. */
export function collectionFailure(error: unknown, phase: string) {
  const e = error as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    retryAt?: unknown;
    code?: unknown;
    cause?: { code?: unknown; name?: unknown };
    stack?: unknown;
  } | null;
  const code = e?.code ?? e?.cause?.code;
  const status = Number(e?.status);
  const message = String(e?.message ?? "");
  const auth =
    [401, 403].includes(status) ||
    ["28P01", "28000", "42501"].includes(String(code)) ||
    /인증|인증키|Restricted database role|Cannot unlock/.test(message);
  const quota = status === 429 || message.includes("호출 한도에 도달");
  const network =
    !auth &&
    !quota &&
    (message === "Query read timeout" ||
      message === "fetch failed" ||
      e?.name === "TimeoutError" ||
      e?.cause?.name === "TimeoutError" ||
      [
        "57014",
        "ECONNRESET",
        "ETIMEDOUT",
        "ECONNREFUSED",
        "EAI_AGAIN",
        "08006",
        "08001",
        "57P01",
      ].includes(String(code)) ||
      (status >= 500 && status <= 599));
  const storage =
    ["ENOSPC", "SQLITE_FULL"].includes(String(code)) ||
    message.includes("저장 공간이 부족");
  const kind = auth
    ? "authentication"
    : quota
      ? "quota"
      : storage
        ? "storage"
        : network
          ? message === "Query read timeout" || code === "57014"
            ? "database-timeout"
            : "network"
          : "unexpected";
  return {
    name: /^[A-Za-z]{1,50}$/.test(String(e?.name ?? ""))
      ? String(e?.name)
      : "Error",
    phase,
    code: /^[A-Z0-9_]{1,50}$/.test(String(code ?? ""))
      ? String(code)
      : undefined,
    kind,
    retryable: network,
    safeToRetry:
      network &&
      [
        "read",
        "initial-select",
        "owner-read",
        "cover-sources",
        "lookup",
      ].includes(phase),
    status:
      [401, 403, 429].includes(status) || (status >= 500 && status <= 599)
        ? status
        : undefined,
    retryAt:
      quota && Number.isFinite(Date.parse(String(e?.retryAt)))
        ? new Date(String(e?.retryAt)).toISOString()
        : undefined,
    frames: [
      ...String(e?.stack ?? "").matchAll(
        /[/\\]([a-z0-9._-]+\.(?:ts|mjs|js)):(\d+):(\d+)/gi,
      ),
    ]
      .slice(0, 4)
      .map((m) => `${m[1]}:${m[2]}:${m[3]}`),
  };
}
