import { allocateRecommendationCandidates } from "./recommendation-candidates";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Book } from "../lib/domain";
import {
  ownedRecommendationOutputSchema,
  validateOwnedRecommendations,
  type OwnedRecommendationInput,
} from "../lib/owned-book-recommendations";
import {
  estimateOwnedRecommendations,
  generateOwnedRecommendations,
} from "../local/ai/owned-book-recommendations";
import type { OpenAiConfig } from "../local/ai/openai";
import { LibraryError, type Database, type Executor } from "./library-store";
import {
  reserveInTransaction,
  markSendingInTransaction,
  settleInTransaction,
} from "./ai-usage-store";
import { withSyncWrite } from "./sync/write";
import { serverAssistConfig } from "./server-assist";
import { compactBookSelect, attachCatalogCovers } from "./book-records";

type Recommendation = {
  bookId: string;
  format: "paper" | "pdf" | "logos";
  reason: string;
};
export interface BookRecommendationPage {
  recommendations: Recommendation[];
  books: Book[];
  updatedAt: string | null;
  request: {
    requestId: string;
    status: "sending" | "succeeded" | "failed" | "unknown";
    errorCode?: string;
    startedAt: string;
  } | null;
}
type Outcome = {
  status: "settled" | "unknown";
  valid: boolean;
  output: { recommendations: Recommendation[] } | null;
  costUsd: string | null;
  errorCode: string | null;
  usage: unknown;
  provenance: unknown;
};
type Dependencies = {
  config?: OpenAiConfig;
  generate?: (
    input: OwnedRecommendationInput,
    config: OpenAiConfig,
    operationId?: string,
  ) => Promise<Outcome>;
  estimate?: (input: OwnedRecommendationInput) => { maxCostUsd: string };
};
const formats = ["paper", "pdf", "logos"] as const;
const inputSchema = z.object({ requestId: z.string().uuid() }).strict();
const resultSchema = ownedRecommendationOutputSchema;
const unread =
  "NOT EXISTS(SELECT 1 FROM library_cycles c WHERE c.owner_id=b.owner_id AND c.book_id=b.id AND c.status IN ('reading','completed'))";
const today = "((now() AT TIME ZONE 'Asia/Seoul')::date)";
const metadata =
  "b.id,left(b.title,120) AS title,left(b.author,80) AS author,left(b.category,40) AS category";
