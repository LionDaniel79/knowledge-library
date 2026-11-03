import { database } from "@/server/db";
import { authorizeDesktop } from "@/server/desktop-auth";
import { sealDesktopManifest } from "@/server/desktop-catalog";
import { failure } from "@/server/http";
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const who=await authorizeDesktop(database,request,"catalog:write");
    return Response.json(await sealDesktopManifest(database,who,(await params).id,await request.json()),{headers:{"Cache-Control":"private, no-store"}});
  }catch(e){return failure(e);}
}