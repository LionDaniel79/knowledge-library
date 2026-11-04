import { configured } from "@/server/auth";
import { todayInSeoul } from "@/lib/domain";
import { ReplicaEntry } from "@/components/replica/entry";
export const dynamic = "force-dynamic";
export default async function Page(_props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ReplicaEntry available={configured()} today={todayInSeoul()} />;
}
