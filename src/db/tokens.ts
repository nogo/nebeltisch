import type { Database } from "bun:sqlite";
import type { Token } from "../types";

export function createToken(
  db: Database,
  { adventureId, name, color, tokenType = 'player', x = 0, y = 0, imageId = null }: {
    adventureId: string;
    name: string;
    color: string;
    tokenType?: 'player' | 'monster' | 'npc';
    x?: number;
    y?: number;
    imageId?: string | null;
  }
): Token {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO tokens (id, adventure_id, name, color, token_type, x, y, image_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, adventureId, name, color, tokenType, x, y, imageId]
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

/** All player tokens for an adventure (no image association). */
export function getPlayerTokensByAdventure(db: Database, adventureId: string): Token[] {
  return db.query<Token, string>(
    `SELECT * FROM tokens WHERE adventure_id = ? AND token_type = 'player'`
  ).all(adventureId);
}

/** GM tokens (monster/npc) for a specific map image. */
export function getGmTokensByImage(db: Database, adventureId: string, imageId: string): Token[] {
  return db.query<Token, [string, string]>(
    `SELECT * FROM tokens WHERE adventure_id = ? AND image_id = ? AND token_type != 'player'`
  ).all(adventureId, imageId);
}

/** All tokens for an adventure (used for roster building etc.). */
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
