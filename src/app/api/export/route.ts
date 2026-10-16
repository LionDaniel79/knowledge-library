import { curationMarkdown } from "@/server/curation-export";
import { requireOwner } from "@/server/auth";
import { getStore } from "@/server/db";
import { failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const owner = await requireOwner();
    const backup = await getStore().exportLibrary(owner);
    const markdown =
      new URL(request.url).searchParams.get("format") === "markdown";
    const body = markdown
      ? "# 내 기록\n\n" +
        backup.library.notes
          .map((n) => `## ${n.title}\n\n${n.content}\n\n작성: ${n.createdAt}\n`)
          .join("\n") +
        "\n" +
        curationMarkdown(backup.curation) +
        "\n## 원자료 참조와 판단 이력\n\n```json\n" +
        JSON.stringify(
          {
            documents: backup.documents,
            connections: backup.connections,
            thoughtMap: backup.thoughtMap,
            revisions: backup.revisions,
          },
          null,
          2,
        ) +
        "\n```\n"
      : JSON.stringify(backup, null, 2);
    return new Response(body, {
      headers: {
        "Content-Type": markdown
          ? "text/markdown; charset=utf-8"
          : "application/json; charset=utf-8",
        "Content-Disposition":
          'attachment; filename="reading-library-' +
          new Date().toISOString().slice(0, 10) +
          (markdown ? '.md"' : '.json"'),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return failure(e);
  }
}
