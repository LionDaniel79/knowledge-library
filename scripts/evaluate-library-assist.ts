import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { evaluateLibraryAcceptance } from "../src/local/curation/acceptance";
const run = process.argv[2];
if (!run || !/^[a-zA-Z0-9_-]+$/.test(run))
  throw Error("private-data/curation 안의 실행 이름이 필요합니다.");
const file = resolve("private-data/curation", run, "acceptance-review.json");
const report = evaluateLibraryAcceptance(
  JSON.parse(await readFile(file, "utf8")),
);
await writeFile(
  resolve(dirname(file), "acceptance-report.json"),
  JSON.stringify({ evaluatedAt: new Date().toISOString(), ...report }, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify(report));
