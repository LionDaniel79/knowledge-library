"use client";
import { useEffect, useState } from "react";
import { AuthPanel } from "../auth-panel";
import { LibraryApp } from "../library-app";
import { ReplicaProvider } from "./provider";
import { openReplica } from "@/client/replica/indexed-db";
import {
  createLibraryRuntime,
  verifiedSyncOwner,
  type LibraryRuntime,
} from "@/client/replica/runtime";
import { SyncHttpError } from "@/client/replica/transport";
import { offlineOwnerKey } from "@/lib/offline-drafts";
import { todayInSeoul, type Library } from "@/lib/domain";
import { libraryEntry } from "@/lib/library-entry";
export function ReplicaEntry({
  available,
  today,
  initialView = "home",
  initialOperationsOpen = false,
  returnPath = "/",
}: {
  available: boolean;
  today?: string;
  initialView?: "home" | "pdf";
  initialOperationsOpen?: boolean;
  returnPath?: string;
}) {
  const [screen, setScreen] = useState<{
      runtime: LibraryRuntime | null;
      owner: string;
      data: Library;
    } | null>(null),
    [auth, setAuth] = useState(false),
    [error, setError] = useState("");
  const [storageMessage, setStorageMessage] = useState("");
  const [clientToday, setClientToday] = useState(today ?? todayInSeoul());
  const [clientEntry, setClientEntry] = useState({
    view: initialView,
    operations: initialOperationsOpen,
    path: returnPath,
  });
  useEffect(() => {
    setClientToday(todayInSeoul());
    setClientEntry(
      libraryEntry(Object.fromEntries(new URLSearchParams(location.search))),
    );
    let cancelled = false,
      runtime: LibraryRuntime | undefined,
      screenOwner: string | undefined,
      unsubscribe: (() => void) | undefined,
      lastRevision = -1,
      loadingOnlineOverview = false;
    const controller = new AbortController();
    const session = verifiedSyncOwner(controller.signal)
      .then((owner) => ({ owner, error: null as unknown }))
      .catch((error) => ({ owner: null, error }));
    async function attach(owner: string) {
      const storage = await openReplica(owner, {
        onInvalidated: () => {
          if (!cancelled)
            setStorageMessage(
              "기기 자료는 유지됩니다. 입력을 보관한 뒤 최신 버전으로 서재를 다시 열어 주세요.",
            );
        },
      });
      if (cancelled) {
        storage.close();
        return;
      }
      runtime?.close();
      unsubscribe?.();
      const cp = await storage.checkpoint(),
        next = createLibraryRuntime(owner, storage, cp);
      runtime = next;
      lastRevision = next.getSnapshot().revision;
      unsubscribe = next.subscribe(() => {
        const snapshot = next.getSnapshot();
        if (snapshot.accessDenied) {
          runtime = undefined;
          next.close();
          unsubscribe?.();
          setScreen(null);
          setAuth(true);
          setError("Google 계정으로 다시 로그인해 주세요.");
          return;
        }
        if (snapshot.ready && snapshot.revision !== lastRevision) {
          lastRevision = snapshot.revision;
          void next.repository
            .overview()
            .then((data) => {
              if (!cancelled && runtime === next)
                setScreen({ runtime: next, owner: next.owner, data });
            })
            .catch((e) => {
              if (!cancelled) setError(e.message);
            });
        }
      });
      if (cp?.complete) {
        const data = await next.repository.overview();
        if (!cancelled) {
          screenOwner = next.owner;
          setScreen({ runtime: next, owner: next.owner, data });
        }
      }
      return next;
    }
    void (async () => {
      try {
        let remembered: string | null = null;
        try {
          remembered = localStorage.getItem(offlineOwnerKey);
        } catch {}
        if (remembered) await attach(remembered);
        const verified = await session;
        if (cancelled) return;
        if (!verified.owner) {
          if (
            runtime?.getSnapshot().ready &&
            !(
              verified.error instanceof SyncHttpError &&
              verified.error.status === 403
            )
          ) {
            if (
              verified.error instanceof SyncHttpError &&
              verified.error.status === 401
            )
              runtime.requireAuthentication();
            return;
          }
          runtime?.close();
          setScreen(null);
          setAuth(true);
          setError(
            verified.error instanceof Error
              ? verified.error.message
              : "Google 계정으로 로그인해 주세요.",
          );
          return;
        }
        if (!runtime || runtime.owner !== verified.owner) {
          setScreen(null);
          await attach(verified.owner);
        }
        if (cancelled || !runtime) return;
        const current = runtime;
        current.verifyOwner(verified.owner);
        try {
          localStorage.setItem(offlineOwnerKey, verified.owner);
        } catch {}
        void current.sync({ reason: "startup" }).catch(() => {});
        if (!current.getSnapshot().ready) {
          loadingOnlineOverview = true;
          const response = await fetch("/api/library", {
            cache: "no-store",
            signal: controller.signal,
          });
          const data = await response.json();
          if (!response.ok)
            throw Error(data.error ?? "서재를 불러오지 못했습니다.");
          loadingOnlineOverview = false;
          const visible = await current.withPendingReading(data);
          if (
            !cancelled &&
            runtime === current &&
            !current.getSnapshot().ready
          ) {
            screenOwner = current.owner;
            setScreen({
              runtime: current,
              owner: current.owner,
              data: visible,
            });
          }
        }
      } catch (e) {
        // An unavailable device store must not prevent a verified online session.
        const verified = await session;
        // A transient online overview error says nothing about an already opened
        // store. Keep its partial copy and background coordinator attached.
        const partialRuntime = loadingOnlineOverview ? (runtime ?? null) : null;
        if (verified.owner && !cancelled) {
          try {
            const response = await fetch("/api/library", {
              cache: "no-store",
              signal: controller.signal,
            });
            if (!response.ok) throw Error("서재를 불러오지 못했습니다.");
            const data = await response.json();
            const visible = partialRuntime
              ? await partialRuntime.withPendingReading(data)
              : data;
            if (!cancelled && (!partialRuntime || runtime === partialRuntime)) {
              if (!partialRuntime) {
                runtime?.close();
                runtime = undefined;
              }
              screenOwner = verified.owner;
              setStorageMessage(
                partialRuntime
                  ? ""
                  : "기기 저장소를 사용할 수 없어 온라인으로 표시합니다. 기기 자료는 유지됩니다.",
              );
              setScreen({
                runtime: partialRuntime,
                owner: verified.owner,
                data: visible,
              });
              setAuth(false);
              return;
            }
          } catch {}
        }
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "기기 서재를 열지 못했습니다.",
          );
          setAuth(true);
        }
      }
    })();
    const resume = () => {
      setClientToday(todayInSeoul());
      if (runtime) void runtime.sync({ reason: "resume" }).catch(() => {});
    };
    const accountStorage = (event: StorageEvent) => {
      if (
        event.key === offlineOwnerKey &&
        (runtime || screenOwner) &&
        event.newValue !== (runtime?.owner ?? screenOwner)
      ) {
        runtime?.close();
        runtime = undefined;
        unsubscribe?.();
        setScreen(null);
        setAuth(true);
      }
    };
    const visibility = () => {
      if (document.visibilityState === "visible") resume();
    };
    window.addEventListener("online", resume);
    window.addEventListener("storage", accountStorage);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", visibility);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) resume();
    }, 60000);
    return () => {
      cancelled = true;
      controller.abort();
      unsubscribe?.();
      runtime?.close();
      window.clearInterval(interval);
      window.removeEventListener("online", resume);
      window.removeEventListener("storage", accountStorage);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [available]);
  if (screen) {
    const content = (
      <>
        {storageMessage && (
          <p className="replica-update-warning" role="alert">
            {storageMessage}
          </p>
        )}
        <LibraryApp
          key={screen.owner}
          initial={screen.data}
          today={clientToday}
          ownerId={screen.owner}
          initialView={clientEntry.view}
          initialOperationsOpen={clientEntry.operations}
        />
      </>
    );
    return screen.runtime ? (
      <ReplicaProvider runtime={screen.runtime}>{content}</ReplicaProvider>
    ) : (
      content
    );
  }
  if (!available || auth)
    return (
      <AuthPanel
        available={available}
        returnPath={clientEntry.path}
        message={error || undefined}
      />
    );
  return (
    <main className="replica-opening" role="status">
      <h1>나의 서재</h1>
      <p>{error || "기기 자료를 여는 중…"}</p>
    </main>
  );
}
