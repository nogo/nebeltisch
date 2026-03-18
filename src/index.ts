import { mkdirSync } from "fs";
import { initDatabase } from "./db/database";
import { handleRequest } from "./routes";

const uploadsDir = "./data/uploads/";
mkdirSync(uploadsDir, { recursive: true });

const db = initDatabase();

const server = Bun.serve({
  port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return handleRequest(req, db, uploadsDir);
  },
  websocket: {
    open(ws) {
      console.log("WebSocket opened");
    },
    message(ws, message) {
      console.log("WebSocket message:", message);
    },
    close(ws) {
      console.log("WebSocket closed");
    },
  },
});

console.log(`Server running on http://localhost:${server.port}`);
