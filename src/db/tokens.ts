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

export function findOrCreateToken(
  db: Database,
  { adventureId, playerLink, name, color }: {
    adventureId: string;
    playerLink: string;
    name: string;
    color: string;
  }
): { token: Token; isNew: boolean } {
  const existing = db.query<Token, [string, string]>(
    `SELECT * FROM tokens WHERE adventure_id = ? AND player_link = ?`
  ).get(adventureId, playerLink);

  if (existing) {
    // Update name/color in case they changed between sessions
    db.run(`UPDATE tokens SET name = ?, color = ? WHERE id = ?`, [name, color, existing.id]);
    return { token: getToken(db, existing.id)!, isNew: false };
  }

  const id = crypto.randomUUID();
  try {
    db.run(
      `INSERT INTO tokens (id, adventure_id, name, color, player_link) VALUES (?, ?, ?, ?, ?)`,
      [id, adventureId, name, color, playerLink]
    );
    return { token: getToken(db, id)!, isNew: true };
  } catch {
    // Race condition: another concurrent insert won — retry the SELECT
    const raceToken = db.query<Token, [string, string]>(
      `SELECT * FROM tokens WHERE adventure_id = ? AND player_link = ?`
    ).get(adventureId, playerLink);
    if (raceToken) {
      db.run(`UPDATE tokens SET name = ?, color = ? WHERE id = ?`, [name, color, raceToken.id]);
      return { token: getToken(db, raceToken.id)!, isNew: false };
    }
    throw new Error("Failed to find or create token");
  }
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
