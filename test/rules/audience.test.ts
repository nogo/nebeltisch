import { describe, it, expect } from "bun:test";
import { reachesTable } from "../../src/rules/audience";

describe("reachesTable", () => {
  it("reaches the players from the presented page only", () => {
    expect(reachesTable("cellar", "cellar")).toBe(true);
    expect(reachesTable("mill", "cellar")).toBe(false);
    expect(reachesTable("mill", null)).toBe(false);
  });

  it("always reaches them from a player token, which stands on whatever is presented", () => {
    expect(reachesTable(null, "cellar")).toBe(true);
    expect(reachesTable(null, null)).toBe(true);
  });
});
