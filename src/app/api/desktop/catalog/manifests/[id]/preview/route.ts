import { database } from "@/server/db";
import { authorizeDesktop } from "@/server/desktop-auth";
import { previewDesktopManifest } from "@/server/desktop-catalog";
import { failure } from "@/server/http";
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const who=await authorizeDesktop(database,request,"catalog:read");
    return Response.json(await previewDesktopManifest(database,who,(await params).id),{headers:{"Cache-Control":"private, no-store"}});
  }catch(e){return failure(e);}
}