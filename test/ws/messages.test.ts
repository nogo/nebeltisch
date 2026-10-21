import { describe, expect, it } from "bun:test";
import { parseMessage } from "../../src/ws/messages";

/** Whether `parseMessage` lets this message through to a handler. */
function accepted(message: unknown): boolean {
  return "message" in parseMessage(JSON.stringify(message));
}

const stroke = { x: 1, y: 1, radius: 10, mode: "reveal" };

describe("parseMessage", () => {
  // `parseMessage` runs before the handler's last net, so a throw here would exit the process.
  it("refuses a null message, and a null stroke, without throwing", () => {
    expect(parseMessage("null")).toEqual({ error: "Invalid message format" });
    expect(accepted({ type: "fog:stroke", imageId: "page", stroke: null })).toBe(false);
  });

  it("takes an id from one character up to 64, and nothing outside that", () => {
    expect(accepted({ type: "map:switch", imageId: "a" })).toBe(true);
    expect(accepted({ type: "map:switch", imageId: "a".repeat(64) })).toBe(true);
    expect(accepted({ type: "map:switch", imageId: "" })).toBe(false);
    expect(accepted({ type: "map:switch", imageId: "a".repeat(65) })).toBe(false);
  });

  it("takes text up to 500 characters, and only as a string", () => {
    const place = { type: "gm_token:place", imageId: "page", tokenType: "monster", x: 1, y: 1 };
    expect(accepted({ ...place, name: "a".repeat(500) })).toBe(true);
    expect(accepted({ ...place, name: "a".repeat(501) })).toBe(false);
    // An array has a length too, and the handler would call `trim` on it.
    expect(accepted({ ...place, name: ["Ork"] })).toBe(false);
  });

  it("takes a brush radius above 0 and up to 1000", () => {
    const at = (radius: number) => accepted({ type: "fog:stroke", imageId: "page", stroke: { ...stroke, radius } });
    expect(at(1000)).toBe(true);
    expect(at(0)).toBe(false);
    expect(at(1001)).toBe(false);
  });

  it("takes a batch of up to 256 strokes", () => {
    const batch = (n: number) =>
      accepted({ type: "fog:stroke:batch", imageId: "page", strokes: Array(n).fill(stroke) });
    expect(batch(256)).toBe(true);
    expect(batch(257)).toBe(false);
  });

  it("lets an optional field be absent, and checks it when present", () => {
    const join = { type: "join", adventureId: "adv", role: "player" };
    expect(accepted(join)).toBe(true);
    expect(accepted({ ...join, playerName: 7 })).toBe(false);
  });
});
