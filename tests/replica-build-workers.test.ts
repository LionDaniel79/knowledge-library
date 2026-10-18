import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { writeReplicaShellManifest } from "../scripts/replica-shell-manifest.mjs";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (
      !resolve(root).startsWith(resolve(tmpdir()) + "/") &&
      !resolve(root).startsWith(resolve(tmpdir()) + "\\")
    )
      throw Error("Unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "library-worker-build-"));
  roots.push(root);
  await mkdir(join(root, ".next/static/media"), { recursive: true });
  await mkdir(join(root, "public"));
  await writeFile(join(root, ".next/BUILD_ID"), "worker-test");
  return root;
}
it("rejects a production build that emits a TypeScript worker as a media asset", async () => {
  const root = await fixture();
  await writeFile(
    join(root, ".next/static/media/reader-worker.hash.ts"),
    "self.onmessage=(event:MessageEvent)=>{};",
  );
  await expect(writeReplicaShellManifest(root)).rejects.toThrow(
    /worker|JavaScript|작업자/,
  );
});
it("includes compiled worker JavaScript in the offline manifest", async () => {
  const root = await fixture();
  await writeFile(
    join(root, ".next/static/media/reader-worker.hash.js"),
    "self.onmessage=()=>{};",
  );
  await writeReplicaShellManifest(root);
  const manifest = JSON.parse(
    await readFile(join(root, "public/replica-shell.json"), "utf8"),
  );
  expect(manifest.assets).toContain(
    "/_next/static/media/reader-worker.hash.js",
  );
});
