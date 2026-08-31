import type { Database } from "bun:sqlite";
import { gapFor, nextFreeSpot, type Rect } from "../board";

export function createSchema(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS adventures (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      gm_password TEXT NOT NULL,
      player_link TEXT NOT NULL UNIQUE,
      active_image_id TEXT NULL REFERENCES images(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      adventure_id TEXT NOT NULL REFERENCES adventures(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      fog_mask BLOB NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tokens (
      id TEXT PRIMARY KEY,
      adventure_id TEXT NOT NULL REFERENCES adventures(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      x REAL NOT NULL DEFAULT 0,
      y REAL NOT NULL DEFAULT 0,
      player_link TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration: add token_size to adventures
  try {
    db.run(`ALTER TABLE adventures ADD COLUMN token_size INTEGER NOT NULL DEFAULT 20`);
  } catch {
    // Column already exists — ignore
  }

  // Migration: rename player_session_id -> player_link for existing databases
  try {
    db.run(`ALTER TABLE tokens RENAME COLUMN player_session_id TO player_link`);
  } catch {
    // Column already renamed or doesn't exist — ignore
  }

  // Migration: add token_type column for GM monster/NPC tokens
  try {
    db.run(`ALTER TABLE tokens ADD COLUMN token_type TEXT NOT NULL DEFAULT 'player'`);
  } catch {
    // Column already exists — ignore
  }

  // Migration: add image_id so GM tokens are scoped to a specific map
  try {
    db.run(`ALTER TABLE tokens ADD COLUMN image_id TEXT NULL REFERENCES images(id)`);
  } catch {
    // Column already exists — ignore
  }

  // Migration: add per-map start point for player tokens
  try {
    db.run(`ALTER TABLE images ADD COLUMN start_x REAL NULL`);
  } catch {
    // Column already exists — ignore
  }
  try {
    db.run(`ALTER TABLE images ADD COLUMN start_y REAL NULL`);
  } catch {
    // Column already exists — ignore
  }

  // Where each token stood on each map, so switching away and back restores
  // the party instead of resetting them to the start point.
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_positions (
      token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
      image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      x REAL NOT NULL,
      y REAL NOT NULL,
      PRIMARY KEY (token_id, image_id)
    );
  `);

  // What somebody said out loud, kept until it is cleared: this token is attacking that one (#62).
  //
  // All three foreign keys cascade, and that is the whole of "a declaration dies with its tokens
  // and with its page" — there is no handler code for it. `source_id` is null for the GM's, which
  // is why it is nullable rather than pointing at a monster (#72).
  db.exec(`
    CREATE TABLE IF NOT EXISTS declarations (
      id TEXT PRIMARY KEY,
      image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      source_id TEXT NULL REFERENCES tokens(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // One open declaration per attacker, in the database rather than in a handler: declaring again
  // replaces the open one, and that is how a mis-tap is corrected and how a target is changed.
  //
  // Two indexes because the GM has no source token. A player's attacker is their token; the GM's
  // is the GM, who may have one open attack on each of several players at once — so for those the
  // target is what there can only be one of. The `state = 'open'` predicate is what lets an
  // answered declaration stay behind once #73 writes one.
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS declarations_one_open_per_source
      ON declarations(source_id)
      WHERE source_id IS NOT NULL AND state = 'open'
  `);
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS declarations_one_open_gm_per_target
      ON declarations(target_id)
      WHERE source_id IS NULL AND state = 'open'
  `);

  // Unique index prevents duplicate tokens per player per adventure
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS tokens_adventure_player_link
      ON tokens(adventure_id, player_link)
      WHERE player_link IS NOT NULL
  `);

  // Migration: a start point the GM has locked cannot be dragged (#57)
  try {
    db.run(`ALTER TABLE images ADD COLUMN start_locked INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — ignore
  }

  // Migration: where each page sits on the adventure's board (#49)
  try {
    db.run(`ALTER TABLE images ADD COLUMN board_x REAL NULL`);
  } catch {
    // Column already exists — ignore
  }
  try {
    db.run(`ALTER TABLE images ADD COLUMN board_y REAL NULL`);
  } catch {
    // Column already exists — ignore
  }

  // Migration: three token states, set by hand and by the GM alone (#61)
  try {
    db.run(`ALTER TABLE tokens ADD COLUMN state TEXT NOT NULL DEFAULT 'alive'`);
  } catch {
    // Column already exists — ignore
  }

  // Migration: what the attacker rolled, once they send it (#73). Nullable and never computed
  // from — an exchange can be left at not parried.
  try {
    db.run(`ALTER TABLE declarations ADD COLUMN damage INTEGER NULL`);
  } catch {
    // Column already exists — ignore
  }

  placeUnarrangedPages(db);
}

/**
 * Gives a board position to every page that predates the board, so an existing adventure opens in a
 * readable layout instead of a pile at the origin.
 *
 * Idempotent, and never moves a page the GM has already dragged: it only writes rows where
 * `board_x IS NULL`, and it packs them around the ones that are already placed.
 */
function placeUnarrangedPages(db: Database): void {
  const adventures = db
    .query<{ adventure_id: string }, []>(
      `SELECT DISTINCT adventure_id FROM images WHERE board_x IS NULL OR board_y IS NULL`
    )
    .all();

  for (const { adventure_id } of adventures) {
    const pages = db
      .query<
        { id: string; width: number; height: number; board_x: number | null; board_y: number | null },
        string
      >(
        `SELECT id, width, height, board_x, board_y FROM images
         WHERE adventure_id = ? ORDER BY sort_order, created_at`
      )
      .all(adventure_id);

    const gap = gapFor(pages);
    const placed: Rect[] = [];
    for (const page of pages) {
      if (page.board_x !== null && page.board_y !== null) {
        placed.push({ x: page.board_x, y: page.board_y, width: page.width, height: page.height });
      }
    }

    for (const page of pages) {
      if (page.board_x !== null && page.board_y !== null) continue;
      const spot = nextFreeSpot(placed, page.width, page.height, gap);
      db.run(`UPDATE images SET board_x = ?, board_y = ? WHERE id = ?`, [spot.x, spot.y, page.id]);
      placed.push({ x: spot.x, y: spot.y, width: page.width, height: page.height });
    }
  }
}
