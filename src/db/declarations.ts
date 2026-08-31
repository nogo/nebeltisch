import type { Database } from "bun:sqlite";
import type { Declaration } from "../types";

/**
 * Opens a declaration, replacing whatever the same attacker had open.
 *
 * The replacement is the point: declaring again is how a mis-tap is corrected and how a target is
 * changed, in one tap rather than two (#62). The rows it removes are returned so the caller can
 * tell the table which pip went away — the unique indexes in `schema.ts` are what make this the
 * only way a second open declaration could ever exist.
 */
export function openDeclaration(
  db: Database,
  { imageId, sourceId, targetId }: { imageId: string; sourceId: string | null; targetId: string }
): { declaration: Declaration; replaced: Declaration[] } {
  const replaced = findOpenByAttacker(db, sourceId, targetId);
  for (const row of replaced) deleteDeclaration(db, row.id);

  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO declarations (id, image_id, source_id, target_id, state) VALUES (?, ?, ?, ?, 'open')`,
    [id, imageId, sourceId, targetId]
  );
  return { declaration: getDeclaration(db, id)!, replaced };
}

/**
 * What this attacker already has open. A player's attacker is their token, so the target is not
 * part of the question; the GM's is the GM, who attacks several players at once, so it is.
 *
 * Not scoped to a page on purpose: an open declaration left on a page nobody is looking at is
 * still the one open declaration that attacker has.
 */
export function findOpenByAttacker(
  db: Database,
  sourceId: string | null,
  targetId: string
): Declaration[] {
  if (sourceId !== null) {
    return db
      .query<Declaration, string>(`SELECT * FROM declarations WHERE source_id = ? AND state = 'open'`)
      .all(sourceId);
  }
  return db
    .query<Declaration, string>(
      `SELECT * FROM declarations WHERE source_id IS NULL AND target_id = ? AND state = 'open'`
    )
    .all(targetId);
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

export function deleteDeclaration(db: Database, id: string): void {
  db.run(`DELETE FROM declarations WHERE id = ?`, [id]);
}
