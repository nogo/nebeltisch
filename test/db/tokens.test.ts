import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../../src/db/schema";
import {
  createToken,
  getTokensByAdventure,
  updateTokenPosition,
  deleteToken,
} from "../../src/db/tokens";
import { createAdventure, deleteAdventure } from "../../src/db/adventures";

function makeDb(): Database {
  const db = new Database(":memory:");
  createSchema(db);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

describe("tokens", () => {
  let db: Database;
  let adventureId: string;

  beforeEach(() => {
    db = makeDb();
    const adv = createAdventure(db, { name: "Test", gmPassword: "pw" });
    adventureId = adv.id;
  });

  test("createToken returns record with all fields", () => {
    const token = createToken(db, { adventureId, name: "Hero", color: "#ff0000" });
    expect(token.id).toBeString();
    expect(token.adventure_id).toBe(adventureId);
    expect(token.name).toBe("Hero");
    expect(token.color).toBe("#ff0000");
    expect(token.x).toBe(0);
    expect(token.y).toBe(0);
    expect(token.player_session_id).toBeNull();
    expect(token.created_at).toBeString();
  });

  test("getTokensByAdventure returns correct records", () => {
    createToken(db, { adventureId, name: "Hero", color: "#ff0000" });
    createToken(db, { adventureId, name: "Villain", color: "#0000ff" });
    const tokens = getTokensByAdventure(db, adventureId);
    expect(tokens.length).toBe(2);
  });

  test("updateTokenPosition changes x and y", () => {
    const token = createToken(db, { adventureId, name: "Hero", color: "#ff0000" });
    updateTokenPosition(db, token.id, 42.5, 99.1);
    const tokens = getTokensByAdventure(db, adventureId);
    const updated = tokens.find((t) => t.id === token.id)!;
    expect(updated.x).toBeCloseTo(42.5);
    expect(updated.y).toBeCloseTo(99.1);
  });

  test("deleteToken removes record", () => {
    const token = createToken(db, { adventureId, name: "Hero", color: "#ff0000" });
    deleteToken(db, token.id);
    const tokens = getTokensByAdventure(db, adventureId);
    expect(tokens.find((t) => t.id === token.id)).toBeUndefined();
  });

  test("deleting adventure cascades to tokens", () => {
    createToken(db, { adventureId, name: "Hero", color: "#ff0000" });
    deleteAdventure(db, adventureId);
    // Need a fresh adventure to check — tokens should be gone
    const adv2 = createAdventure(db, { name: "Other", gmPassword: "pw" });
    const tokens = getTokensByAdventure(db, adventureId);
    expect(tokens.length).toBe(0);
  });
});
