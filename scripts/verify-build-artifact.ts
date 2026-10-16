import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
async function traces(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await traces(p)));
    else if (e.name.endsWith(".nft.json")) out.push(p);
  }
  return out;
}
let unsafe = 0,
  count = 0;
for (const path of await traces(".next/server")) {
  const files = JSON.parse(await readFile(path, "utf8")).files as string[];
  for (const file of files) {
    count++;
    const normalized = file.replaceAll("\\", "/");
    if (
      /(^|\/)(private-data|\.git|\.superpowers|test-results|playwright-report)(\/|$)/.test(
        normalized,
      ) ||
      /^\.env(\.|$)/.test(basename(normalized)) ||
      /\.(?:sqlite(?:-[\w-]+)?|private\.json|pdf)$/i.test(normalized)
    )
      unsafe++;
  }
}
console.log(JSON.stringify({ tracedEntries: count, privateEntries: unsafe }));
if (!count)
  throw Error("검사할 배포 산출물이 없습니다. 먼저 build를 실행하세요.");
if (unsafe) throw Error("배포 산출물에 개인 자료 경로가 포함되어 있습니다.");
