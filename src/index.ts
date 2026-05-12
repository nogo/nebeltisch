import { mkdirSync } from "fs";
import { initDatabase } from "./db/database";
import { handleRequest } from "./routes";
import { createWsHandlers, handleWsUpgrade, flushAllFogCaches } from "./ws/handler";

const uploadsDir = `${process.env.DATA_DIR || "./data"}/uploads/`;
mkdirSync(uploadsDir, { recursive: true });

const db = initDatabase();
const wsHandlers = createWsHandlers(db, uploadsDir);

const server = Bun.serve({
  port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      return handleWsUpgrade(req, db, server);
    }
    return handleRequest(req, db, uploadsDir);
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
    await flushAllFogCaches(db);
  } catch (err) {
    console.error("shutdown: flush failed", err);
    process.exit(1);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
