import { describe, it, expect } from "bun:test";
import { scatterPositions } from "../../src/ws/handler";

describe("scatterPositions", () => {
  it("places a single token exactly on the target", () => {
    const [p] = scatterPositions(1, 400, 300, 1000, 800, 20);
    expect(p).toEqual({ x: 400, y: 300 });
  });

  it("keeps every token inside the image", () => {
    // Target is the far corner of a small map — every token must still land inside.
    const positions = scatterPositions(4, 100, 100, 100, 100, 20);
    for (const p of positions) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(100);
    }
  });

  it("does not stack tokens on top of each other", () => {
    const positions = scatterPositions(4, 500, 500, 1000, 1000, 20);
    const seen = new Set(positions.map((p) => `${p.x},${p.y}`));
    expect(seen.size).toBe(4);
  });

  it("survives an image smaller than the token", () => {
    const positions = scatterPositions(3, 5, 5, 10, 10, 40);
    expect(positions).toHaveLength(3);
    for (const p of positions) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(10);
    }
  });

  it("returns an empty array for no tokens", () => {
    expect(scatterPositions(0, 50, 50, 100, 100, 20)).toEqual([]);
  });
});
