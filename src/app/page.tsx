import { configured } from "@/server/auth";
import { todayInSeoul } from "@/lib/domain";
import { ReplicaEntry } from "@/components/replica/entry";
import { libraryEntry } from "@/lib/library-entry";
import { privatePcOrigin } from "@/lib/pc-access";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const entry = libraryEntry(await searchParams);
  const pc = privatePcOrigin(process.env.LIBRARY_PC_ORIGIN);
  return (
    <ReplicaEntry
      available={configured()}
      today={todayInSeoul()}
      initialView={entry.view}
      initialOperationsOpen={entry.operations}
      returnPath={entry.path}
      deferPdfAutoSync={
        entry.view === "pdf" &&
        process.env.LIBRARY_PC_PRIVATE_CONFIRMED === "true" &&
        !!pc &&
        privatePcOrigin(process.env.APP_ORIGIN) === pc
      }
    />
  );
}
