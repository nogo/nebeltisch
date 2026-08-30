import type { Database } from "bun:sqlite";
import type { Token, TokenState } from "../types";

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

export function getToken(db: Database, id: string): Token | null {
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

/** Remembers where a token stood on a specific map. */
export function rememberTokenPosition(
  db: Database,
  tokenId: string,
  imageId: string,
  x: number,
  y: number
): void {
  db.run(
    `INSERT INTO token_positions (token_id, image_id, x, y) VALUES (?, ?, ?, ?)
     ON CONFLICT(token_id, image_id) DO UPDATE SET x = excluded.x, y = excluded.y`,
    [tokenId, imageId, x, y]
  );
}

/**
 * Positions remembered for a map, keyed by token id.
 *
 * A remembered position means a token *walked* there. Nothing else writes one — arrival does not,
 * which is what #46 was, and moving the start point does not clear them, because the flag governs
 * first entry while walking governs return (#57).
 */
export function getRememberedPositions(
  db: Database,
  imageId: string
): Map<string, { x: number; y: number }> {
  const rows = db
    .query<{ token_id: string; x: number; y: number }, string>(
      `SELECT token_id, x, y FROM token_positions WHERE image_id = ?`
    )
    .all(imageId);
  return new Map(rows.map((r) => [r.token_id, { x: r.x, y: r.y }]));
}

/**
 * Marks a token alive, unconscious or dead. The GM is the only caller, for every kind of token —
 * a player does not adjudicate their own unconsciousness, so there is one writer per object.
 */
export function setTokenState(db: Database, id: string, state: TokenState): void {
  db.run(`UPDATE tokens SET state = ? WHERE id = ?`, [state, id]);
}

export function renameToken(db: Database, id: string, name: string): void {
  db.run(`UPDATE tokens SET name = ? WHERE id = ?`, [name, id]);
}

export function deleteToken(db: Database, id: string): void {
  db.run(`DELETE FROM tokens WHERE id = ?`, [id]);
}

/**
 * The monsters and NPCs that belong to one page. They die with it — `tokens.image_id` references
 * `images(id)` with no `ON DELETE` clause, so without this the page cannot be deleted at all once
 * anything has been placed on it. Player tokens are adventure-scoped and are never touched here.
 */
export function deleteTokensByImage(db: Database, imageId: string): void {
  db.run(`DELETE FROM tokens WHERE image_id = ?`, [imageId]);
}
