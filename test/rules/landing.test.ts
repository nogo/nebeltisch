import { describe, it, expect } from "bun:test";
import { arrivalPosition, landParty, ringRadius, scatterPositions } from "../../src/rules/landing";

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

/** Positions are whole pixels, so a landing can sit up to √½ px off the exact ring. */
const ROUNDING = Math.SQRT1_2;
const offRing = (p: { x: number; y: number }, cx: number, cy: number, r: number) =>
  Math.abs(Math.hypot(p.x - cx, p.y - cy) - r);

describe("ringRadius", () => {
  it("is the distance the party actually lands at, so the GM's ring shows the real spot", () => {
    for (const count of [1, 2, 5, 12]) {
      for (const p of scatterPositions(count, 1000, 1000, 2000, 2000, 20)) {
        expect(offRing(p, 1000, 1000, ringRadius(count, 20))).toBeLessThanOrEqual(ROUNDING);
      }
    }
  });

  it("draws a ring before anybody has joined", () => {
    expect(ringRadius(0, 20)).toBe(ringRadius(1, 20));
  });
});

describe("landParty", () => {
  const page = { width: 1000, height: 800, start_x: 200, start_y: 150 };

  it("lands a token that never walked here on the ring around the start point", () => {
    const pos = landParty(["a"], new Map(), page, 20).get("a")!;
    expect(offRing(pos, 200, 150, ringRadius(1, 20))).toBeLessThanOrEqual(ROUNDING);
  });

  it("returns a token that walked here to exactly where it stood", () => {
    // Close to the edge, inside the margin arrivals keep: a return must not be nudged off it.
    const pos = landParty(["a"], new Map([["a", { x: 3, y: 4 }]]), page, 20).get("a")!;
    expect(pos).toEqual({ x: 3, y: 4 });
  });

  it("pulls a remembered spot off a page that shrank back onto its edge", () => {
    const pos = landParty(["a"], new Map([["a", { x: 1500, y: -20 }]]), page, 20).get("a")!;
    expect(pos).toEqual({ x: 1000, y: 0 });
  });

  it("spreads only the arrivals on the ring, in the order given", () => {
    const remembered = new Map([["b", { x: 600, y: 600 }]]);
    const landed = landParty(["a", "b", "c"], remembered, page, 20);
    const ring = scatterPositions(2, 200, 150, 1000, 800, 20);
    expect([...landed.keys()]).toEqual(["a", "b", "c"]);
    expect(landed.get("a")).toEqual(ring[0]);
    expect(landed.get("b")).toEqual({ x: 600, y: 600 });
    expect(landed.get("c")).toEqual(ring[1]);
  });

  it("lands on the centre of a page whose start point never moved", () => {
    const centred = { width: 1000, height: 800, start_x: null, start_y: null };
    const pos = landParty(["a"], new Map(), centred, 20).get("a")!;
    expect(offRing(pos, 500, 400, ringRadius(1, 20))).toBeLessThanOrEqual(ROUNDING);
  });
});

describe("arrivalPosition", () => {
  it("gives each late joiner the next free spot on the ring", () => {
    const page = { width: 1000, height: 800, start_x: 500, start_y: 400 };
    const first = arrivalPosition(0, page, 20);
    const second = arrivalPosition(1, page, 20);
    expect(second).not.toEqual(first);
    expect(offRing(second, 500, 400, ringRadius(2, 20))).toBeLessThanOrEqual(ROUNDING);
  });
});
