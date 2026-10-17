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
      runtime: LibraryRuntime;
      data: Library;
    } | null>(null),
    [auth, setAuth] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!available) return;
    let cancelled = false,
      runtime: LibraryRuntime | undefined,
      unsubscribe: (() => void) | undefined,
      lastRevision = -1;
    const controller = new AbortController();
    const session = verifiedSyncOwner(controller.signal)
      .then((owner) => ({ owner, error: null as unknown }))
      .catch((error) => ({ owner: null, error }));
    async function attach(owner: string) {
      const storage = await openReplica(owner);
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
        if (snapshot.ready && snapshot.revision !== lastRevision) {
          lastRevision = snapshot.revision;
          void next.repository
            .overview()
            .then((data) => {
              if (!cancelled && runtime === next)
                setScreen({ runtime: next, data });
            })
            .catch((e) => {
              if (!cancelled) setError(e.message);
            });
        }
      });
      if (cp?.complete) {
        const data = await next.repository.overview();
        if (!cancelled) setScreen({ runtime: next, data });
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
          const response = await fetch("/api/library", {
            cache: "no-store",
            signal: controller.signal,
          });
          const data = await response.json();
          if (!response.ok)
            throw Error(data.error ?? "서재를 불러오지 못했습니다.");
          if (!cancelled && runtime === current && !current.getSnapshot().ready)
            setScreen({ runtime: current, data });
        }
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "기기 서재를 열지 못했습니다.",
          );
          setAuth(true);
        }
      }
    })();
    const resume = () => {
      if (runtime) void runtime.sync({ reason: "resume" }).catch(() => {});
    };
    const visibility = () => {
      if (document.visibilityState === "visible") resume();
    };
    window.addEventListener("online", resume);
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
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [available]);
  if (screen)
    return (
      <ReplicaProvider runtime={screen.runtime}>
        <LibraryApp
          key={screen.runtime.owner}
          initial={screen.data}
          today={today ?? todayInSeoul()}
          ownerId={screen.runtime.owner}
          initialView={initialView}
          initialOperationsOpen={initialOperationsOpen}
        />
      </ReplicaProvider>
    );
  if (!available || auth)
    return (
      <AuthPanel
        available={available}
        returnPath={returnPath}
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
