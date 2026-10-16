import { stat, readFile, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, isAbsolute } from "node:path";
import { z } from "zod";
import { resolvePdfPath } from "./pdf-access";
import { withPdfIndex } from "./pdf-index";
import { LibraryError, type Executor } from "./library-store";
import { atomicWriteJson } from "../local/atomic-json";
const verified = new Map<string, string>();
export async function verifyRelocatedPdf(
  root: string,
  relativePath: string,
  bytes: number,
  sha256: string,
) {
  if (!/^[0-9a-f]{64}$/.test(sha256))
    throw new LibraryError(409, "원본의 확인 정보가 없습니다.");
  const file = await resolvePdfPath(resolve(root, relativePath), root),
    before = await stat(file, { bigint: true });
  if (Number(before.size) !== bytes)
    throw new LibraryError(409, "원본과 다른 PDF입니다.");
  const key = `${file}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
  if (verified.get(key) !== sha256) {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    for await (const chunk of stream) hash.update(chunk);
    // Windows can retain old write timestamps until the final file handle closes.
    await new Promise<void>((done, fail) =>
      stream.close((error) => (error ? fail(error) : done())),
    );
    const after = await stat(file, { bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      hash.digest("hex") !== sha256
    )
      throw new LibraryError(409, "원본과 다른 PDF입니다.");
    if (verified.size > 1000) verified.clear();
    verified.set(key, sha256);
  }
  return file;
}
function configPath() {
  if (
    !process.env.LIBRARY_PDF_INDEX ||
    !process.env.LIBRARY_PDF_ROOT ||
    process.env.VERCEL
  )
    throw new LibraryError(503, "내 PC의 서재에서 폴더를 연결해 주세요.");
  return process.env.LIBRARY_PDF_INDEX + ".connection.json";
}
async function config() {
  try {
    return JSON.parse(await readFile(configPath(), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 0 };
    throw e;
  }
}
export async function connectedPdf(
  doc: {
    id: string;
    path: string;
    relative_path: string;
    bytes: string | number;
    mtime_ns: string;
  },
  owner: string,
) {
  const mapping = process.env.LIBRARY_PDF_INDEX
      ? await config()
      : { version: 0 },
    root = process.env.LIBRARY_PDF_ROOT!;
  let path: string;
  if (mapping.version && mapping.owner === owner) {
    const original = withPdfIndex((db) =>
      db
        .prepare("SELECT sha256,signature FROM documents WHERE id=?")
        .get(doc.id),
    );
    if (!original || original.signature !== `${doc.bytes}:${doc.mtime_ns}`)
      throw new LibraryError(409, "색인의 원본 정보가 달라졌습니다.");
    path = await verifyRelocatedPdf(
      mapping.root,
      doc.relative_path,
      Number(doc.bytes),
      String(original.sha256),
    );
  } else {
    path = await resolvePdfPath(doc.path, root);
    const info = await stat(path, { bigint: true });
    if (`${info.size}:${info.mtimeNs}` !== `${doc.bytes}:${doc.mtime_ns}`)
      throw new LibraryError(409, "원본 파일이 변경되었습니다.");
  }
  return {
    path,
    signature: `${doc.bytes}:${doc.mtime_ns}`,
    actualSignature: await stat(path, { bigint: true }).then(
      (s) => `${s.size}:${s.mtimeNs}`,
    ),
  };
}
export async function pdfConnectionState() {
  try {
    const c = await config();
    return {
      available: true,
      version: c.version,
      connected: !!c.version,
      root: c.root ?? process.env.LIBRARY_PDF_ROOT,
    };
  } catch {
    return { available: false, version: 0, connected: false };
  }
}
export async function previewPdfConnection(
  db: Executor,
  owner: string,
  raw: unknown,
) {
  configPath();
  const p = z.object({ root: z.string().trim().min(1).max(1000) }).parse(raw);
  if (!isAbsolute(p.root))
    throw new LibraryError(400, "폴더의 전체 경로를 입력하세요.");
  const root = await realpath(p.root);
  if (!(await stat(root)).isDirectory())
    throw new LibraryError(400, "폴더를 선택하세요.");
  const rows = (
    await db.query(
      "SELECT id,relative_path,bytes::text,mtime_ns FROM library_documents WHERE owner_id=$1 ORDER BY id",
      [owner],
    )
  ).rows;
  if (!rows.length) throw new LibraryError(404, "연결할 PDF가 없습니다.");
  const hashes = withPdfIndex((index) => {
    const s = index.prepare(
      "SELECT sha256,signature FROM documents WHERE id=?",
    );
    return new Map(rows.map((d) => [d.id, s.get(d.id)]));
  });
  let found = 0,
    missing = 0;
  const samples: any[] = [];
  for (const d of rows) {
    try {
      const file = await resolvePdfPath(join(root, d.relative_path), root),
        info = await stat(file);
      if (info.size !== Number(d.bytes)) throw Error();
      found++;
      if (
        samples.length < 3 &&
        hashes.get(d.id)?.signature === `${d.bytes}:${d.mtime_ns}` &&
        hashes.get(d.id)?.sha256
      )
        samples.push(d);
    } catch {
      missing++;
    }
  }
  if (!samples.length)
    throw new LibraryError(
      409,
      "기존 원본과 연결할 수 없습니다. 폴더 위치를 확인하세요.",
    );
  for (const d of samples)
    await verifyRelocatedPdf(
      root,
      d.relative_path,
      Number(d.bytes),
      String(hashes.get(d.id)!.sha256),
    );
  const digest = createHash("sha256")
    .update(JSON.stringify([owner, root, rows, found, missing]))
    .digest("hex");
  return {
    root,
    found,
    missing,
    checked: samples.length,
    digest,
    version: (await config()).version,
  };
}
let saving = false;
export async function applyPdfConnection(
  db: Executor,
  owner: string,
  raw: unknown,
) {
  const p = z
    .object({
      root: z.string(),
      digest: z.string(),
      expectedVersion: z.number().int().min(0),
    })
    .parse(raw);
  if (saving) throw new LibraryError(409, "다른 연결을 저장하는 중입니다.");
  saving = true;
  try {
    const checked = await previewPdfConnection(db, owner, p);
    if (checked.digest !== p.digest || checked.version !== p.expectedVersion)
      throw new LibraryError(409, "폴더 상태가 바뀌었습니다. 다시 검사하세요.");
    await atomicWriteJson(configPath(), {
      version: p.expectedVersion + 1,
      owner,
      root: checked.root,
      checkedAt: new Date().toISOString(),
      digest: p.digest,
    });
    return { connected: true, version: p.expectedVersion + 1 };
  } finally {
    saving = false;
  }
}
