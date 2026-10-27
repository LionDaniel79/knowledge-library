import { z } from "zod";
import {
  createLibraryStore,
  LibraryError,
  type Database,
} from "./library-store";
import { noteInput } from "../lib/domain";
import { readNoteDetail, readNotePage } from "./record-catalog";
import { readMinistryBookCover } from "./ministry-book-cover";

export const MINISTRY_ORIGIN = "https://ministry-manager-blush.vercel.app";
export function authorizeMinistryClaims(
  value: unknown,
  ownerEmail: string,
): string {
  const p = value as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    firebase?: { identities?: Record<string, unknown> };
  };
  const google = p?.firebase?.identities?.["google.com"];
  if (
    !ownerEmail ||
    typeof p?.sub !== "string" ||
    !p.sub ||
    p.sub.length > 128 ||
    p.email_verified !== true ||
    typeof p.email !== "string" ||
    p.email.toLowerCase() !== ownerEmail.trim().toLowerCase() ||
    !Array.isArray(google) ||
    !google.some((value) => typeof value === "string" && value.length)
  )
    throw new LibraryError(401, "지식서재와 같은 Google 계정으로 연결하세요.");
  return p.sub;
}
const id = z.string().uuid(),
  offset = z.number().int().min(0).max(100000).default(0);
const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("reading") }).strict(),
  z.object({ action: z.literal("book"), id, offset }).strict(),
  z.object({ action: z.literal("note"), id }).strict(),
  z.object({ action: z.literal("cover"), id }).strict(),
  z
    .object({
      action: z.literal("update-progress"),
      requestId: id,
      progress: z
        .object({
          id,
          expectedVersion: z.number().int().positive(),
          currentPage: z.number().int().min(0).max(100000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({ action: z.literal("add-note"), requestId: id, note: noteInput })
    .strict(),
]);
const noteDto = (n: Record<string, any>) =>
  Object.fromEntries(
    [
      "id",
      "bookId",
      "title",
      "content",
      "kind",
      "page",
      "tags",
      "version",
      "createdAt",
      "updatedAt",
      "summary",
    ]
      .filter((k) => n[k] !== undefined)
      .map((k) => [k, n[k]]),
  );
const bookSelect =
  'b.id,b.title,b.author,b.publisher,b.isbn,b.formats,b.total_pages AS "totalPages",b.tags,b.category';
export function createMinistryEndpoint(options: {
  db: Database;
  ownerId: string;
  ownerEmail: string;
  verifyToken: (token: string) => Promise<unknown>;
  allowDevelopment?: boolean;
}) {
  const origins = [
    MINISTRY_ORIGIN,
    ...(options.allowDevelopment ? ["http://127.0.0.1:4174"] : []),
  ];
  return async (request: Request) => {
    const origin = request.headers.get("origin") || "";
    const headers: Record<string, string> = {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Origin",
    };
    if (origins.includes(origin))
      headers["Access-Control-Allow-Origin"] = origin;
    const json = (body: unknown, status = 200) =>
      Response.json(body, { status, headers });
    try {
      if (!origins.includes(origin))
        throw new LibraryError(403, "목회 도움 앱에서 다시 요청해 주세요.");
      if (request.method === "OPTIONS")
        return new Response(null, {
          status: 204,
          headers: {
            ...headers,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Max-Age": "600",
          },
        });
      if (request.method !== "POST")
        throw new LibraryError(405, "지원하지 않는 요청입니다.");
      if (!options.ownerId || !options.ownerEmail)
        throw new LibraryError(
          503,
          "지식서재 소유자 연결 설정을 확인해 주세요.",
        );
      const token = request.headers
        .get("authorization")
        ?.match(/^Bearer (\S+)$/)?.[1];
      if (!token)
        throw new LibraryError(401, "LM의 Google 계정으로 먼저 연결하세요.");
      let claims: unknown;
      try {
        claims = await options.verifyToken(token);
      } catch {
        throw new LibraryError(401, "Google 계정 연결을 다시 확인해 주세요.");
      }
      authorizeMinistryClaims(claims, options.ownerEmail);
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new LibraryError(400, "요청 형식을 확인하세요.");
      const reader = request.body?.getReader(),
        parts: Uint8Array[] = [];
      let length = 0;
      if (reader)
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 256000) {
            await reader.cancel();
            throw new LibraryError(413, "메모가 너무 깁니다.");
          }
          parts.push(value);
        }
      const bytes = new Uint8Array(length);
      let at = 0;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.length;
      }
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new LibraryError(400, "요청 내용을 확인하세요.");
      }
      const command = input.parse(body),
        owner = options.ownerId;
      if (command.action === "status")
        return json({ configured: true, connected: true });
      if (command.action === "cover") {
        const image = await readMinistryBookCover(
          options.db,
          owner,
          command.id,
        );
        return new Response(new Uint8Array(image.bytes), {
          headers: { ...headers, "Content-Type": image.mime },
        });
      }
      if (command.action === "reading") {
        const rows = (
          await options.db.query(
            `SELECT ${bookSelect},c.id AS "cycleId",c.version AS "cycleVersion",c.current_page AS "currentPage",c.started_on::text AS "startedOn" FROM library_active_cycles c JOIN library_active_books b ON b.owner_id=c.owner_id AND b.id=c.book_id WHERE c.owner_id=$1 AND c.status='reading' ORDER BY c.created_at,c.id LIMIT 1001`,
            [owner],
          )
        ).rows;
        if (rows.length > 1000)
          throw new LibraryError(
            413,
            "읽는 책이 너무 많습니다. 지식서재에서 목록을 정리해 주세요.",
          );
        return json({ items: rows });
      }
      if (command.action === "book") {
        const book = (
          await options.db.query(
            `SELECT ${bookSelect} FROM library_active_books b WHERE b.owner_id=$1 AND b.id=$2`,
            [owner, command.id],
          )
        ).rows[0];
        if (!book) throw new LibraryError(404, "책을 찾을 수 없습니다.");
        const notes = await readNotePage(options.db, owner, {
          book: command.id,
          limit: 10,
          offset: command.offset,
        });
        return json({
          book,
          notes: { ...notes, items: notes.items.map(noteDto) },
        });
      }
      if (command.action === "note")
        return json({
          note: noteDto(await readNoteDetail(options.db, owner, command.id)),
        });
      if (command.action === "update-progress")
        return json(
          await createLibraryStore(options.db).mutate(owner, {
            requestId: command.requestId,
            type: "updateProgress",
            payload: command.progress,
          }),
        );
      return json(
        await createLibraryStore(options.db).mutate(owner, {
          requestId: command.requestId,
          type: "addNote",
          payload: command.note,
        }),
      );
    } catch (error) {
      if (error instanceof LibraryError)
        return json({ message: error.message }, error.status);
      if (error instanceof z.ZodError)
        return json({ message: "입력 내용을 확인하세요." }, 400);
      return json(
        {
          message:
            "지식서재에 연결하지 못했습니다. 입력한 내용을 유지하고 다시 시도해 주세요.",
        },
        503,
      );
    }
  };
}
