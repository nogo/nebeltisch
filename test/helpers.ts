import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import type { WsData } from "../src/types";
import type { ServerDeps } from "../src/deps";
import type { FogRegistry } from "../src/fog/session";
import { initDatabase } from "../src/db/database";
import { handleRequest } from "../src/routes";
import { createFogRegistry } from "../src/fog/session";
import { createChallengeStore } from "../src/auth/challenges";
import { createUser } from "../src/db/users";
import { createSession } from "../src/db/sessions";
import type { User } from "../src/types";
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

  const deps: ServerDeps = { db, uploadsDir, fog: createFogRegistry(db, uploadsDir), challenges: createChallengeStore() };

  const server = Bun.serve({
    port: 0,
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

  const deps: ServerDeps = { db, uploadsDir, fog: createFogRegistry(db, uploadsDir), challenges: createChallengeStore() };
  const wsHandlers = createWsHandlers(deps);

  const server = Bun.serve({
    port: 0,
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

/**
 * A signed-in account, straight in the database: what a GM's browser holds after logging in.
 *
 * `cookie` is the `Cookie` header that browser would send. The hashes are placeholders — nothing
 * here verifies them; the login routes have their own tests.
 */
export function signIn(db: Database, name = `GM ${crypto.randomUUID().slice(0, 8)}`): { user: User; cookie: string } {
  const user = createUser(db, { name, passwordHash: null, recoveryHash: "unused" });
  return { user, cookie: `nebeltisch_session=${createSession(db, user.id)}` };
}
