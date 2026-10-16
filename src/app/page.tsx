import { configured, requireOwner } from "@/server/auth";
import { getStore } from "@/server/db";
import { LibraryError } from "@/server/library-store";
import { todayInSeoul } from "@/lib/domain";
import { LibraryApp } from "@/components/library-app";
import { AuthPanel } from "@/components/auth-panel";
export const dynamic = "force-dynamic";
export default async function Page() {
  try {
    const owner = await requireOwner();
    const data = await getStore().overview(owner);
    return <LibraryApp initial={data} today={todayInSeoul()} ownerId={owner} />;
  } catch (e) {
    return (
      <AuthPanel
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
