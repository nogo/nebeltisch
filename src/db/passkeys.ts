import type { Database } from "bun:sqlite";
import type { Passkey } from "../types";

export function addPasskey(
  db: Database,
  { id, userId, publicKey, algorithm, signCount }:
    { id: string; userId: string; publicKey: Uint8Array; algorithm: number; signCount: number }
): void {
  db.run(
    `INSERT INTO passkeys (id, user_id, public_key, algorithm, sign_count) VALUES (?, ?, ?, ?, ?)`,
    [id, userId, publicKey, algorithm, signCount]
  );
}

export function getPasskey(db: Database, id: string): Passkey | null {
  return db.query<Passkey, string>(`SELECT * FROM passkeys WHERE id = ?`).get(id) ?? null;
}

export function getPasskeysByUser(db: Database, userId: string): Passkey[] {
  return db.query<Passkey, string>(
    `SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at`
  ).all(userId);
}

export function setSignCount(db: Database, id: string, signCount: number): void {
  db.run(`UPDATE passkeys SET sign_count = ? WHERE id = ?`, [signCount, id]);
}
