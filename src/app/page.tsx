import { configured, requireOwner } from "@/server/auth";
import { getStore } from "@/server/db";
import { LibraryError } from "@/server/library-store";
import { todayInSeoul } from "@/lib/domain";
import { LibraryApp } from "@/components/library-app";
import { AuthPanel } from "@/components/auth-panel";
import { libraryEntry } from "@/lib/library-entry";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const entry = libraryEntry(await searchParams);
  try {
    const owner = await requireOwner();
    const data = await getStore().overview(owner);
    return (
      <LibraryApp
        initial={data}
        today={todayInSeoul()}
        ownerId={owner}
        initialView={entry.view}
        initialOperationsOpen={entry.operations}
      />
    );
  } catch (e) {
    return (
      <AuthPanel
        returnPath={entry.path}
        available={configured()}
        message={
          e instanceof LibraryError && e.status !== 401
            ? e.message
            : !(e instanceof LibraryError)
              ? "서재 연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요."
              : undefined
        }
      />
    );
  }
}
