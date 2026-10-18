import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export async function writeReplicaShellManifest(root) {
  const staticRoot = join(root, ".next/static"),
    assets = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (/\.(ts|tsx)$/.test(entry.name))
        throw Error(
          `Uncompiled TypeScript asset ${entry.name}: workers must be built as JavaScript`,
        );
      else if (/\.(js|css|woff2?|ttf)$/.test(entry.name))
        assets.push(
          "/_next/static/" + relative(staticRoot, full).replaceAll("\\", "/"),
        );
    }
  }
  await visit(staticRoot);
  const version = (await readFile(join(root, ".next/BUILD_ID"), "utf8")).trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(version))
    throw Error("Invalid public build id");
  await writeFile(
    join(root, "public/replica-shell.json"),
    JSON.stringify({ version, assets: assets.sort() }),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
)
  await writeReplicaShellManifest(process.cwd());
