import { describe, test, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../src/db/database";
import { createAdventure } from "../../src/db/adventures";
import { createImageRecord } from "../../src/db/images";
import { createFogRegistry } from "../../src/fog/session";
import { loadFogMask } from "../../src/fog/serialize";
import { isRevealed } from "../../src/fog/mask";

let db: Database;
let adventureId: string;
let imageId: string;

function makeImage(name = "map.png", width = 40, height = 30): string {
  return createImageRecord(db, {
    adventureId,
    filename: name,
    originalName: name,
    width,
    height,
  }).id;
}

beforeEach(() => {
  db = initDatabase(":memory:");
  adventureId = createAdventure(db, { name: "Aventuria", gmPassword: "pw" }).id;
  imageId = makeImage();
});

const reveal = (x: number, y: number, radius = 5) =>
  [{ x, y, radius, mode: "reveal" as const }];

describe("open", () => {
  test("a map with no stored mask starts fully fogged", async () => {
    const session = await createFogRegistry(db).forAdventure(adventureId).open(imageId);
    const mask = session.readMask();
    expect(mask.width).toBe(40);
    expect(mask.height).toBe(30);
    expect(isRevealed(mask, 20, 15)).toBe(false);
  });

  test("concurrent opens resolve to one session", async () => {
    const fog = createFogRegistry(db).forAdventure(adventureId);
    // Both callers start before either finishes loading. Two sessions here would
    // mean one caller's strokes land on a mask the other one overwrites.
    const [a, b] = await Promise.all([fog.open(imageId), fog.open(imageId)]);
    expect(a).toBe(b);
  });

  test("a failed open can be retried once the image is repairable", async () => {
    const fog = createFogRegistry(db).forAdventure(adventureId);
    const broken = makeImage("broken.png", 0, 0);

    await expect(fog.open(broken)).rejects.toThrow("unknown dimensions");

    db.run(`UPDATE images SET width = 10, height = 10 WHERE id = ?`, [broken]);
    expect((await fog.open(broken)).readMask().width).toBe(10);
  });

  test("reopening after eviction reloads the persisted mask", async () => {
    const fog = createFogRegistry(db).forAdventure(adventureId);
    const session = await fog.open(imageId);
    session.applyStrokes(reveal(20, 15));
    await fog.evict(imageId);

    const reopened = await fog.open(imageId);
    expect(reopened).not.toBe(session);
    expect(isRevealed(reopened.readMask(), 20, 15)).toBe(true);
  });
});

describe("history", () => {
  test("undo steps back a committed action, redo re-applies it", async () => {
    const fog = createFogRegistry(db).forAdventure(adventureId);
    const session = await fog.open(imageId);

    session.applyStrokes(reveal(10, 10));
    session.commit();
    expect(isRevealed(session.readMask(), 10, 10)).toBe(true);

    expect(session.undo()).toBe(true);
    expect(isRevealed(session.readMask(), 10, 10)).toBe(false);

    expect(session.redo()).toBe(true);
    expect(isRevealed(session.readMask(), 10, 10)).toBe(true);
  });

  test("undo and redo report false rather than throwing at the ends", async () => {
    const session = await createFogRegistry(db).forAdventure(adventureId).open(imageId);
    expect(session.undo()).toBe(false);
    expect(session.redo()).toBe(false);
    expect(session.historyState()).toEqual({ canUndo: false, canRedo: false });
  });

  test("a new action clears the redo stack", async () => {
    const session = await createFogRegistry(db).forAdventure(adventureId).open(imageId);

    session.applyStrokes(reveal(10, 10));
    session.commit();
    session.undo();
    expect(session.historyState().canRedo).toBe(true);

    session.applyStrokes(reveal(30, 20));
    session.commit();
    expect(session.historyState().canRedo).toBe(false);
  });

  test("history is capped, and trimming never alters the mask", async () => {
    const session = await createFogRegistry(db).forAdventure(adventureId).open(imageId);

    for (let i = 0; i < 50; i++) {
      session.applyStrokes(reveal(2 + i % 30, 2, 1));
      session.commit();
    }

    let steps = 0;
    while (session.undo()) steps++;
    expect(steps).toBe(40); // MAX_FOG_HISTORY
    // Stepping past the oldest snapshot is refused, not approximated: the first
    // strokes are still revealed because their snapshot fell off the stack.
    expect(isRevealed(session.readMask(), 2, 2)).toBe(true);
  });

  test("historyState is false for a map that was never opened", () => {
    expect(createFogRegistry(db).forAdventure(adventureId).historyState(imageId)).toEqual({
      canUndo: false,
      canRedo: false,
    });
  });
});

describe("persistence", () => {
  test("flush writes the mask without waiting for the debounce", async () => {
    const fog = createFogRegistry(db).forAdventure(adventureId);
    const session = await fog.open(imageId);
    session.applyStrokes(reveal(20, 15));

    expect(await loadFogMask(db, imageId)).toBeNull();
    await fog.flush();

    const stored = await loadFogMask(db, imageId);
    expect(isRevealed(stored!, 20, 15)).toBe(true);
  });

  test("flushing one adventure leaves another's pending save alone", async () => {
    // The bug this replaces: a GM disconnect flushed every adventure on the server (#9).
    const registry = createFogRegistry(db);
    const otherId = createAdventure(db, { name: "Other", gmPassword: "pw" }).id;
    const otherImageId = createImageRecord(db, {
      adventureId: otherId,
      filename: "other.png",
      originalName: "other.png",
      width: 40,
      height: 30,
    }).id;

    const mine = registry.forAdventure(adventureId);
    const theirs = registry.forAdventure(otherId);
    (await mine.open(imageId)).applyStrokes(reveal(20, 15));
    (await theirs.open(otherImageId)).applyStrokes(reveal(20, 15));

    await mine.flush();

    expect(await loadFogMask(db, imageId)).not.toBeNull();
    expect(await loadFogMask(db, otherImageId)).toBeNull();
  });

  test("flushAll covers every adventure — the shutdown path", async () => {
    const registry = createFogRegistry(db);
    (await registry.forAdventure(adventureId).open(imageId)).applyStrokes(reveal(20, 15));

    await registry.flushAll();
    expect(await loadFogMask(db, imageId)).not.toBeNull();
  });

  test("eviction flushes before dropping, so deleting a map cannot lose fog", async () => {
    const fog = createFogRegistry(db).forAdventure(adventureId);
    (await fog.open(imageId)).applyStrokes(reveal(20, 15));

    await fog.evict(imageId);

    expect(fog.peek(imageId)).toBeUndefined();
    expect(isRevealed((await loadFogMask(db, imageId))!, 20, 15)).toBe(true);
  });
});

describe("idle lifetime", () => {
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("masks are freed once the last connection has been gone for the grace period", async () => {
    const fog = createFogRegistry(db, undefined, { idleDisposeMs: 20 }).forAdventure(
      adventureId
    );
    fog.retain();
    (await fog.open(imageId)).applyStrokes(reveal(20, 15));
    fog.release();

    expect(fog.peek(imageId)).toBeDefined(); // still inside the grace period
    await settle(60);

    expect(fog.peek(imageId)).toBeUndefined();
    // Freeing is never lossy: the mask went to SQLite on the way out.
    expect(isRevealed((await loadFogMask(db, imageId))!, 20, 15)).toBe(true);
  });

  test("reconnecting within the grace period keeps the undo history", async () => {
    // This is why disposal is delayed at all: a GM page reload drops to zero
    // connections for a moment, and undo history is memory-only.
    const fog = createFogRegistry(db, undefined, { idleDisposeMs: 40 }).forAdventure(
      adventureId
    );
    fog.retain();
    const session = await fog.open(imageId);
    session.applyStrokes(reveal(10, 10));
    session.commit();

    fog.release();
    await settle(10);
    fog.retain(); // the reload lands

    await settle(60);
    expect(fog.peek(imageId)).toBe(session);
    expect(fog.historyState(imageId).canUndo).toBe(true);
  });

  test("a second connection leaving does not start the clock while one remains", async () => {
    const fog = createFogRegistry(db, undefined, { idleDisposeMs: 20 }).forAdventure(
      adventureId
    );
    fog.retain();
    fog.retain();
    await fog.open(imageId);

    fog.release();
    await settle(60);

    expect(fog.peek(imageId)).toBeDefined();
  });
});
