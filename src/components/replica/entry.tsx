"use client";
import { useEffect, useRef, useState } from "react";
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
import { readStartup, clearStartup } from "@/client/replica/startup-cache";
export function ReplicaEntry({
  available,
  today,
  initialView = "home",
  initialOperationsOpen = false,
  returnPath = "/",
  deferPdfAutoSync = false,
}: {
  available: boolean;
  today?: string;
  initialView?: "home" | "pdf";
  initialOperationsOpen?: boolean;
  returnPath?: string;
  deferPdfAutoSync?: boolean;
}) {
  const automaticSyncDeferred = useRef(
    deferPdfAutoSync && initialView === "pdf",
  );
  const [screen, setScreen] = useState<{
      runtime: LibraryRuntime | null;
      owner: string;
      data: Library;
      authorizeNetwork: () => Promise<void>;
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
    const entry = libraryEntry(
      Object.fromEntries(new URLSearchParams(location.search)),
    );
    setClientEntry(entry);
    automaticSyncDeferred.current = deferPdfAutoSync && entry.view === "pdf";
    let cancelled = false,
      accountChanged = false,
      hasScreen = false,
      attachment = 0,
      runtime: LibraryRuntime | undefined,
      screenOwner: string | undefined,
      unsubscribe: (() => void) | undefined,
      lastRevision = -1,
      loadingOnlineOverview = false;
    const controller = new AbortController();
    const alive = () => !cancelled && !accountChanged;
    const session = verifiedSyncOwner(controller.signal)
      .then((owner) => ({ owner, error: null as unknown }))
      .catch((error) => ({ owner: null, error }));
    const guards = new Map<string, () => Promise<void>>();
    function accessFor(owner: string) {
      if (!guards.has(owner))
        guards.set(owner, async () => {
          let result = await session;
          if (
            !result.owner &&
            !(
              result.error instanceof SyncHttpError &&
              result.error.status === 403
            )
          )
            result = {
              owner: await verifiedSyncOwner(controller.signal),
              error: null,
            };
          if (!alive())
            throw new DOMException("서재 계정이 변경되었습니다.", "AbortError");
          if (!result.owner) throw result.error;
          if (result.owner !== owner)
            throw new SyncHttpError(403, "서재 계정이 변경되었습니다.");
        });
      return guards.get(owner)!;
    }
    async function attach(owner: string) {
      const ticket = ++attachment;
      const storage = await openReplica(owner, {
        onInvalidated: () => {
          if (!cancelled)
            setStorageMessage(
              "기기 자료는 유지됩니다. 입력을 보관한 뒤 최신 버전으로 서재를 다시 열어 주세요.",
            );
        },
      });
      if (!alive() || ticket !== attachment) {
        storage.close();
        return;
      }
      const cp = await storage.checkpoint();
      if (!alive() || ticket !== attachment) {
        storage.close();
        return;
      }
      runtime?.close();
      unsubscribe?.();
      const next = createLibraryRuntime(owner, storage, cp);
      runtime = next;
      // Keep the same mounted app, including any form already being written.
      setScreen((s) => (s?.owner === owner ? { ...s, runtime: next } : s));
      let overviewTicket = 0;
      const refreshOverview = () => {
        const ticket = ++overviewTicket;
        void next.repository
          .overview()
          .then((data) => {
            if (alive() && runtime === next && ticket === overviewTicket) {
              screenOwner = next.owner;
              hasScreen = true;
              setScreen({
                runtime: next,
                owner: next.owner,
                data,
                authorizeNetwork: accessFor(next.owner),
              });
            }
          })
          .catch((e) => {
            if (alive() && runtime === next) setError(e.message);
          });
      };
      lastRevision = next.getSnapshot().revision;
      unsubscribe = next.subscribe(() => {
        const snapshot = next.getSnapshot();
        if (snapshot.accessDenied) {
          accountChanged = true;
          try {
            clearStartup(localStorage, next.owner);
            if (localStorage.getItem(offlineOwnerKey) === next.owner)
              localStorage.removeItem(offlineOwnerKey);
          } catch {}
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
          refreshOverview();
        }
      });
      if (cp?.complete) refreshOverview();
      return next;
    }
    void (async () => {
      try {
        let remembered: string | null = null;
        try {
          remembered = localStorage.getItem(offlineOwnerKey);
          if (remembered) {
            screenOwner = remembered;
            const cached = readStartup(localStorage, remembered);
            if (cached) {
              hasScreen = true;
              setScreen({
                runtime: null,
                owner: remembered,
                data: cached,
                authorizeNetwork: accessFor(remembered),
              });
            }
          }
        } catch {}
        // Account verification and opening the database must not block each
        // other: a denied/changed session hides its cached view immediately.
        const rememberedAttachment = remembered
          ? attach(remembered).then(
              (value) => ({ value, error: null as unknown }),
              (error) => ({ value: undefined, error }),
            )
          : null;
        const verified = await session;
        if (!alive()) return;
        if (!verified.owner) {
          if (!(
            verified.error instanceof SyncHttpError &&
            verified.error.status === 403
          ))
            await rememberedAttachment;
          if (!alive()) return;
          if (
            (runtime?.getSnapshot().ready || hasScreen) &&
            !(
              verified.error instanceof SyncHttpError &&
              verified.error.status === 403
            )
          ) {
            if (
              verified.error instanceof SyncHttpError &&
              verified.error.status === 401
            )
              runtime?.requireAuthentication();
            return;
          }
          runtime?.close();
          runtime = undefined;
          ++attachment;
          if (
            remembered &&
            verified.error instanceof SyncHttpError &&
            verified.error.status === 403
          )
            try {
              clearStartup(localStorage, remembered);
              if (localStorage.getItem(offlineOwnerKey) === remembered)
                localStorage.removeItem(offlineOwnerKey);
            } catch {}
          setScreen(null);
          setAuth(true);
          setError(
            verified.error instanceof Error
              ? verified.error.message
              : "Google 계정으로 로그인해 주세요.",
          );
          return;
        }
        if (remembered === verified.owner && rememberedAttachment) {
          const attached = await rememberedAttachment;
          if (!alive()) return;
          if (attached.error) throw attached.error;
        } else {
          hasScreen = false;
          setScreen(null);
          await attach(verified.owner);
        }
        if (!alive() || !runtime) return;
        const current = runtime;
        current.verifyOwner(verified.owner);
        try {
          localStorage.setItem(offlineOwnerKey, verified.owner);
        } catch {}
        // A private PDF search needs its online index, not a second full
        // business-data copy in this origin's separate browser storage.
        if (!automaticSyncDeferred.current)
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
          if (alive() && runtime === current && !current.getSnapshot().ready) {
            screenOwner = current.owner;
            hasScreen = true;
            setScreen({
              runtime: current,
              owner: current.owner,
              data: visible,
              authorizeNetwork: accessFor(current.owner),
            });
          }
        }
      } catch (e) {
        // An unavailable device store must not prevent a verified online session.
        const verified = await session;
        // A transient online overview error says nothing about an already opened
        // store. Keep its partial copy and background coordinator attached.
        const partialRuntime = loadingOnlineOverview ? (runtime ?? null) : null;
        if (verified.owner && alive()) {
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
            if (alive() && (!partialRuntime || runtime === partialRuntime)) {
              if (!partialRuntime) {
                runtime?.close();
                runtime = undefined;
              }
              screenOwner = verified.owner;
              hasScreen = true;
              setStorageMessage(
                partialRuntime
                  ? ""
                  : "기기 저장소를 사용할 수 없어 온라인으로 표시합니다. 기기 자료는 유지됩니다.",
              );
              setScreen({
                runtime: partialRuntime,
                owner: verified.owner,
                data: visible,
                authorizeNetwork: accessFor(verified.owner),
              });
              setAuth(false);
              return;
            }
          } catch {}
        }
        if (alive()) {
          if (
            verified.error instanceof SyncHttpError &&
            verified.error.status === 403
          ) {
            try {
              if (screenOwner) clearStartup(localStorage, screenOwner);
              if (localStorage.getItem(offlineOwnerKey) === screenOwner)
                localStorage.removeItem(offlineOwnerKey);
            } catch {}
            setScreen(null);
          }
          setError(
            e instanceof Error ? e.message : "기기 서재를 열지 못했습니다.",
          );
          setAuth(true);
        }
      }
    })();
    // A first launch after upgrading has no small saved view yet. Do not leave
    // it behind an indefinitely delayed database/index. This verified overview
    // only paints the UI; it never replaces the complete replica or its outbox.
    const firstScreenTimer = window.setTimeout(() => {
      if (!alive() || hasScreen || loadingOnlineOverview) return;
      void (async () => {
        try {
          const verified = await session;
          if (!verified.owner || !alive() || hasScreen) return;
          const response = await fetch("/api/library", {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok) return;
          const data = await response.json(),
            current = runtime;
          if (current && current.owner !== verified.owner) return;
          const status = current?.getSnapshot().status;
          const visible =
            current &&
            status &&
            (status.pending || status.conflicts || status.failed)
              ? await current.withPendingReading(data)
              : data;
          if (!alive() || hasScreen || (current && runtime !== current)) return;
          screenOwner = verified.owner;
          hasScreen = true;
          setScreen({
            runtime: current ?? null,
            owner: verified.owner,
            data: visible,
            authorizeNetwork: accessFor(verified.owner),
          });
        } catch {
          /* Keep the saved device copy and its normal opening path. */
        }
      })();
    }, 1800);
    const resume = () => {
      setClientToday(todayInSeoul());
      if (runtime && !automaticSyncDeferred.current)
        void runtime.sync({ reason: "resume" }).catch(() => {});
    };
    const accountStorage = (event: StorageEvent) => {
      if (
        event.key === offlineOwnerKey &&
        (runtime || screenOwner) &&
        event.newValue !== (runtime?.owner ?? screenOwner)
      ) {
        accountChanged = true;
        controller.abort();
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
      window.clearTimeout(firstScreenTimer);
      controller.abort();
      unsubscribe?.();
      runtime?.close();
      window.clearInterval(interval);
      window.removeEventListener("online", resume);
      window.removeEventListener("storage", accountStorage);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [available, deferPdfAutoSync]);
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
          onLibraryView={() => {
            if (!automaticSyncDeferred.current) return;
            automaticSyncDeferred.current = false;
            void screen.runtime?.sync({ reason: "resume" }).catch(() => {});
          }}
        />
      </>
    );
    return (
      <ReplicaProvider
        runtime={screen.runtime}
        authorizeNetwork={screen.authorizeNetwork}
      >
        {content}
      </ReplicaProvider>
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
