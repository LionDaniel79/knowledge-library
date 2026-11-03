import { randomUUID } from "node:crypto";
import { it,expect } from "vitest";
import { testDatabase } from "./helpers/database";
import { startDesktopManifest,putDesktopItems,sealDesktopManifest,previewDesktopManifest,previewDesktopCleanup } from "../src/server/desktop-catalog";
import { desktopItemsDigest } from "../src/lib/desktop-catalog-contract";

it("stages existing PDF IDs idempotently without deleting or modifying a book",async()=>{
  const f=await testDatabase();
  try{
    const owner="desktop-integration-owner";
    const deviceId=randomUUID(),documentId=randomUUID(),bookId=randomUUID();
    await f.db.query("INSERT INTO library_books(id,owner_id,title,author,formats,source_key,source_data) VALUES($1,$2,'Existing book','Author',ARRAY['pdf'],$3,$4::jsonb)",
      [bookId,owner,"test-pdf-document",JSON.stringify({app:"Local PDF",libraryId:"test",recordId:documentId,raw:{}})]);
    await f.db.query("INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns,processing_scope,material_kind,scope_reason,scope_version) VALUES($1,$2,$3,'test','test.pdf','기독도서/test.pdf',1,'1','full','book','','v1')",
      [documentId,owner,bookId]);
    await f.db.query("INSERT INTO library_desktop_tokens(owner_id,id,name,token_hash,expires_at) VALUES($1,$2,'test device',$3,now()+interval '1 day')",
      [owner,deviceId,"a".repeat(64)]);
    const who={owner,deviceId};
    const op=randomUUID();
    const head={operationId:op,scanComplete:true as const,rootsAvailable:true as const,
      physicalByRoot:{christian:1,general:0},expectedDocuments:1};
    const first=await startDesktopManifest(f.db,who,head);
    expect((await startDesktopManifest(f.db,who,head)).manifestId).toBe(first.manifestId);
    const item={legacyDocumentId:documentId,bookId,expectedBookVersion:1,
      copiesByRoot:{christian:1,general:0}};
    const input={items:[item]};
    expect((await putDesktopItems(f.db,who,first.manifestId,input)).created).toBe(1);
    expect((await putDesktopItems(f.db,who,first.manifestId,input)).created).toBe(0);
    await expect(putDesktopItems(f.db,who,first.manifestId,{items:[{...item,expectedBookVersion:2}]}))
      .rejects.toMatchObject({status:409});
    const seal={itemsDigest:desktopItemsDigest([item])};
    expect((await sealDesktopManifest(f.db,who,first.manifestId,seal)).status).toBe("sealed");
    expect((await sealDesktopManifest(f.db,who,first.manifestId,seal)).status).toBe("sealed");
    const preview=await previewDesktopManifest(f.db,who,first.manifestId);
    expect(preview).toMatchObject({selectedDocuments:1,missing:0,versionConflicts:0,deleteCandidates:0,canDelete:false});
    const cleanup=await previewDesktopCleanup(f.db,who,first.manifestId);
    expect(cleanup).toMatchObject({deleteAuthorized:false,backupVerified:false,syncVerified:false});
    expect((await f.db.query("SELECT count(*)::int AS n FROM library_books WHERE owner_id=$1",[owner])).rows[0].n).toBe(1);
  }finally{await f.pg.close();}
});
