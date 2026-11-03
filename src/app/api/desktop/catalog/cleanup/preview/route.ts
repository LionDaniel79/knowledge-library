import { z } from "zod";
import { database } from "@/server/db";
import { authorizeDesktop } from "@/server/desktop-auth";
import { previewDesktopCleanup } from "@/server/desktop-catalog";
import { failure } from "@/server/http";
export const dynamic="force-dynamic";
export async function POST(request:Request){
  try{
    const who=await authorizeDesktop(database,request,"catalog:read");
    const p=z.object({manifestId:z.string().uuid()}).strict().parse(await request.json());
    return Response.json(await previewDesktopCleanup(database,who,p.manifestId),{headers:{"Cache-Control":"private, no-store"}});
  }catch(e){return failure(e);}
}