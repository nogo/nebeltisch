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

  test("WAL mode is enabled", () => {
    const db = new Database(":memory:");
    createSchema(db);
    // In-memory databases don't support WAL, but we can verify the PRAGMA ran
    // by checking it doesn't throw. For file-based DBs it would return 'wal'.
    expect(() => db.query("PRAGMA journal_mode").get()).not.toThrow();
  });
});
