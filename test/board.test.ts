import { describe, it, expect } from "bun:test";
import { gapFor, layoutPages, nextFreeSpot, type Rect } from "../src/board";

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function noneOverlap(rects: Rect[]): boolean {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (overlaps(rects[i], rects[j])) return false;
    }
  }
  return true;
}

/** The real adventures this was measured against on 2026-08-09 — see #48. */
const RABENFURT = [
  { id: "a", width: 1536, height: 1122 },
  { id: "b", width: 1024, height: 768 },
  { id: "c", width: 1536, height: 1122 },
  { id: "d", width: 768, height: 512 },
  { id: "e", width: 1024, height: 1024 },
  { id: "f", width: 512, height: 512 },
];

describe("board layout", () => {
  it("lays out an adventure with no page covering another", () => {
    const positions = layoutPages(RABENFURT);
    const rects = positions.map((p, i) => ({
      x: p.x,
      y: p.y,
      width: RABENFURT[i].width,
      height: RABENFURT[i].height,
    }));
    expect(rects).toHaveLength(6);
    expect(noneOverlap(rects)).toBe(true);
  });

  it("is deterministic — the same pages always land in the same places", () => {
    expect(layoutPages(RABENFURT)).toEqual(layoutPages(RABENFURT));
  });

  it("wraps into rows rather than one long strip", () => {
    const positions = layoutPages(RABENFURT);
    const rows = new Set(positions.map((p) => p.y));
    expect(rows.size).toBeGreaterThan(1);
    expect(positions[0]).toEqual({ id: "a", x: 0, y: 0 });
  });

  it("places the only page of an adventure at the origin", () => {
    expect(layoutPages([{ id: "solo", width: 800, height: 600 }])).toEqual([
      { id: "solo", x: 0, y: 0 },
    ]);
  });

  it("returns nothing for an adventure with no pages", () => {
    expect(layoutPages([])).toEqual([]);
  });

  it("gives a page whose dimensions were never parsed a real footprint", () => {
    // width/height are 0 when the upload's header could not be read (#10). Without a floor every
    // later page would be placed on top of it.
    const positions = layoutPages([
      { id: "broken", width: 0, height: 0 },
      { id: "ok", width: 600, height: 400 },
    ]);
    expect(positions[1].x).toBeGreaterThan(0);
  });
});

describe("nextFreeSpot", () => {
  it("puts the first page of an empty board at the origin", () => {
    expect(nextFreeSpot([], 800, 600)).toEqual({ x: 0, y: 0 });
  });

  it("never covers a page that is already placed", () => {
    const existing: Rect[] = [
      { x: 0, y: 0, width: 1536, height: 1122 },
      { x: 1659, y: 0, width: 1024, height: 768 },
      { x: 0, y: 1245, width: 512, height: 512 },
    ];
    const spot = nextFreeSpot(existing, 900, 700);
    const placed: Rect = { x: spot.x, y: spot.y, width: 900, height: 700 };
    for (const r of existing) expect(overlaps(r, placed)).toBe(false);
  });

  it("does not cover a placed page whose dimensions were never parsed", () => {
    const existing: Rect[] = [{ x: 0, y: 0, width: 0, height: 0 }];
    const spot = nextFreeSpot(existing, 600, 400);
    expect(spot).not.toEqual({ x: 0, y: 0 });
  });

  it("packs a growing board without overlaps, upload after upload", () => {
    const placed: Rect[] = [];
    for (let i = 0; i < 12; i++) {
      const width = 400 + (i % 4) * 200;
      const height = 300 + (i % 3) * 150;
      const spot = nextFreeSpot(placed, width, height);
      placed.push({ x: spot.x, y: spot.y, width, height });
    }
    expect(noneOverlap(placed)).toBe(true);
  });

  it("leaves a gap proportional to the largest page", () => {
    expect(gapFor([{ width: 4000, height: 3000 }])).toBe(320);
    // Small pages still get room to breathe.
    expect(gapFor([{ width: 100, height: 100 }])).toBe(40);
  });
});
