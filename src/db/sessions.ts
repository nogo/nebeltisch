import type { Database } from "bun:sqlite";
import type { User } from "../types";

/** How long a login lasts. Long, because a GM opens the board once a week and should not retype. */
export const SESSION_DAYS = 90;

/**
 * Starts a session and returns the id the cookie carries. Only its hash is stored, so the table
 * alone cannot be replayed as a login.
 */
export function createSession(db: Database, userId: string): string {
  // Expired rows are dead weight, never a risk — `getSessionUser` refuses them — so they are
  // swept here rather than on a timer.
  db.run(`DELETE FROM sessions WHERE expires_at <= datetime('now')`);
  const id = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  db.run(
    `INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`,
    [hashSessionId(id), userId, `+${SESSION_DAYS} days`]
  );
  return id;
}

/** The user a session id belongs to, or null when it is unknown or expired. */
export function getSessionUser(db: Database, id: string): User | null {
  return db.query<User, string>(
    `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.id_hash = ? AND sessions.expires_at > datetime('now')`
  ).get(hashSessionId(id)) ?? null;
}

export function deleteSession(db: Database, id: string): void {
  db.run(`DELETE FROM sessions WHERE id_hash = ?`, [hashSessionId(id)]);
}

/** Signs an account out everywhere. */
export function deleteSessionsOfUser(db: Database, userId: string): void {
  db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
}

function hashSessionId(id: string): string {
  return new Bun.CryptoHasher("sha256").update(id).digest("hex");
}
