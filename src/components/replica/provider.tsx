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
export function ReplicaProvider({
  runtime,
  children,
}: {
  runtime: LibraryRuntime;
  children: React.ReactNode;
}) {
  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  useLayoutEffect(() => registerLibraryRuntime(runtime), [runtime]);
  const value = useMemo(() => ({ runtime, ...snapshot }), [runtime, snapshot]);
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
