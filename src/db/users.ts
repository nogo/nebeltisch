import type { Database } from "bun:sqlite";
import type { User } from "../types";

export function createUser(
  db: Database,
  { id = crypto.randomUUID(), name, passwordHash, recoveryHash }:
    { id?: string; name: string; passwordHash: string | null; recoveryHash: string }
): User {
  db.run(
    `INSERT INTO users (id, name, password_hash, recovery_hash) VALUES (?, ?, ?, ?)`,
    [id, name, passwordHash, recoveryHash]
  );
  return getUser(db, id)!;
}

export function getUser(db: Database, id: string): User | null {
  return db.query<User, string>(`SELECT * FROM users WHERE id = ?`).get(id) ?? null;
}

/** Case-insensitive: "Danilo" and "danilo" are one account. */
export function getUserByName(db: Database, name: string): User | null {
  return db.query<User, string>(`SELECT * FROM users WHERE name = ?`).get(name) ?? null;
}

export function listUsers(db: Database): User[] {
  return db.query<User, []>(`SELECT * FROM users ORDER BY name`).all();
}

export function setPasswordHash(db: Database, userId: string, passwordHash: string): void {
  db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [passwordHash, userId]);
}

export function setRecoveryHash(db: Database, userId: string, recoveryHash: string): void {
  db.run(`UPDATE users SET recovery_hash = ? WHERE id = ?`, [recoveryHash, userId]);
}