function requireOwner(owner: string) {
  if (!owner || owner.length > 128)
    throw new LibraryError(401, "로그인이 필요합니다.");
}
function validOutput(
  input: OwnedRecommendationInput,
  raw: unknown,
): Recommendation[] | null {
  try {
    return validateOwnedRecommendations(input, raw).recommendations;
  } catch {
    return null;
  }
}
async function expire(tx: Executor, owner: string) {
  const expired = (
    await tx.query(
      "SELECT * FROM library_book_recommendation_requests WHERE owner_id=$1 AND status='sending' AND lease_expires_at<=now() FOR UPDATE",
      [owner],
    )
  ).rows;
  for (const row of expired) {
    await settleInTransaction(tx, owner, row.reservation_id, {
      status: "unknown",
    });
    await tx.query(
      "UPDATE library_book_recommendation_requests SET status='unknown',error_code='lease_expired',completed_at=now() WHERE owner_id=$1 AND request_id=$2",
      [owner, row.request_id],
    );
  }
}
async function selectInput(
  tx: Executor,
  owner: string,
  previous: string[],
): Promise<OwnedRecommendationInput> {
  const pools = { paper: [], pdf: [], logos: [] } as Record<
    "paper" | "pdf" | "logos",
    OwnedRecommendationInput["candidates"]
  >;
  for (const format of formats) {
    const rows = (
      await tx.query(
        `SELECT ${metadata},left(b.publisher,80) AS publisher,left(b.isbn,32) AS isbn,ARRAY(SELECT left(tag,30) FROM unnest(b.tags) WITH ORDINALITY AS t(tag,n) ORDER BY n LIMIT 5) AS tags FROM library_active_books b WHERE b.owner_id=$1 AND $2=ANY(b.formats) AND ${unread} ORDER BY (b.id=ANY($3::uuid[])),random() LIMIT 150`,
        [owner, format, previous],
      )
    ).rows;
    pools[format].push(
      ...rows.map((r) => ({
        id: r.id,
        title: r.title,
        author: r.author,
        category: r.category,
        format,
        publisher: r.publisher,
        isbn: r.isbn,
        tags: r.tags,
      })),
    );
  }
  const candidates = allocateRecommendationCandidates(pools);
  const reading = (
    await tx.query(
      `SELECT ${metadata},ARRAY(SELECT DISTINCT status FROM (SELECT 'reading' AS status WHERE bool_or(c.status='reading') UNION ALL SELECT 'completed' WHERE bool_or(c.status='completed' AND c.completed_on BETWEEN ${today}-29 AND ${today}) UNION ALL SELECT 'started' WHERE bool_or(c.started_on BETWEEN ${today}-29 AND ${today})) s ORDER BY status) AS statuses FROM library_active_books b JOIN library_cycles c ON c.owner_id=b.owner_id AND c.book_id=b.id WHERE b.owner_id=$1 GROUP BY b.id,b.title,b.author,b.category HAVING bool_or(c.status='reading' OR (c.status='completed' AND c.completed_on BETWEEN ${today}-29 AND ${today}) OR c.started_on BETWEEN ${today}-29 AND ${today}) ORDER BY b.id LIMIT 201`,
      [owner],
    )
  ).rows;
  if (reading.length > 200)
    throw new LibraryError(
      409,
      "독서 취향에 포함할 최근·현재 독서가 200권을 넘습니다. 독서 상태를 확인해 주세요.",
    );
  return {
    candidates,
    reading: reading.map((r) => ({
      id: r.id,
      title: r.title,
      author: r.author,
      category: r.category,
      statuses: r.statuses,
    })),
  };
}
async function readPage(
  tx: Executor,
  owner: string,
): Promise<BookRecommendationPage> {
  const state = (
    await tx.query(
      "SELECT * FROM library_book_recommendations WHERE owner_id=$1",
      [owner],
    )
  ).rows[0];
  if (!state)
    return { recommendations: [], books: [], updatedAt: null, request: null };
  const recent = (
    await tx.query(
      "SELECT request_id,status,error_code,started_at FROM library_book_recommendation_requests WHERE owner_id=$1 AND request_id=$2",
      [owner, state.active_request_id],
    )
  ).rows[0];
  const rows = resultSchema.safeParse({
    recommendations: state.recommendations,
  });
  const recommendations = rows.success ? rows.data.recommendations : [];
  const books = (
    await tx.query(
      `SELECT ${compactBookSelect} FROM library_active_books b WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND ${unread} LIMIT 9`,
      [owner, recommendations.map((r) => r.bookId)],
    )
  ).rows as Book[];
  await attachCatalogCovers(tx, owner, books);
  return JSON.parse(
    JSON.stringify({
      recommendations: recommendations.filter((r) =>
        books.some((b) => b.id === r.bookId && b.formats.includes(r.format)),
      ),
      books,
      updatedAt: state.generated_at,
      request: recent
        ? {
            requestId: recent.request_id,
            status: recent.status,
            ...(recent.error_code ? { errorCode: recent.error_code } : {}),
            startedAt: recent.started_at,
          }
        : null,
    }),
  );
}
export function createBookRecommendationStore(
  db: Database,
  deps: Dependencies = {},
) {
  const generate = deps.generate ?? generateOwnedRecommendations,
    estimate = deps.estimate ?? estimateOwnedRecommendations;
  return {
    async read(owner: string) {
      requireOwner(owner);
      const snapshot = await db.transaction(async (tx) => {
        await tx.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        );
        if (
          (
            await tx.query(
              "SELECT request_id FROM library_book_recommendation_requests WHERE owner_id=$1 AND status='sending' AND lease_expires_at<=now() LIMIT 1",
              [owner],
            )
          ).rows.length
        )
          return null;
        return readPage(tx, owner);
      });
      return (
        snapshot ??
        withSyncWrite(db, owner, async (tx) => {
          await expire(tx, owner);
          return readPage(tx, owner);
        })
      );
    },
    async refresh(
      owner: string,
      raw: unknown,
    ): Promise<BookRecommendationPage> {
      requireOwner(owner);
      const { requestId } = inputSchema.parse(raw);
      const claimed = await withSyncWrite(db, owner, async (tx) => {
        await tx.query(
          "INSERT INTO library_book_recommendations(owner_id) VALUES($1) ON CONFLICT DO NOTHING",
          [owner],
        );
        await tx.query(
          "SELECT owner_id FROM library_book_recommendations WHERE owner_id=$1 FOR UPDATE",
          [owner],
        );
        await expire(tx, owner);
        const old = (
          await tx.query(
            "SELECT request_id FROM library_book_recommendation_requests WHERE owner_id=$1 AND request_id=$2",
            [owner, requestId],
          )
        ).rows[0];
        if (old) return null;
        if (
          (
            await tx.query(
              "SELECT request_id FROM library_book_recommendation_requests WHERE owner_id=$1 AND status='sending' LIMIT 1",
              [owner],
            )
          ).rows.length
        )
          throw new LibraryError(
            409,
            "추천을 만들고 있습니다. 완료 후 다시 요청해 주세요.",
          );
        const configured = serverAssistConfig();
        const config = deps.config ?? configured.config;
        if (
          (!deps.config && !configured.ready) ||
          !config.apiKey.trim() ||
          config.model !== "gpt-6-luna"
        )
          throw new LibraryError(
            409,
            "서버 AI 연결과 고정 모델 설정을 확인해 주세요.",
          );
        const previous =
          (
            await tx.query(
              "SELECT candidate_ids FROM library_book_recommendation_requests WHERE owner_id=$1 ORDER BY started_at DESC,request_id DESC LIMIT 1",
              [owner],
            )
          ).rows[0]?.candidate_ids ?? [];
        const input = await selectInput(tx, owner, previous);
        if (!input.candidates.length)
          throw new LibraryError(409, "아직 읽지 않은 소장 도서가 없습니다.");
        const reservation = await reserveInTransaction(tx, owner, {
          operationId: requestId,
          phase: "runtime",
          maxCostUsd: estimate(input).maxCostUsd,
        });
        const lease = randomUUID();
        await tx.query(
          "INSERT INTO library_book_recommendation_requests(owner_id,request_id,status,reservation_id,candidate_ids,lease_token,lease_expires_at) VALUES($1,$2,'sending',$3,$4,$5,now()+interval '5 minutes')",
          [
            owner,
            requestId,
            reservation.id,
            input.candidates.map((c) => c.id),
            lease,
          ],
        );
        await tx.query(
          "UPDATE library_book_recommendations SET active_request_id=$2 WHERE owner_id=$1",
          [owner, requestId],
        );
        await markSendingInTransaction(tx, owner, reservation.id);
        return { input, config, reservationId: reservation.id, lease };
      });
      if (!claimed) return this.read(owner);
      let outcome: Outcome;
      try {
        outcome = await generate(claimed.input, claimed.config, requestId);
      } catch {
        outcome = {
          status: "unknown",
          valid: false,
          output: null,
          costUsd: null,
          errorCode: "transport_unknown",
          usage: null,
          provenance: null,
        };
      }
      return withSyncWrite(db, owner, async (tx) => {
        const current = (
          await tx.query(
            "SELECT * FROM library_book_recommendation_requests WHERE owner_id=$1 AND request_id=$2 AND lease_token=$3 FOR UPDATE",
            [owner, requestId, claimed.lease],
          )
        ).rows[0];
        if (!current || current.status !== "sending")
          return readPage(tx, owner);
        let recommendations =
          outcome.status === "settled" && outcome.valid
            ? validOutput(claimed.input, outcome.output)
            : null;
        let changed = false;
        if (recommendations) {
          const eligible = (
            await tx.query(
              `SELECT b.id,b.formats FROM library_active_books b WHERE b.owner_id=$1 AND b.id=ANY($2::uuid[]) AND ${unread}`,
              [owner, recommendations.map((r) => r.bookId)],
            )
          ).rows;
          if (
            recommendations.some(
              (r) =>
                !eligible.some(
                  (b) => b.id === r.bookId && b.formats.includes(r.format),
                ),
            )
          ) {
            recommendations = null;
            changed = true;
          }
        }
        const settled =
          outcome.status === "settled" && outcome.costUsd !== null;
        await settleInTransaction(
          tx,
          owner,
          claimed.reservationId,
          settled
            ? {
                status: "settled",
                costUsd: outcome.costUsd!,
                details: {
                  purpose: "owned_book_recommendations",
                  usage: outcome.usage,
                  provenance: outcome.provenance,
                },
              }
            : { status: "unknown" },
        );
        const status = settled
          ? recommendations
            ? "succeeded"
            : "failed"
          : "unknown";
        await tx.query(
          "UPDATE library_book_recommendation_requests SET status=$3,error_code=$4,completed_at=now() WHERE owner_id=$1 AND request_id=$2",
          [
            owner,
            requestId,
            status,
            status === "succeeded"
              ? null
              : changed
                ? "candidate_changed"
                : (outcome.errorCode ?? "invalid_output"),
          ],
        );
        if (status === "succeeded")
          await tx.query(
            "UPDATE library_book_recommendations SET recommendations=$3,latest_request_id=$2,generated_at=now() WHERE owner_id=$1 AND active_request_id=$2",
            [owner, requestId, JSON.stringify(recommendations)],
          );
        return readPage(tx, owner);
      });
    },
  };
}
