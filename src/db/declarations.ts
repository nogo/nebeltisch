import type { Database } from "bun:sqlite";
import type { Declaration } from "../types";

/**
 * Opens a declaration. Nothing is replaced and nothing is limited.
 *
 * Two orcs swinging at the same player is two attacks, and a fighter with two weapons may say so
 * twice. Correcting a mis-tap is what retracting is for, and how many attacks a round holds is the
 * table's to count (#73).
 */
export function openDeclaration(
  db: Database,
  { imageId, sourceId, targetId }: { imageId: string; sourceId: string | null; targetId: string }
): Declaration {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO declarations (id, image_id, source_id, target_id, state) VALUES (?, ?, ?, ?, 'open')`,
    [id, imageId, sourceId, targetId]
  );
  return getDeclaration(db, id)!;
}

export function getDeclaration(db: Database, id: string): Declaration | null {
  return db.query<Declaration, string>(`SELECT * FROM declarations WHERE id = ?`).get(id) ?? null;
}

/** Everything standing on one page, oldest first — the order the pips sit in around a ring. */
export function getDeclarationsByImage(db: Database, imageId: string): Declaration[] {
  return db
    .query<Declaration, string>(
      `SELECT * FROM declarations WHERE image_id = ? ORDER BY created_at, rowid`
    )
    .all(imageId);
}

/**
 * Parried, or not. The one write the target's owner makes, and it is what closes the question.
 *
 * Leaves the row where it stands in arrival order and out of the open-declaration indexes, so the
 * attacker is free to declare again while this stays behind as the record.
 */
export function answerDeclaration(db: Database, id: string, parried: boolean): void {
  db.run(`UPDATE declarations SET state = ? WHERE id = ?`, [parried ? "parried" : "not_parried", id]);
}

/** The number the attacker rolled. Written once, never added to anything. */
export function setDeclarationDamage(db: Database, id: string, damage: number): void {
  db.run(`UPDATE declarations SET damage = ? WHERE id = ?`, [damage, id]);
}

export function deleteDeclaration(db: Database, id: string): void {
  db.run(`DELETE FROM declarations WHERE id = ?`, [id]);
}
