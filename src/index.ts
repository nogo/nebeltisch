import { mkdirSync } from "fs";
import { initDatabase } from "./db/database";
import { handleRequest } from "./routes";
import { createWsHandlers, handleWsUpgrade } from "./ws/handler";

const uploadsDir = `${process.env.DATA_DIR || "./data"}/uploads/`;
mkdirSync(uploadsDir, { recursive: true });

const db = initDatabase();
const wsHandlers = createWsHandlers(db);

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
