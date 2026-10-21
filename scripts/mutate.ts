/**
 * Mutation testing without a dependency: flips one operator at a time in a source file and runs the
 * tests against it. A mutant the tests still pass on is a bug nothing would catch.
 *
 *   bun run mutate src/ws/handler.ts [--tests test/ws] [--jobs 8]
 *
 * Mutants are made in throwaway copies of the repo under the system temp directory, never in the
 * working tree, so an interrupted run leaves nothing behind to clean up.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Each operator and what it becomes. `<` and `>` count only between spaces, which leaves generics and `=>` alone. */
const SWAPS: Record<string, string> = {
  "===": "!==",
  "!==": "===",
  "&&": "||",
  "||": "&&",
  " < ": " <= ",
  " <= ": " < ",
  " > ": " >= ",
  " >= ": " > ",
};
const OPERATORS = Object.keys(SWAPS).sort((a, b) => b.length - a.length);

export interface Mutant {
  line: number;
  from: string;
  to: string;
  source: string;
}

/** Every single-operator mutant of `source`, skipping comments, strings and template literals. */
export function mutants(source: string): Mutant[] {
  const found: Mutant[] = [];
  let line = 1;
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\n") line++;
    if (source.startsWith("//", i)) {
      i = source.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      line += countNewlines(source.slice(i, end));
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = closingQuote(source, i);
      line += countNewlines(source.slice(i, end));
      i = end + 1;
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      found.push({
        line,
        from: op.trim(),
        to: SWAPS[op]!.trim(),
        source: source.slice(0, i) + SWAPS[op] + source.slice(i + op.length),
      });
      i += op.length;
      continue;
    }
    i++;
  }
  return found;
}

function countNewlines(text: string): number {
  return text.split("\n").length - 1;
}

/** Index of the quote that closes the one at `start`. A `${…}` inside a template is skipped whole, not mutated. */
function closingQuote(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === quote) return i;
  }
  return source.length;
}

async function run(file: string, tests: string[], jobs: number): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const original = readFileSync(join(root, file), "utf8");
  const all = mutants(original);
  console.log(`${file}: ${all.length} mutants, ${jobs} jobs`);

  const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: root }).stdout.toString().trim().split("\n");
  const copies = Array.from({ length: jobs }, () => {
    const dir = mkdtempSync(join(tmpdir(), "nebeltisch-mutate-"));
    for (const path of tracked) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      cpSync(join(root, path), join(dir, path));
    }
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
    return dir;
  });

  const survivors: Mutant[] = [];
  let next = 0;
  let done = 0;
  await Promise.all(
    copies.map(async (dir) => {
      while (next < all.length) {
        const mutant = all[next++]!;
        writeFileSync(join(dir, file), mutant.source);
        // A mutant that hangs the suite counts as caught: the timeout is a failure the check reports.
        const proc = Bun.spawn(["timeout", "120", "bun", "test", ...tests], { cwd: dir, stdout: "ignore", stderr: "ignore" });
        if ((await proc.exited) === 0) survivors.push(mutant);
        process.stdout.write(`\r${++done}/${all.length}`);
      }
    })
  );
  for (const dir of copies) rmSync(dir, { recursive: true, force: true });

  const killed = all.length - survivors.length;
  const score = all.length === 0 ? 100 : Math.round((killed / all.length) * 100);
  console.log(`\nkilled ${killed}/${all.length} (${score}%)`);
  const lines = original.split("\n");
  for (const m of survivors.sort((a, b) => a.line - b.line)) {
    console.log(`  survived ${file}:${m.line}  ${m.from} → ${m.to}   ${lines[m.line - 1]!.trim()}`);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!file) {
    console.error("usage: bun run mutate <file> [--tests <path>...] [--jobs <n>]");
    process.exit(2);
  }
  const tests = args.flatMap((a, i) => (args[i - 1] === "--tests" ? [a] : []));
  const jobsArg = args[args.indexOf("--jobs") + 1];
  const jobs = args.includes("--jobs") && jobsArg ? Number(jobsArg) : 8;
  await run(file, tests, jobs);
}
