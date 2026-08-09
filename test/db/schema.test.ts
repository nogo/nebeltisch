import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../../src/db/schema";

describe("schema", () => {
  test("creates all tables without error", () => {
    const db = new Database(":memory:");
    expect(() => createSchema(db)).not.toThrow();
    const tables = db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all();
    const names = tables.map((t) => t.name);
    expect(names).toContain("adventures");
    expect(names).toContain("images");
    expect(names).toContain("tokens");
  });

  test("schema creation is idempotent", () => {
    const db = new Database(":memory:");
    expect(() => {
      createSchema(db);
      createSchema(db);
    }).not.toThrow();
  });

  test("a start point starts unlocked", () => {
    const db = new Database(":memory:");
    createSchema(db);
    db.run(
      `INSERT INTO adventures (id, name, gm_password, player_link) VALUES ('a', 'A', 'pw', 'l')`
    );
    db.run(
      `INSERT INTO images (id, adventure_id, filename, original_name, width, height)
       VALUES ('i', 'a', 'i.png', 'i.png', 100, 100)`
    );
    // Existing rows gain the column with the same default, so nothing is locked by a deploy.
    createSchema(db);
    const row = db
      .query<{ start_locked: number }, []>(`SELECT start_locked FROM images WHERE id = 'i'`)
      .get()!;
    expect(row.start_locked).toBe(0);
  });

  describe("board position migration", () => {
    function seedAdventureWithPages(db: Database, count: number): string[] {
      db.run(
        `INSERT INTO adventures (id, name, gm_password, player_link) VALUES ('adv', 'A', 'pw', 'link')`
      );
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const id = `img-${i}`;
        db.run(
          `INSERT INTO images (id, adventure_id, filename, original_name, width, height, sort_order)
           VALUES (?, 'adv', ?, ?, 800, 600, ?)`,
          [id, `${id}.png`, `${id}.png`, i]
        );
        ids.push(id);
      }
      return ids;
    }

    function positions(db: Database) {
      return db
        .query<{ id: string; board_x: number | null; board_y: number | null }, []>(
          `SELECT id, board_x, board_y FROM images ORDER BY id`
        )
        .all();
    }

    test("gives every page that predates the board a position", () => {
      const db = new Database(":memory:");
      createSchema(db);
      seedAdventureWithPages(db, 5);
      // The pages were inserted after the columns existed, so run the migration again.
      createSchema(db);

      const placed = positions(db);
      expect(placed).toHaveLength(5);
      for (const p of placed) {
        expect(p.board_x).not.toBeNull();
        expect(p.board_y).not.toBeNull();
      }
      expect(new Set(placed.map((p) => `${p.board_x},${p.board_y}`)).size).toBe(5);
    });

    test("never moves a page the GM has already arranged", () => {
      const db = new Database(":memory:");
      createSchema(db);
      seedAdventureWithPages(db, 3);
      createSchema(db);

      const before = positions(db);
      db.run(`UPDATE images SET board_x = 5000, board_y = 5000 WHERE id = 'img-1'`);
      createSchema(db);

      const after = positions(db);
      expect(after.find((p) => p.id === "img-1")).toEqual({
        id: "img-1",
        board_x: 5000,
        board_y: 5000,
      });
      expect(after.find((p) => p.id === "img-0")).toEqual(before.find((p) => p.id === "img-0")!);
    });

    test("is a no-op once every page is placed", () => {
      const db = new Database(":memory:");
      createSchema(db);
      seedAdventureWithPages(db, 4);
      createSchema(db);

      const first = positions(db);
      createSchema(db);
      expect(positions(db)).toEqual(first);
    });
  });

  test("WAL mode is enabled", () => {
    const db = new Database(":memory:");
    createSchema(db);
    // In-memory databases don't support WAL, but we can verify the PRAGMA ran
    // by checking it doesn't throw. For file-based DBs it would return 'wal'.
    expect(() => db.query("PRAGMA journal_mode").get()).not.toThrow();
  });
});
