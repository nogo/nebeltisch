import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../../src/db/schema";
import {
  createAdventure,
  getAdventure,
  getAdventureByPlayerLink,
  setActiveImage,
  deleteAdventure,
} from "../../src/db/adventures";
import { createImageRecord, getImage } from "../../src/db/images";
import { createToken } from "../../src/db/tokens";

function makeDb(): Database {
  const db = new Database(":memory:");
  createSchema(db);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

describe("adventures", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  test("createAdventure returns record with all fields", () => {
    const adv = createAdventure(db, { name: "Test Adventure", gmPassword: "secret" });
    expect(adv.id).toBeString();
    expect(adv.name).toBe("Test Adventure");
    expect(adv.gm_password).toBe("secret");
    expect(adv.player_link).toBeString();
    expect(adv.active_image_id).toBeNull();
    expect(adv.created_at).toBeString();
  });

  test("getAdventure by ID returns correct record", () => {
    const adv = createAdventure(db, { name: "Test", gmPassword: "pw" });
    const found = getAdventure(db, adv.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(adv.id);
    expect(found!.name).toBe("Test");
  });

  test("getAdventure returns null for unknown ID", () => {
    expect(getAdventure(db, "nonexistent")).toBeNull();
  });

  test("getAdventureByPlayerLink works", () => {
    const adv = createAdventure(db, { name: "Test", gmPassword: "pw" });
    const found = getAdventureByPlayerLink(db, adv.player_link);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(adv.id);
  });

  test("setActiveImage updates the record", () => {
    const adv = createAdventure(db, { name: "Test", gmPassword: "pw" });
    const img = createImageRecord(db, {
      adventureId: adv.id,
      filename: "map.png",
      originalName: "Map.png",
      width: 800,
      height: 600,
    });
    setActiveImage(db, adv.id, img.id);
    const updated = getAdventure(db, adv.id);
    expect(updated!.active_image_id).toBe(img.id);
  });

  test("setActiveImage throws for image not in adventure", () => {
    const adv1 = createAdventure(db, { name: "A1", gmPassword: "pw" });
    const adv2 = createAdventure(db, { name: "A2", gmPassword: "pw" });
    const img = createImageRecord(db, {
      adventureId: adv2.id,
      filename: "map.png",
      originalName: "Map.png",
      width: 800,
      height: 600,
    });
    expect(() => setActiveImage(db, adv1.id, img.id)).toThrow();
  });

  test("deleteAdventure cascades to images and tokens", () => {
    const adv = createAdventure(db, { name: "Test", gmPassword: "pw" });
    const img = createImageRecord(db, {
      adventureId: adv.id,
      filename: "map.png",
      originalName: "Map.png",
      width: 800,
      height: 600,
    });
    createToken(db, { adventureId: adv.id, name: "Hero", color: "#ff0000" });
    deleteAdventure(db, adv.id);
    expect(getAdventure(db, adv.id)).toBeNull();
    expect(getImage(db, img.id)).toBeNull();
  });
});
