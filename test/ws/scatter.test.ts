import { describe, it, expect } from "bun:test";
import { scatterPositions } from "../../src/ws/handler";

describe("scatterPositions", () => {
  it("places tokens around the target, never on it", () => {
    // The marker sits on the point; standing on top of it hides it.
    for (const count of [1, 2, 4]) {
      for (const p of scatterPositions(count, 400, 300, 1000, 800, 20)) {
        const dist = Math.hypot(p.x - 400, p.y - 300);
        expect(dist).toBeGreaterThan(20);
      }
    }
  });

  it("grows the ring with the party so tokens never overlap", () => {
    const tokenSize = 20;
    for (const count of [2, 4, 6, 10]) {
      const positions = scatterPositions(count, 500, 500, 2000, 2000, tokenSize);
      for (let i = 0; i < positions.length; i++) {
        const a = positions[i];
        const b = positions[(i + 1) % positions.length];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(tokenSize * 2);
      }
    }
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
