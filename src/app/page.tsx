import { configured } from "@/server/auth";
import { todayInSeoul } from "@/lib/domain";
import { ReplicaEntry } from "@/components/replica/entry";
import { libraryEntry } from "@/lib/library-entry";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const entry = libraryEntry(await searchParams);
  return (
    <ReplicaEntry
      available={configured()}
      today={todayInSeoul()}
      initialView={entry.view}
      initialOperationsOpen={entry.operations}
      returnPath={entry.path}
    />
  );
}
