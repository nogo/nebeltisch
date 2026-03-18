import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../../src/db/schema";
import {
  createImageRecord,
  getImagesByAdventure,
  getImage,
  updateFogMask,
  deleteImage,
} from "../../src/db/images";
import { createAdventure } from "../../src/db/adventures";

function makeDb(): Database {
  const db = new Database(":memory:");
  createSchema(db);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

describe("images", () => {
  let db: Database;
  let adventureId: string;

  beforeEach(() => {
    db = makeDb();
    const adv = createAdventure(db, { name: "Test", gmPassword: "pw" });
    adventureId = adv.id;
  });

  test("createImageRecord returns record with all fields", () => {
    const img = createImageRecord(db, {
      adventureId,
      filename: "map.png",
      originalName: "Map.png",
      width: 1920,
      height: 1080,
    });
    expect(img.id).toBeString();
    expect(img.adventure_id).toBe(adventureId);
    expect(img.filename).toBe("map.png");
    expect(img.original_name).toBe("Map.png");
    expect(img.width).toBe(1920);
    expect(img.height).toBe(1080);
    expect(img.fog_mask).toBeNull();
    expect(img.sort_order).toBe(0);
    expect(img.created_at).toBeString();
  });

  test("getImagesByAdventure returns records ordered by sort_order", () => {
    const img1 = createImageRecord(db, {
      adventureId,
      filename: "b.png",
      originalName: "B.png",
      width: 100,
      height: 100,
    });
    db.run("UPDATE images SET sort_order = 2 WHERE id = ?", [img1.id]);
    const img2 = createImageRecord(db, {
      adventureId,
      filename: "a.png",
      originalName: "A.png",
      width: 100,
      height: 100,
    });
    db.run("UPDATE images SET sort_order = 1 WHERE id = ?", [img2.id]);
    const images = getImagesByAdventure(db, adventureId);
    expect(images.length).toBe(2);
    expect(images[0].sort_order).toBe(1);
    expect(images[1].sort_order).toBe(2);
  });

  test("updateFogMask stores and retrieves binary data", () => {
    const img = createImageRecord(db, {
      adventureId,
      filename: "map.png",
      originalName: "Map.png",
      width: 100,
      height: 100,
    });
    const mask = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header bytes
    updateFogMask(db, img.id, mask);
    const updated = getImage(db, img.id);
    expect(updated!.fog_mask).not.toBeNull();
    expect(Buffer.from(updated!.fog_mask!)).toEqual(mask);
  });

  test("deleteImage removes record", () => {
    const img = createImageRecord(db, {
      adventureId,
      filename: "map.png",
      originalName: "Map.png",
      width: 100,
      height: 100,
    });
    deleteImage(db, img.id);
    expect(getImage(db, img.id)).toBeNull();
  });
});
