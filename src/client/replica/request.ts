import { UnsupportedLocalRoute } from "./repository";
import { ReplicaQueryError } from "./queries";
import type { LibraryRuntime } from "./runtime";
import { onlineOnlyGet } from "./online-routes";
import { commandFamily } from "./optimistic";
let current: LibraryRuntime | null = null;
let networkAccess: (() => Promise<void>) | undefined;
export const isLocalReplicaReady = () => !!current?.getSnapshot().ready;
export function registerLibraryRuntime(
  runtime: LibraryRuntime | null,
  authorizeNetwork?: () => Promise<void>,
) {
  current = runtime;
  networkAccess = authorizeNetwork;
  return () => {
    if (current === runtime && networkAccess === authorizeNetwork) {
      current = null;
      networkAccess = undefined;
    }
  };
}
export async function libraryRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const runtime = current,
    authorizeNetwork = networkAccess,
    method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase(),
    url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      typeof location === "undefined"
        ? "https://local.invalid"
        : location.origin,
    );
  const local =
    runtime?.getSnapshot().ready &&
    (typeof location === "undefined" || url.origin === location.origin) &&
    url.pathname.startsWith("/api/");
  if (local && method === "POST" && commandFamily(url.pathname)) {
    try {
      const body =
        typeof init?.body === "string"
          ? JSON.parse(init.body)
          : input instanceof Request
            ? await input.clone().json()
            : null;
      if (!body) throw Error("저장할 내용을 확인해 주세요.");
      // Same-file verification needs the external PC's original files.
      if (!(
        url.pathname === "/api/book-relations" &&
        body.relation === "same_file" &&
        body.state === "accepted"
      ))
        return Response.json(await runtime.queue(url.pathname, body), {
          headers: {
            "Cache-Control": "private, no-store",
            "X-Library-Source": "device",
          },
        });
    } catch (error) {
      return Response.json(
        { error: (error as Error).message },
        {
          status: error instanceof ReplicaQueryError ? error.status : 400,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }
  }
  if (local && method === "GET") {
    init?.signal?.throwIfAborted();
    try {
      const value = await runtime.repository.read(url.pathname + url.search);
      init?.signal?.throwIfAborted();
      return Response.json(value, {
        headers: {
          "Cache-Control": "private, no-store",
          "X-Library-Source": "device",
        },
      });
    } catch (error) {
      if (
        error instanceof UnsupportedLocalRoute &&
        !onlineOnlyGet(url.pathname)
      )
        return Response.json(
          { error: "이 자료의 기기 조회가 연결되지 않았습니다." },
          { status: 501, headers: { "Cache-Control": "private, no-store" } },
        );
      if (!(error instanceof UnsupportedLocalRoute)) {
        if (error instanceof DOMException && error.name === "AbortError")
          throw error;
        return Response.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "기기 자료를 불러오지 못했습니다.",
          },
          {
            status: error instanceof ReplicaQueryError ? error.status : 400,
            headers: { "Cache-Control": "private, no-store" },
          },
        );
      }
    }
  }
  // Cached screens are readable immediately. Server reads/writes must await the
  // very same displayed owner's session, even before IndexedDB opens.
  if (authorizeNetwork) {
    await authorizeNetwork();
    init?.signal?.throwIfAborted();
    if (networkAccess !== authorizeNetwork)
      throw new DOMException("서재 계정이 변경되었습니다.", "AbortError");
  }
  const response = await fetch(input, init);
  if (
    runtime &&
    method !== "GET" &&
    response.ok &&
    url.pathname.startsWith("/api/") &&
    !url.pathname.startsWith("/api/auth/")
  ) {
    if (runtime.getSnapshot().ready)
      await runtime.sync({ reason: "server-save" }).catch(() => {});
    else void runtime.sync({ reason: "server-save" }).catch(() => {});
  }
  return response;
}
export const readLibraryResource = (path: string) =>
  libraryRequest(path, { cache: "no-store" });
export async function downloadDeviceArchive() {
  if (!current?.getSnapshot().ready)
    throw Error("기기 저장을 먼저 완료해 주세요.");
  const { createReplicaArchive } = await import("./archive");
  const url = URL.createObjectURL(await createReplicaArchive(current.storage));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = `지식서재-기기전체자료-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}
