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
  }: {
    adventureId: string;
    filename: string;
    originalName: string;
    width: number;
    height: number;
  }
): ImageRecord {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO images (id, adventure_id, filename, original_name, width, height) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, adventureId, filename, originalName, width, height]
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

export function updateFogMask(db: Database, imageId: string, mask: Buffer | null): void {
  db.run(`UPDATE images SET fog_mask = ? WHERE id = ?`, [mask, imageId]);
}

export function deleteImage(db: Database, id: string): void {
  db.run(`DELETE FROM images WHERE id = ?`, [id]);
}
