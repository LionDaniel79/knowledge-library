import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logosLookup } from "../src/local/curation/logos-providers";
import { applyLogosCompletion } from "../src/server/logos-completion";
import {runLogosCompletion} from '../src/local/curation/logos-runner';
it('defers one invalid search while processing later books',async()=>{const dir=await mkdtemp(join(tmpdir(),'logos-resource-'));try{const s=await runLogosCompletion({owner:'test',dir,books:[{id:'a',version:1},{id:'b',version:1}] as any,online:true,apply:true,limit:2,lookup:async b=>{if(b.id==='a')throw Object.assign(new Error('Invalid search'),{status:404});return [];},applyDecision:async()=> 'complete'});expect(s).toMatchObject({stopped:'complete',failed:1,applied:1,deferred:0,pending:1});expect(s.retryAt).not.toBe('');}finally{await rm(dir,{recursive:true,force:true});}});
it("stops immediately on provider authentication and quota failures", async () => {
  for (const status of [401, 403, 429]) {
    const dir = await mkdtemp(join(tmpdir(), "logos-guard-"));
    let calls = 0;
    try {
      const lookup = logosLookup({
        dir,
        libraryKey: "test",
        yes24Key: "test",
        reserve: () => {},
        fetcher: async () => {
          calls++;
          return new Response("{}", { status });
        },
      });
      await expect(
        lookup({
          id: "test",
          version: 1,
          resourceId: "r",
          title: "Book",
          author: "Author",
          publisher: "Press",
          isbn: "",
          publicationDate: "",
          edition: "",
          resourceType: "",
        }),
      ).rejects.toMatchObject({ status });
      expect(calls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
it("propagates database failures instead of treating them as image retries", async () => {
  const previous = process.env.LIBRARY_STAGE5_WRITE_ENABLED;
  process.env.LIBRARY_STAGE5_WRITE_ENABLED = "true";
  try {
    await expect(
      applyLogosCompletion(
        {
          query: async () => {
            throw Object.assign(new Error("DB unavailable"), { code: "08006" });
          },
        } as any,
        "owner",
        { id: "x", version: 1 } as any,
        {
          state: "certain",
          reason: "same work",
          record: {},
          candidates: [],
        } as any,
      ),
    ).rejects.toMatchObject({ code: "08006" });
  } finally {
    if (previous === undefined) delete process.env.LIBRARY_STAGE5_WRITE_ENABLED;
    else process.env.LIBRARY_STAGE5_WRITE_ENABLED = previous;
  }
});
