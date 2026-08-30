import { mkdirSync } from "fs";
import { initDatabase } from "./db/database";
import { handleRequest, staticRoutes } from "./routes";
import { createFogRegistry } from "./fog/session";
import { createWsHandlers, handleWsUpgrade } from "./ws/handler";
import type { ServerDeps } from "./deps";

const uploadsDir = `${process.env.DATA_DIR || "./data"}/uploads/`;
mkdirSync(uploadsDir, { recursive: true });

const db = initDatabase();
// The composition root: one database, one fog registry, for the whole process.
const deps: ServerDeps = { db, uploadsDir, fog: createFogRegistry(db, uploadsDir) };
const wsHandlers = createWsHandlers(deps);

const server = Bun.serve({
  port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
  routes: staticRoutes(uploadsDir),
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      return handleWsUpgrade(req, deps, server);
    }
    return handleRequest(req, deps);
  },
  websocket: wsHandlers,
});

console.log(`Server running on http://localhost:${server.port}`);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.stop();
  try {
    await deps.fog.flushAll();
  } catch (err) {
    console.error("shutdown: flush failed", err);
    process.exit(1);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
