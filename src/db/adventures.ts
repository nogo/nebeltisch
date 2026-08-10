import type { Database } from "bun:sqlite";
import type { Adventure } from "../types";

export function createAdventure(
  db: Database,
  { name, gmPassword }: { name: string; gmPassword: string }
): Adventure {
  const id = crypto.randomUUID();
  const playerLink = crypto.randomUUID().replace(/-/g, "").substring(0, 8);
  db.run(
    `INSERT INTO adventures (id, name, gm_password, player_link) VALUES (?, ?, ?, ?)`,
    [id, name, gmPassword, playerLink]
  );
  return getAdventure(db, id)!;
}

export function getAdventure(db: Database, id: string): Adventure | null {
  return db.query<Adventure, string>(
    `SELECT * FROM adventures WHERE id = ?`
  ).get(id) ?? null;
}

export function getAdventureByPlayerLink(db: Database, playerLink: string): Adventure | null {
  return db.query<Adventure, string>(
    `SELECT * FROM adventures WHERE player_link = ?`
  ).get(playerLink) ?? null;
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
