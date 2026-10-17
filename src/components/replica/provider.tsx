"use client";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { LibraryRuntime } from "@/client/replica/runtime";
import { registerLibraryRuntime } from "@/client/replica/request";
const ReplicaContext = createContext<
  | ({ runtime: LibraryRuntime } & ReturnType<LibraryRuntime["getSnapshot"]>)
  | null
>(null);
const noSubscribe = () => () => {};
const noSnapshot = () => null;
export function ReplicaProvider({
  runtime,
  authorizeNetwork,
  children,
}: {
  runtime: LibraryRuntime | null;
  authorizeNetwork?: () => Promise<void>;
  children: React.ReactNode;
}) {
  const snapshot = useSyncExternalStore(
    runtime?.subscribe ?? noSubscribe,
    runtime?.getSnapshot ?? noSnapshot,
    runtime?.getSnapshot ?? noSnapshot,
  );
  useLayoutEffect(
    () => registerLibraryRuntime(runtime, authorizeNetwork),
    [runtime, authorizeNetwork],
  );
  const value = useMemo(
    () => (runtime && snapshot ? { runtime, ...snapshot } : null),
    [runtime, snapshot],
  );
  return (
    <ReplicaContext.Provider value={value}>{children}</ReplicaContext.Provider>
  );
}
export const useReplicaOptional = () => useContext(ReplicaContext);
export function useReplica() {
  const value = useReplicaOptional();
  if (!value) throw Error("기기 서재를 먼저 연결해 주세요.");
  return value;
}
