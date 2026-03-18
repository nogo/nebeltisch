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
      player_session_id TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
