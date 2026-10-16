import { requireOwner } from "@/server/auth";
import { searchBookMetadata } from "@/server/book-lookup";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
export const runtime = "nodejs";
export const maxDuration = 60;
const cache = new Map<
  string,
  { until: number; result: Awaited<ReturnType<typeof searchBookMetadata>> }
>();
const limits = new Map<string, number[]>();
export async function GET(request: Request) {
  try {
    const owner = await requireOwner(),
      q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    if (q.length < 2 || q.length > 200)
      throw new LibraryError(400, "제목이나 ISBN을 입력해 주세요.");
    const now = Date.now(),
      prior = cache.get(q);
    if (prior && prior.until > now)
      return Response.json(prior.result, {
        headers: { "Cache-Control": "private, no-store" },
      });
    const attempts = (limits.get(owner) ?? []).filter((t) => now - t < 60000);
    if (attempts.length >= 12)
      throw new LibraryError(429, "잠시 후 다시 검색해 주세요.");
    limits.set(owner, [...attempts, now]);
    if (limits.size > 1000)
      for (const [id, times] of limits)
        if (times.every((t) => now - t >= 60000)) limits.delete(id);
    const result = await searchBookMetadata(q);
    if (result.items.length) {
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(q, { until: now + 300000, result });
    }
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return failure(e);
  }
}
