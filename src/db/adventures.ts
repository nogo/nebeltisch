import type { Database } from "bun:sqlite";
import type { Adventure } from "../types";

/**
 * Every column but `gm_password`, which nothing may read since #56 — naming them keeps it out of
 * every row, and so out of every response built from one.
 */
const COLUMNS = `id, name, player_link, active_image_id, token_size, owner_id, created_at`;

/** `ownerId` null is only for tests and for adventures from before accounts. */
export function createAdventure(
  db: Database,
  { name, ownerId }: { name: string; ownerId: string | null }
): Adventure {
  const id = crypto.randomUUID();
  const playerLink = crypto.randomUUID().replace(/-/g, "").substring(0, 8);
  db.run(
    `INSERT INTO adventures (id, name, gm_password, player_link, owner_id) VALUES (?, ?, '', ?, ?)`,
    [id, name, playerLink, ownerId]
  );
  return getAdventure(db, id)!;
}

export function getAdventure(db: Database, id: string): Adventure | null {
  return db.query<Adventure, string>(
    `SELECT ${COLUMNS} FROM adventures WHERE id = ?`
  ).get(id) ?? null;
}

export function getAdventureByPlayerLink(db: Database, playerLink: string): Adventure | null {
  return db.query<Adventure, string>(
    `SELECT ${COLUMNS} FROM adventures WHERE player_link = ?`
  ).get(playerLink) ?? null;
}

/** What a dashboard entry shows: enough to tell two campaigns apart without opening either. */
export interface AdventureSummary {
  id: string;
  name: string;
  player_link: string;
  created_at: string;
  page_count: number;
}

/** Newest first: the campaign being prepared is usually the one just made. */
export function getAdventuresByOwner(db: Database, ownerId: string): AdventureSummary[] {
  return db.query<AdventureSummary, string>(
    `SELECT a.id, a.name, a.player_link, a.created_at,
            (SELECT COUNT(*) FROM images i WHERE i.adventure_id = a.id) AS page_count
     FROM adventures a WHERE a.owner_id = ? ORDER BY a.created_at DESC, a.rowid DESC`
  ).all(ownerId);
}

export function listAdventures(db: Database): Adventure[] {
  return db.query<Adventure, []>(`SELECT ${COLUMNS} FROM adventures ORDER BY created_at`).all();
}

export function setOwner(db: Database, adventureId: string, ownerId: string): void {
  db.run(`UPDATE adventures SET owner_id = ? WHERE id = ?`, [ownerId, adventureId]);
}

/** `null` takes the table back to nothing presented, which is where every adventure starts. */
export function setActiveImage(db: Database, adventureId: string, imageId: string | null): void {
  if (imageId !== null) {
    const image = db.query<{ id: string }, [string, string]>(
      `SELECT id FROM images WHERE id = ? AND adventure_id = ?`
    ).get(imageId, adventureId);
    if (!image) throw new Error(`Image ${imageId} does not belong to adventure ${adventureId}`);
  }
  db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);
}

export function setTokenSize(db: Database, adventureId: string, size: number): void {
  db.run(`UPDATE adventures SET token_size = ? WHERE id = ?`, [size, adventureId]);
}

export function deleteAdventure(db: Database, id: string): void {
  db.run(`DELETE FROM adventures WHERE id = ?`, [id]);
}
