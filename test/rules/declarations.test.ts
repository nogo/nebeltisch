import { describe, it, expect } from "bun:test";
import { attackRefusal, ownsSource, ownsTarget } from "../../src/rules/declarations";

const gm = { role: "gm" as const };
const alice = { role: "player" as const, tokenId: "alice" };
const tokenless = { role: "player" as const };
const monster = { id: "orc", token_type: "monster" };
const npc = { id: "guard", token_type: "npc" };
const aliceToken = { id: "alice", token_type: "player" };

describe("ownsSource", () => {
  it("gives the GM the sourceless declarations, and only those", () => {
    expect(ownsSource(gm, null)).toBe(true);
    expect(ownsSource(gm, "alice")).toBe(false);
  });

  it("gives a player the declarations from their own token, and only those", () => {
    expect(ownsSource(alice, "alice")).toBe(true);
    expect(ownsSource(alice, "bob")).toBe(false);
    expect(ownsSource(alice, null)).toBe(false);
  });

  it("gives a player with no token nothing", () => {
    expect(ownsSource(tokenless, null)).toBe(false);
  });
});

describe("ownsTarget", () => {
  it("lets the GM answer for every monster and NPC, but never for a player", () => {
    expect(ownsTarget(gm, monster)).toBe(true);
    expect(ownsTarget(gm, npc)).toBe(true);
    expect(ownsTarget(gm, aliceToken)).toBe(false);
  });

  it("lets a player answer for their own token only", () => {
    expect(ownsTarget(alice, aliceToken)).toBe(true);
    expect(ownsTarget(alice, { id: "bob", token_type: "player" })).toBe(false);
    expect(ownsTarget(alice, monster)).toBe(false);
    expect(ownsTarget(tokenless, aliceToken)).toBe(false);
  });
});

describe("attackRefusal", () => {
  it("lets the party attack monsters and NPCs", () => {
    expect(attackRefusal("alice", monster)).toBeNull();
    expect(attackRefusal("alice", npc)).toBeNull();
  });

  it("lets the GM attack the party", () => {
    expect(attackRefusal(null, aliceToken)).toBeNull();
  });

  it("refuses player against player", () => {
    expect(attackRefusal("bob", aliceToken)).toBe("You cannot attack another player");
  });

  it("refuses the GM attacking their own monsters and NPCs", () => {
    expect(attackRefusal(null, monster)).toBe("Only the party can be attacked from a monster");
    expect(attackRefusal(null, npc)).toBe("Only the party can be attacked from a monster");
  });
});
