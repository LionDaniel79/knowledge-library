import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { LibraryError } from "./library-store";
import { ZoteroClient } from "./zotero-client";
let cached: { path: string; client: ZoteroClient } | undefined;
export async function zoteroConnection() {
  const path = process.env.LIBRARY_ZOTERO_CONFIG;
  if (process.platform !== "win32" || !path || process.env.VERCEL)
    throw new LibraryError(
      503,
      "Zotero 전송은 연결된 PC의 지식서재에서 이용하세요.",
    );
  if (cached?.path === path) return cached.client;
  let credential: { userId: string; apiKey: string };
  try {
    const { stdout } = await promisify(execFile)(
      process.env.LIBRARY_POWERSHELL || "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        resolve("scripts/read-zotero-credential.ps1"),
        "-ConfigPath",
        path,
      ],
      { windowsHide: true, timeout: 15000, maxBuffer: 8192, encoding: "utf8" },
    );
    credential = JSON.parse(stdout);
  } catch {
    throw new LibraryError(
      503,
      "이 Windows 계정의 Zotero 연결 파일을 읽지 못했습니다.",
    );
  }
  const client = new ZoteroClient(credential.userId, credential.apiKey);
  await client.verifyAccess();
  cached = { path, client };
  return client;
}
