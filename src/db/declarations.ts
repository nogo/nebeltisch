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
): { declaration: Declaration; cleared: Declaration[] } {
  // Swinging again is what clears your last exchange. The table's own rhythm does the tidying, so
  // the map shows the round being played rather than every round since the fight began — and no
  // clock has to guess how long a round takes on a voice call (#74).
  //
  // Only settled ones. An open declaration of yours is still waiting on somebody, and nothing
  // waiting on an answer may disappear before it gets one — which is what keeps a fighter's second
  // attack from wiping out the first before it has been answered.
  const cleared = findSettledByAttacker(db, sourceId, targetId);
  for (const row of cleared) deleteDeclaration(db, row.id);

  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO declarations (id, image_id, source_id, target_id, state) VALUES (?, ?, ?, ?, 'open')`,
    [id, imageId, sourceId, targetId]
  );
  return { declaration: getDeclaration(db, id)!, cleared };
}

/**
 * The finished exchanges this attacker has moved past.
 *
 * A player's attacker is their token, so all of theirs count wherever they stand. The GM is not one
 * attacker but every monster, so theirs are counted per target: an orc swinging at Alrik has
 * nothing to do with the one that hit Imion last round.
 */
export function findSettledByAttacker(
  db: Database,
  sourceId: string | null,
  targetId: string
): Declaration[] {
  if (sourceId !== null) {
    return db
      .query<Declaration, string>(
        `SELECT * FROM declarations WHERE source_id = ? AND state != 'open'`
      )
      .all(sourceId);
  }
  return db
    .query<Declaration, string>(
      `SELECT * FROM declarations WHERE source_id IS NULL AND target_id = ? AND state != 'open'`
    )
    .all(targetId);
}

/**
 * Everything on a page that has been answered. What `Clear resolved` takes.
 *
 * It can never reach an open one, so the control cannot destroy something nobody has seen yet —
 * and the count of what is still open, sitting beside it, is what says the fight is not over.
 */
export function getResolvedByImage(db: Database, imageId: string): Declaration[] {
  return db
    .query<Declaration, string>(
      `SELECT * FROM declarations WHERE image_id = ? AND state != 'open'`
    )
    .all(imageId);
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
