import type { Database } from "bun:sqlite";
import type { Token } from "../types";

export function createToken(
  db: Database,
  { adventureId, name, color }: { adventureId: string; name: string; color: string }
): Token {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO tokens (id, adventure_id, name, color) VALUES (?, ?, ?, ?)`,
    [id, adventureId, name, color]
  );
  return getToken(db, id)!;
}

function getToken(db: Database, id: string): Token | null {
  return db.query<Token, string>(
    `SELECT * FROM tokens WHERE id = ?`
  ).get(id) ?? null;
}

export function getTokensByAdventure(db: Database, adventureId: string): Token[] {
  return db.query<Token, string>(
    `SELECT * FROM tokens WHERE adventure_id = ?`
  ).all(adventureId);
}

export function updateTokenPosition(db: Database, tokenId: string, x: number, y: number): void {
  db.run(`UPDATE tokens SET x = ?, y = ? WHERE id = ?`, [x, y, tokenId]);
}

export function deleteToken(db: Database, id: string): void {
  db.run(`DELETE FROM tokens WHERE id = ?`, [id]);
}
