import { getAuth } from "@/server/auth";
import { failure } from "@/server/http";
import { type NextRequest } from "next/server";
type AuthMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
const forward =
  (method: AuthMethod) =>
  async (
    request: NextRequest,
    context: { params: Promise<{ path: string[] }> },
  ) => {
    try {
      return await getAuth().handler()[method](request, context);
    } catch (e) {
      return failure(e);
    }
  };
export const GET = forward("GET"),
  POST = forward("POST"),
  PUT = forward("PUT"),
  DELETE = forward("DELETE"),
  PATCH = forward("PATCH");
