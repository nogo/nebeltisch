import type { Database } from "bun:sqlite";
import type { Adventure } from "../types";

/**
 * Every column but `gm_password`, which nothing may read since #56 — naming them keeps it out of
 * every row, and so out of every response built from one.
 */
const COLUMNS = `id, name, player_link, active_image_id, token_size, created_at`;

/** The adventure and its first GM, together. `gmId` null is only for tests and the migration. */
export function createAdventure(
  db: Database,
  { name, gmId }: { name: string; gmId: string | null }
): Adventure {
  const id = crypto.randomUUID();
  const playerLink = crypto.randomUUID().replace(/-/g, "").substring(0, 8);
  db.transaction(() => {
    db.run(
      `INSERT INTO adventures (id, name, gm_password, player_link) VALUES (?, ?, '', ?)`,
      [id, name, playerLink]
    );
    if (gmId) addGm(db, id, gmId);
  })();
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

export function listAdventures(db: Database): Adventure[] {
  return db.query<Adventure, []>(`SELECT ${COLUMNS} FROM adventures ORDER BY created_at`).all();
}

export function renameAdventure(db: Database, id: string, name: string): void {
  db.run(`UPDATE adventures SET name = ? WHERE id = ?`, [name, id]);
}

// ---- Its GMs (#77) ----

export function isGm(db: Database, adventureId: string, userId: string): boolean {
  return db.query<{ one: number }, [string, string]>(
    `SELECT 1 AS one FROM adventure_gms WHERE adventure_id = ? AND user_id = ?`
  ).get(adventureId, userId) !== null;
}

/** Idempotent: sharing with someone who is already a GM changes nothing. */
export function addGm(db: Database, adventureId: string, userId: string): void {
  db.run(`INSERT OR IGNORE INTO adventure_gms (adventure_id, user_id) VALUES (?, ?)`, [adventureId, userId]);
}

export function removeGm(db: Database, adventureId: string, userId: string): void {
  db.run(`DELETE FROM adventure_gms WHERE adventure_id = ? AND user_id = ?`, [adventureId, userId]);
}

/** In the order they joined, so the one who made it comes first. */
export function getGms(db: Database, adventureId: string): { id: string; name: string }[] {
  return db.query<{ id: string; name: string }, string>(
    `SELECT u.id, u.name FROM adventure_gms g JOIN users u ON u.id = g.user_id
     WHERE g.adventure_id = ? ORDER BY g.created_at, g.rowid`
  ).all(adventureId);
}

/**
 * Gives every adventure without a GM to the oldest account. Runs at every start and after each
 * sign-up, so the campaigns from before accounts reach the first person to sign up without a
 * restart or a command (decided 2026-10-21). Nothing else can leave an adventure without a GM:
 * the last one may not leave.
 */
export function adoptOrphanedAdventures(db: Database): void {
  db.run(
    `INSERT INTO adventure_gms (adventure_id, user_id)
     SELECT a.id, (SELECT id FROM users ORDER BY created_at, rowid LIMIT 1) FROM adventures a
     WHERE EXISTS (SELECT 1 FROM users)
       AND NOT EXISTS (SELECT 1 FROM adventure_gms g WHERE g.adventure_id = a.id)`
  );
}

/** What a dashboard entry shows: enough to tell two campaigns apart without opening either. */
export interface AdventureSummary {
  id: string;
  name: string;
  player_link: string;
  created_at: string;
  page_count: number;
  /** The file of the first map uploaded, for the thumbnail; null while it has none. */
  thumbnail: string | null;
  gms: { id: string; name: string }[];
}

/** Newest first: the campaign being prepared is usually the one just made. */
export function getAdventuresOfGm(db: Database, userId: string): AdventureSummary[] {
  const rows = db.query<Omit<AdventureSummary, "gms">, string>(
    `SELECT a.id, a.name, a.player_link, a.created_at,
            (SELECT COUNT(*) FROM images i WHERE i.adventure_id = a.id) AS page_count,
            (SELECT i.filename FROM images i WHERE i.adventure_id = a.id
             ORDER BY i.sort_order, i.created_at, i.rowid LIMIT 1) AS thumbnail
     FROM adventures a JOIN adventure_gms g ON g.adventure_id = a.id
     WHERE g.user_id = ? ORDER BY a.created_at DESC, a.rowid DESC`
  ).all(userId);
  return rows.map((row) => ({ ...row, gms: getGms(db, row.id) }));
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

/**
 * Removes the adventure and every row that belongs to it, in one transaction. The uploaded files
 * are the caller's: read `getImagesByAdventure` first, and unlink them after this commits.
 *
 * The presented page is cleared first, because `active_image_id` points into `images` with no
 * cascade of its own.
 */
export function deleteAdventure(db: Database, id: string): void {
  db.transaction(() => {
    db.run(`UPDATE adventures SET active_image_id = NULL WHERE id = ?`, [id]);
    db.run(`DELETE FROM tokens WHERE adventure_id = ?`, [id]);
    db.run(`DELETE FROM adventures WHERE id = ?`, [id]);
  })();
}
