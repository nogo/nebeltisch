import { readFileSync } from "fs";
import { join } from "path";

const publicDir = join(import.meta.dir, "..", "public");

export function handleRequest(req: Request): Response {
  const url = new URL(req.url);
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/") {
    try {
      const html = readFileSync(join(publicDir, "index.html"), "utf-8");
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }

  if (req.method === "GET" && pathname === "/api/health") {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (pathname.startsWith("/public/")) {
    const filePath = join(publicDir, pathname.replace("/public/", ""));
    try {
      const file = Bun.file(filePath);
      return new Response(file);
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }

  return new Response("Not Found", { status: 404 });
}
