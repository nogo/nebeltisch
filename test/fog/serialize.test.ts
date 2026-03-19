import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../../src/db/schema";
import { createAdventure } from "../../src/db/adventures";
import { createImageRecord } from "../../src/db/images";
import { createMask, createRevealedMask } from "../../src/fog/mask";
import {
  serializeMask,
  deserializeMask,
  saveFogMask,
  loadFogMask,
} from "../../src/fog/serialize";

function makeDb(): Database {
  const db = new Database(":memory:");
  createSchema(db);
  return db;
}

describe("serializeMask / deserializeMask", () => {
  test("round-trip preserves width, height, and data for 10x10 mask", async () => {
    const mask = createMask(10, 10);
    const buf = await serializeMask(mask);
    const restored = deserializeMask(buf);
    expect(restored.width).toBe(10);
    expect(restored.height).toBe(10);
    expect(restored.data).toEqual(mask.data);
  });

  test("round-trip preserves mixed revealed/fogged pixels", async () => {
    const mask = createMask(10, 10);
    mask.data[0] = 0;
    mask.data[5] = 0;
    mask.data[50] = 128;
    mask.data[99] = 0;
    const buf = await serializeMask(mask);
    const restored = deserializeMask(buf);
    expect(restored.data).toEqual(mask.data);
  });

  test("round-trip of fully revealed mask", async () => {
    const mask = createRevealedMask(8, 6);
    const buf = await serializeMask(mask);
    const restored = deserializeMask(buf);
    expect(restored.width).toBe(8);
    expect(restored.height).toBe(6);
    expect(restored.data.every((v) => v === 0)).toBe(true);
  });

  test("deserialize corrupted data throws", () => {
    const bad = Buffer.from([0, 0, 0, 5, 0, 0, 0, 5, 0xde, 0xad, 0xbe, 0xef]);
    expect(() => deserializeMask(bad)).toThrow();
  });

  test("deserialize data that is too short throws", () => {
    const bad = Buffer.from([0, 0, 0]);
    expect(() => deserializeMask(bad)).toThrow();
  });

  test("round-trip with valid dimensions preserves exact pixel values", async () => {
    const mask = createMask(4, 3);
    mask.data[0] = 0;    // revealed
    mask.data[6] = 128;  // partial
    mask.data[11] = 255; // fogged
    const buf = await serializeMask(mask);
    const restored = deserializeMask(buf);
    expect(restored.width).toBe(4);
    expect(restored.height).toBe(3);
    expect(restored.data[0]).toBe(0);
    expect(restored.data[6]).toBe(128);
    expect(restored.data[11]).toBe(255);
  });

  test("deserialize 0x0 header returns empty mask (graceful fallback)", () => {
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32BE(0, 0);
    header.writeUInt32BE(0, 4);
    const compressed = Buffer.from(Bun.deflateSync(new Uint8Array(0)));
    const data = Buffer.concat([header, compressed]);
    const mask = deserializeMask(data);
    expect(mask.width).toBe(0);
    expect(mask.height).toBe(0);
    expect(mask.data.length).toBe(0);
  });
});

describe("saveFogMask / loadFogMask", () => {
  let db: Database;
  let imageId: string;

  beforeEach(() => {
    db = makeDb();
    const adv = createAdventure(db, { name: "Test", gmPassword: "pw" });
    const img = createImageRecord(db, {
      adventureId: adv.id,
      filename: "map.png",
      originalName: "Map.png",
      width: 20,
      height: 15,
    });
    imageId = img.id;
  });

  test("save then load returns matching mask", async () => {
    const mask = createMask(20, 15);
    mask.data[0] = 0;
    mask.data[100] = 0;
    await saveFogMask(db, imageId, mask);
    const loaded = await loadFogMask(db, imageId);
    expect(loaded).not.toBeNull();
    expect(loaded!.width).toBe(20);
    expect(loaded!.height).toBe(15);
    expect(loaded!.data).toEqual(mask.data);
  });

  test("loadFogMask returns null when no mask stored", async () => {
    const result = await loadFogMask(db, imageId);
    expect(result).toBeNull();
  });

  test("loadFogMask returns null for unknown imageId", async () => {
    const result = await loadFogMask(db, "nonexistent-id");
    expect(result).toBeNull();
  });
});
