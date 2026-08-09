import type { Database } from "bun:sqlite";
import type { ImageRecord } from "../types";

export function createImageRecord(
  db: Database,
  {
    adventureId,
    filename,
    originalName,
    width,
    height,
    boardX,
    boardY,
  }: {
    adventureId: string;
    filename: string;
    originalName: string;
    width: number;
    height: number;
    /**
     * Omitted means unarranged, which is what a page created outside an upload is. The migration in
     * `schema.ts` places anything still null on the next start.
     */
    boardX?: number;
    boardY?: number;
  }
): ImageRecord {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO images (id, adventure_id, filename, original_name, width, height, board_x, board_y)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, adventureId, filename, originalName, width, height, boardX ?? null, boardY ?? null]
  );
  return getImage(db, id)!;
}

export function getImagesByAdventure(db: Database, adventureId: string): ImageRecord[] {
  return db.query<ImageRecord, string>(
    `SELECT * FROM images WHERE adventure_id = ? ORDER BY sort_order`
  ).all(adventureId);
}

export function getImage(db: Database, id: string): ImageRecord | null {
  return db.query<ImageRecord, string>(
    `SELECT * FROM images WHERE id = ?`
  ).get(id) ?? null;
}

/**
 * Whether a page belongs to an adventure, without reading the row.
 *
 * Every fog stroke names its page now (#51), so the write paths validate one per message — and
 * `getImage` would pull the whole `fog_mask` blob sixty times a second to do it.
 */
export function imageBelongsToAdventure(
  db: Database,
  imageId: string,
  adventureId: string
): boolean {
  return db.query<{ id: string }, [string, string]>(
    `SELECT id FROM images WHERE id = ? AND adventure_id = ?`
  ).get(imageId, adventureId) !== null;
}

export function updateFogMask(db: Database, imageId: string, mask: Buffer | null): void {
  db.run(`UPDATE images SET fog_mask = ? WHERE id = ?`, [mask, imageId]);
}

/** Where player tokens are placed when this map becomes active. Null = map centre. */
export function setStartPoint(db: Database, id: string, x: number | null, y: number | null): void {
  db.run(`UPDATE images SET start_x = ?, start_y = ? WHERE id = ?`, [x, y, id]);
}

/** Freezes the start point where it is. Guards against a stray drag, not against the GM. */
export function setStartLocked(db: Database, id: string, locked: boolean): void {
  db.run(`UPDATE images SET start_locked = ? WHERE id = ?`, [locked ? 1 : 0, id]);
}

/** Where the page sits on the adventure's board. Layout only — nothing reads geography into it. */
export function setBoardPosition(db: Database, id: string, x: number, y: number): void {
  db.run(`UPDATE images SET board_x = ?, board_y = ? WHERE id = ?`, [x, y, id]);
}

export function updateImageDimensions(db: Database, id: string, width: number, height: number): void {
  db.run(`UPDATE images SET width = ?, height = ? WHERE id = ?`, [width, height, id]);
}

export function deleteImage(db: Database, id: string): void {
  db.run(`DELETE FROM images WHERE id = ?`, [id]);
}
