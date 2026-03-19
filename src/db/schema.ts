import type { Database } from "bun:sqlite";

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

  // Unique index prevents duplicate tokens per player per adventure
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS tokens_adventure_player_link
      ON tokens(adventure_id, player_link)
      WHERE player_link IS NOT NULL
  `);
}
