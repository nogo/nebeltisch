import { describe, expect, it } from "bun:test";
import { mutants } from "../../scripts/mutate";

describe("mutants", () => {
  it("flips each operator once, on its own line", () => {
    const found = mutants("if (a === b) x();\nif (c && d) y();\n");
    expect(found.map((m) => [m.line, m.from, m.to])).toEqual([
      [1, "===", "!=="],
      [2, "&&", "||"],
    ]);
    expect(found[0]!.source).toBe("if (a !== b) x();\nif (c && d) y();\n");
  });

  it("takes the longest operator, so <= is never read as <", () => {
    expect(mutants("a <= b").map((m) => m.to)).toEqual(["<"]);
  });

  it("leaves generics and arrows alone", () => {
    expect(mutants("const m = new Map<string, number>();\nconst f = (x) => x;")).toEqual([]);
  });

  it("skips comments and strings, and keeps counting lines through them", () => {
    const source = [
      "// a === b",
      "/* c && d",
      "   e || f */",
      "const s = 'g === h' + \"i && j\" + `k ${l} || m`;",
      "if (n < o) z();",
    ].join("\n");
    expect(mutants(source).map((m) => [m.line, m.from])).toEqual([[5, "<"]]);
  });
});
