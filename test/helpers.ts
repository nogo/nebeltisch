import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import type { WsData } from "../src/types";
import type { ServerDeps } from "../src/deps";
import type { FogRegistry } from "../src/fog/session";
import { initDatabase } from "../src/db/database";
import { handleRequest, staticRoutes } from "../src/routes";
import { createFogRegistry } from "../src/fog/session";
import { createWsHandlers, handleWsUpgrade } from "../src/ws/handler";

/**
 * `Server` is generic over its WebSocket data. The HTTP-only server has no `websocket`
 * handler and so is `Server<undefined>`; only the WS server carries `WsData`.
 */
export interface TestServer<T = undefined> {
  url: string;
  server: Server<T>;
  db: Database;
  uploadsDir: string;
  /** The server's own fog registry — tests reach state through it, not a global. */
  fog: FogRegistry;
  stop(): void;
}

export interface WsTestServer extends TestServer<WsData> {
  wsUrl: string;
}

export function startTestServer(): TestServer {
  const db = initDatabase(":memory:");
  const uploadsDir = join(
    process.cwd(),
    "data",
    `test-uploads-${crypto.randomUUID().replace(/-/g, "").substring(0, 8)}`
  );
  mkdirSync(uploadsDir, { recursive: true });

  const deps: ServerDeps = { db, uploadsDir, fog: createFogRegistry(db, uploadsDir) };

  const server = Bun.serve({
    port: 0,
    routes: staticRoutes(uploadsDir),
    fetch(req) {
      return handleRequest(req, deps);
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    server,
    db,
    uploadsDir,
    fog: deps.fog,
    stop() {
      server.stop(true);
      rmSync(uploadsDir, { recursive: true, force: true });
    },
  };
}

export function startWsTestServer(): WsTestServer {
  const db = initDatabase(":memory:");
  const uploadsDir = join(
    process.cwd(),
    "data",
    `test-uploads-${crypto.randomUUID().replace(/-/g, "").substring(0, 8)}`
  );
  mkdirSync(uploadsDir, { recursive: true });

  const deps: ServerDeps = { db, uploadsDir, fog: createFogRegistry(db, uploadsDir) };
  const wsHandlers = createWsHandlers(deps);

  const server = Bun.serve({
    port: 0,
    routes: staticRoutes(uploadsDir),
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") return handleWsUpgrade(req, deps, server);
      return handleRequest(req, deps);
    },
    websocket: wsHandlers,
  });

  return {
    url: `http://localhost:${server.port}`,
    wsUrl: `ws://localhost:${server.port}`,
    server,
    db,
    uploadsDir,
    fog: deps.fog,
    stop() {
      server.stop(true);
      rmSync(uploadsDir, { recursive: true, force: true });
    },
  };
}
