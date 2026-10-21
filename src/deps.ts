import type { Database } from "bun:sqlite";
import type { FogRegistry } from "./fog/session";
import type { ChallengeStore } from "./auth/challenges";

/**
 * Everything the HTTP and WebSocket layers need, built once in `index.ts`.
 *
 * Passed rather than reached for, so fog state has exactly one owner per process
 * and the test servers can build their own. `db` is not optional: a missing
 * database used to degrade a startup failure into a 404 (#16).
 */
export interface ServerDeps {
  db: Database;
  uploadsDir: string;
  fog: FogRegistry;
  /** Passkey ceremonies between their two steps. */
  challenges: ChallengeStore;
  /** `PUBLIC_ORIGIN`, e.g. `https://adventure.ctl.wtf`. Unset means the request's own host. */
  publicOrigin?: string;
}
