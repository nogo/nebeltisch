import { describe, test, expect } from "bun:test";
import {
  createMask,
  createRevealedMask,
  applyStroke,
  applyStrokes,
  isRevealed,
  getRevealedPercentage,
} from "../../src/fog/mask";

describe("createMask", () => {
  test("returns mask with all bytes = 255", () => {
    const mask = createMask(10, 5);
    expect(mask.width).toBe(10);
    expect(mask.height).toBe(5);
    expect(mask.data.length).toBe(50);
    expect(mask.data.every((v) => v === 255)).toBe(true);
  });
});

describe("createRevealedMask", () => {
  test("returns mask with all bytes = 0", () => {
    const mask = createRevealedMask(8, 8);
    expect(mask.data.every((v) => v === 0)).toBe(true);
  });
});

describe("applyStroke", () => {
  test("reveal mode sets center pixel to 0", () => {
    const mask = createMask(10, 10);
    applyStroke(mask, { x: 5, y: 5, radius: 0, mode: "reveal" });
    expect(mask.data[5 * 10 + 5]).toBe(0);
  });

  test("fog mode on revealed mask sets pixels back to 255", () => {
    const mask = createRevealedMask(10, 10);
    applyStroke(mask, { x: 5, y: 5, radius: 2, mode: "fog" });
    expect(mask.data[5 * 10 + 5]).toBe(255);
    // pixel far away stays revealed
    expect(mask.data[0]).toBe(0);
  });

  test("stroke at edge of mask doesn't go out of bounds", () => {
    const mask = createMask(10, 10);
    // Should not throw
    applyStroke(mask, { x: 0, y: 0, radius: 5, mode: "reveal" });
    expect(mask.data[0]).toBe(0);
  });

  test("stroke at negative coordinates doesn't crash", () => {
    const mask = createMask(10, 10);
    expect(() =>
      applyStroke(mask, { x: -5, y: -5, radius: 3, mode: "reveal" })
    ).not.toThrow();
  });

  test("radius 0 affects only the center pixel", () => {
    const mask = createMask(10, 10);
    applyStroke(mask, { x: 5, y: 5, radius: 0, mode: "reveal" });
    expect(mask.data[5 * 10 + 5]).toBe(0);
    expect(mask.data[5 * 10 + 4]).toBe(255);
    expect(mask.data[5 * 10 + 6]).toBe(255);
    expect(mask.data[4 * 10 + 5]).toBe(255);
    expect(mask.data[6 * 10 + 5]).toBe(255);
  });

  test("large stroke reveals correct circular area", () => {
    const mask = createMask(100, 100);
    applyStroke(mask, { x: 50, y: 50, radius: 10, mode: "reveal" });

    // Center: definitely revealed
    expect(mask.data[50 * 100 + 50]).toBe(0);
    // Inside circle (distance ~7): revealed
    expect(mask.data[50 * 100 + 55]).toBe(0);
    // Outside circle (distance ~15): still fogged
    expect(mask.data[50 * 100 + 65]).toBe(255);
    // Just outside (distance = 11): fogged
    expect(mask.data[50 * 100 + 61]).toBe(255);
  });

  test("reveal then re-fog same area: mask is fully fogged again", () => {
    const mask = createMask(20, 20);
    applyStroke(mask, { x: 10, y: 10, radius: 5, mode: "reveal" });
    applyStroke(mask, { x: 10, y: 10, radius: 5, mode: "fog" });
    expect(mask.data.every((v) => v === 255)).toBe(true);
  });
});

describe("applyStrokes", () => {
  test("applies multiple strokes in order", () => {
    const mask = createMask(20, 20);
    applyStrokes(mask, [
      { x: 5, y: 5, radius: 2, mode: "reveal" },
      { x: 5, y: 5, radius: 2, mode: "fog" },
    ]);
    expect(mask.data[5 * 20 + 5]).toBe(255);
  });
});

describe("isRevealed", () => {
  test("returns true for revealed pixels", () => {
    const mask = createMask(10, 10);
    applyStroke(mask, { x: 3, y: 4, radius: 0, mode: "reveal" });
    expect(isRevealed(mask, 3, 4)).toBe(true);
  });

  test("returns false for fogged pixels", () => {
    const mask = createMask(10, 10);
    expect(isRevealed(mask, 3, 4)).toBe(false);
  });

  test("returns false for out-of-bounds coordinates", () => {
    const mask = createMask(10, 10);
    expect(isRevealed(mask, -1, 5)).toBe(false);
    expect(isRevealed(mask, 10, 5)).toBe(false);
    expect(isRevealed(mask, 5, -1)).toBe(false);
    expect(isRevealed(mask, 5, 10)).toBe(false);
  });
});

describe("getRevealedPercentage", () => {
  test("returns 0.0 for fully fogged mask", () => {
    const mask = createMask(10, 10);
    expect(getRevealedPercentage(mask)).toBe(0.0);
  });

  test("returns 1.0 for fully revealed mask", () => {
    const mask = createRevealedMask(10, 10);
    expect(getRevealedPercentage(mask)).toBe(1.0);
  });

  test("returns correct fraction for partial mask", () => {
    const mask = createMask(4, 1);
    mask.data[0] = 0;
    mask.data[1] = 0;
    expect(getRevealedPercentage(mask)).toBe(0.5);
  });
});
