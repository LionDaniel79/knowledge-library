import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { testDatabase } from "./helpers/database";
import { previewLogos, applyLogos } from "../src/server/logos-import";

it("previews Logos resources by stable ID, flags edition matches and forbids Stage 4 writes", async () => {
  const f=await testDatabase();
  try{
    const owner="logos-stage4-owner";
    const id=randomUUID();
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,author,formats,source_key) VALUES($1,$2,'Existing Theology','Test Author',ARRAY['paper'],'old-paper')",
      [id,owner],
    );
    const item=(resourceId:string,title:string)=>({
      resourceId,title,author:"Test Author",publisher:"Publisher",license:"permanent" as const,
      series:"",resourceType:"book",language:"English",publicationDate:"2000",edition:""
    });
    const input={items:[item("LLS:EXISTING","Existing Theology"),item("LLS:NEW","New Theology")]};
    const preview=await previewLogos(f.db,owner,input);
    expect(preview).toMatchObject({received:2,alreadyImported:0,possibleExistingEdition:1,toCreate:1,applied:false});
    await expect(applyLogos(f.db,owner,input)).rejects.toMatchObject({status:403});
    const before=(await f.db.query("SELECT count(*)::int AS n FROM library_books WHERE owner_id=$1",[owner])).rows[0].n;
    expect(before).toBe(1);
  }finally{await f.pg.close();}
});
