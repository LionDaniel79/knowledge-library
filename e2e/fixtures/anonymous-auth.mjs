import { createServer } from "node:http";

// CI-only provider fixture: it never authenticates anybody, accepts no writes,
// and makes no network calls. Production code has no fixture/bypass branch.
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://127.0.0.1:3001").pathname;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "GET" && path === "/get-session") {
    response.end("null");
  } else if (request.method === "GET" && path === "/health") {
    response.end('{"ok":true}');
  } else {
    response.writeHead(404);
    response.end('{"error":"Unavailable in anonymous test provider"}');
  }
});
server.listen(Number(process.env.PLAYWRIGHT_AUTH_PORT ?? 3001), "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close(() => process.exit(0)));
