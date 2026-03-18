import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { initDatabase } from "../src/db/database";
import { handleRequest } from "../src/routes";

export interface TestServer {
  url: string;
  server: Server;
  db: Database;
  uploadsDir: string;
  stop(): void;
}

export function startTestServer(): TestServer {
  const db = initDatabase(":memory:");
  const uploadsDir = join(
    process.cwd(),
    "data",
    `test-uploads-${crypto.randomUUID().replace(/-/g, "").substring(0, 8)}`
  );
  mkdirSync(uploadsDir, { recursive: true });

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      return handleRequest(req, db, uploadsDir);
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    server,
    db,
    uploadsDir,
    stop() {
      server.stop(true);
      rmSync(uploadsDir, { recursive: true, force: true });
    },
  };
}
