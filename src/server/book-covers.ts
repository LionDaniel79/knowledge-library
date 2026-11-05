import { withSyncWrite } from "./sync/write";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { type Database, type Executor, LibraryError } from "./library-store";
function ownerRequired(owner: string) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
}
const maxAssets = 20000,
  maxBytes = 200 * 1024 * 1024;
export async function readCoverCapacity(db: Executor, owner: string) {
  ownerRequired(owner);
  const usage = (
    await db.query(
      "SELECT count(*)::int AS n,coalesce(sum(length(data_base64)),0)::bigint AS bytes FROM library_cover_assets WHERE owner_id=$1",
      [owner],
    )
  ).rows[0];
  const assets = Number(usage.n),
    encodedBytes = Number(usage.bytes);
  return {
    assets,
    encodedBytes,
    maxAssets,
    maxBytes,
    remainingAssets: Math.max(0, maxAssets - assets),
    remainingBytes: Math.max(0, maxBytes - encodedBytes),
  };
}
export async function prepareCover(input: Buffer) {
  if (input.length > 8 * 1024 * 1024)
    throw new LibraryError(413, "표지는 8MB 이하로 선택해 주세요.");
  let bytes: Buffer;
  try {
    const decoder = sharp(input, {
        limitInputPixels: 24000000,
        failOn: "error",
      }),
      meta = await decoder.metadata();
    if (
      !["jpeg", "png", "webp", "gif"].includes(meta.format ?? "") ||
      (meta.format === "gif" &&
        ((meta.width ?? 0) < 40 || (meta.height ?? 0) < 40)) ||
      (meta.pages ?? 1) > 1
    )
      throw Error("format");
    bytes = await decoder
      .rotate()
      .resize({
        width: 800,
        height: 1200,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 78 })
      .toBuffer();
  } catch {
    throw new LibraryError(400, "JPG·PNG·WebP 이미지 파일을 선택해 주세요.");
  }
  if (bytes.length > 500000)
    throw new LibraryError(
      413,
      "이미지가 너무 복잡합니다. 크기를 줄여 주세요.",
    );
  const hash = createHash("sha256").update(bytes).digest("hex");

  return { bytes, hash };
}

/** Caller owns the sync transaction; never opens a nested database transaction. */
export async function storePreparedCover(
  tx: Executor,
  owner: string,
  prepared: Awaited<ReturnType<typeof prepareCover>>,
) {
  ownerRequired(owner);
  const { bytes, hash } = prepared;

  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    owner + ":covers",
  ]);
  const existing = (
    await tx.query(
      "SELECT id FROM library_cover_assets WHERE owner_id=$1 AND sha256=$2",
      [owner, hash],
    )
  ).rows[0];
  let id = existing?.id;
  if (!id) {
    const usage = await readCoverCapacity(tx, owner);
    if (
      !usage.remainingAssets ||
      Math.ceil((bytes.length * 4) / 3) > usage.remainingBytes
    )
      throw new LibraryError(
        409,
        "표지 저장 공간이 부족합니다. 저장 공간을 확인해 주세요.",
      );
    id = randomUUID();
    await tx.query(
      "INSERT INTO library_cover_assets(id,owner_id,sha256,data_base64,mime) VALUES($1,$2,$3,$4,'image/webp')",
      [id, owner, hash, bytes.toString("base64")],
    );
  }
  return { id: String(id), url: "/api/book-covers/" + id };
}

export function createCoverStore(db: Database) {
  async function readConditional(owner: string, id: string, ifNoneMatch = "") {
    ownerRequired(owner);
    z.string().uuid().parse(id);
    const hashes = ifNoneMatch
      .split(",")
      .map((tag) => tag.trim().replace(/^W\//, ""))
      .filter((tag) => /^"[a-fA-F0-9]{64}"$/.test(tag))
      .map((tag) => tag.slice(1, -1));
    // Ownership is checked on every request, including cache hits. Unchanged
    // replies do not read the large base64 value out of Postgres.
    const row = (
      await db.query(
        "SELECT sha256,mime,CASE WHEN $4::boolean OR sha256=ANY($3::text[]) THEN NULL ELSE data_base64 END AS data_base64 FROM library_cover_assets WHERE owner_id=$1 AND id=$2",
        [owner, id, hashes, ifNoneMatch.trim() === "*"],
      )
    ).rows[0];
    if (!row) throw new LibraryError(404, "표지를 찾을 수 없습니다.");
    return {
      bytes:
        row.data_base64 === null
          ? null
          : Buffer.from(row.data_base64, "base64"),
      mime: String(row.mime),
      etag: `"${row.sha256}"`,
    };
  }
  return {
    readConditional,
    async upload(owner: string, input: Buffer) {
      ownerRequired(owner);
      const prepared = await prepareCover(input);
      return withSyncWrite(db, owner, (tx) =>
        storePreparedCover(tx, owner, prepared),
      );
    },
    async read(owner: string, id: string) {
      const image = await readConditional(owner, id);
      return { bytes: image.bytes!, mime: image.mime };
    },
  };
}
