import { createServer } from "node:http";
import { build } from "esbuild";
import { testDatabase } from "../../tests/helpers/database";
import {
  readSyncMeta,
  scanSyncRows,
  readSyncChanges,
} from "../../src/server/sync/read";
import { readSyncValuePart } from "../../src/server/sync/values";
import { readSyncCoverage } from "../../src/server/sync/coverage";
import { executeSyncCommand } from "../../src/server/sync/commands";
export async function replicaServer() {
  const fixture = await testDatabase(),
    owner = "browser-fixture",
    traffic: { path: string; bytes: number; rows?: string[] }[] = [];
  const js = (
    await build({
      stdin: {
        contents: `import{openReplica}from'./src/client/replica/indexed-db';import{createReplicaRepository}from'./src/client/replica/repository';import{createReplicaCoordinator}from'./src/client/replica/coordinator';import{createSyncTransport}from'./src/client/replica/transport';import{queueReplicaCommand}from'./src/client/replica/outbox';window.ready=(async()=>{const storage=await openReplica('browser-fixture'),repo=createReplicaRepository(storage),coordinator=createReplicaCoordinator({owner:storage.owner,storage,transport:createSyncTransport()});window.device={storage,repo,sync:()=>coordinator.syncReplica({reason:'manual'}),queue:(body,path='/api/library')=>queueReplicaCommand({storage,repository:repo,path,body:{...body,requestId:crypto.randomUUID()}})};await coordinator.syncReplica({reason:'initial'});})();`,
        resolveDir: process.cwd(),
        loader: "ts",
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      define: { "import.meta.url": "location.href" },
    })
  ).outputFiles[0].text;
  const worker = (
    await build({
      entryPoints: ["src/client/replica/search-worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
    })
  ).outputFiles[0].text;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://localhost"),
        q = Object.fromEntries(url.searchParams);
      let body: any;
      if (url.pathname === "/") {
        res.setHeader("Content-Type", "text/html");
        return res.end('<div></div><script src="/main.js"></script>');
      }
      if (url.pathname === "/main.js" || url.pathname === "/search-worker.ts") {
        res.setHeader("Content-Type", "application/javascript");
        return res.end(url.pathname === "/main.js" ? js : worker);
      }
      if (url.pathname === "/api/sync/meta")
        body = await readSyncMeta(fixture.db, owner, q.inventory === "1");
      else if (url.pathname === "/api/sync/scan")
        body = await scanSyncRows(fixture.db, owner, {
          ...q,
          ...(q.limit ? { limit: Number(q.limit) } : {}),
        } as any);
      else if (url.pathname === "/api/sync/changes")
        body = await readSyncChanges(fixture.db, owner, {
          ...q,
          ...(q.limit ? { limit: Number(q.limit) } : {}),
        } as any);
      else if (url.pathname === "/api/sync/coverage")
        body = await readSyncCoverage(fixture.db, owner);
      else if (url.pathname === "/api/sync/value") {
        const bytes = await readSyncValuePart(fixture.db, owner, {
          ...q,
          index: Number(q.index),
        } as any);
        traffic.push({ path: url.pathname, bytes: bytes.byteLength });
        return res.end(bytes);
      } else if (url.pathname === "/api/sync/push") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        body = await executeSyncCommand(fixture.db, owner, JSON.parse(raw));
      } else {
        res.statusCode = 404;
        body = { error: "unknown fixture route" };
      }
      const raw = JSON.stringify(body);
      traffic.push({
        path: url.pathname,
        bytes: Buffer.byteLength(raw),
        rows: body.rows?.map((r: any) => r.entity),
      });
      res.setHeader("Content-Type", "application/json");
      res.end(raw);
    } catch (e) {
      res.statusCode = (e as any).status ?? 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    ...fixture,
    owner,
    traffic,
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await fixture.pg.close();
    },
  };
}
