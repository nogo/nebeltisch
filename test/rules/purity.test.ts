import { it, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// The GM client bundles src/rules/ at run time, so whatever a rule imports ships to the browser.
// A type import is erased at build and a sibling rule is held to this same test.
it("src/rules imports nothing at run time but other rules", () => {
  const dir = join(import.meta.dir, "../../src/rules");
  const offending: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(join(dir, file), "utf8");
    for (const [line] of source.matchAll(/^\s*(import|export)\b[^;]*\bfrom\s+["'][^"']+["']/gm)) {
      if (/^\s*(import|export)\s+type\b/.test(line)) continue;
      if (/from\s+["']\.\/[^"']+["']/.test(line)) continue;
      offending.push(`${file}: ${line.trim()}`);
    }
    if (/\brequire\(|\bimport\(/.test(source)) offending.push(`${file}: dynamic import`);
  }
  expect(offending).toEqual([]);
});
