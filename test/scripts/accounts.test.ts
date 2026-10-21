import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase } from "../../src/db/database";
import { createAdventure, getGms } from "../../src/db/adventures";
import { createUser, getUserByName } from "../../src/db/users";
import { createSession, getSessionUser } from "../../src/db/sessions";
import { verifySecret, normalizePhrase } from "../../src/auth/secrets";

/** The server command, run as a process against a real database file (#54). */
describe("scripts/accounts.ts", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "nebeltisch-accounts-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    const proc = Bun.spawnSync(["bun", "scripts/accounts.ts", ...args], {
      env: { ...process.env, DATA_DIR: dataDir },
    });
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  }

  function db() {
    return initDatabase(join(dataDir, "nebeltisch.db"));
  }

  it("gives the adventures from before accounts to the oldest account, and assign adds a GM", () => {
    const setup = db();
    const old = createAdventure(setup, { name: "The Old Campaign", gmId: null });
    const danilo = createUser(setup, { name: "Danilo", passwordHash: null, recoveryHash: "x" });
    const mira = createUser(setup, { name: "Mira", passwordHash: null, recoveryHash: "x" });
    setup.close();

    // The command opens the database, and opening it adopts the orphan.
    expect(run("list").out).toContain("Danilo  The Old Campaign");
    expect(run("assign", old.id, "mira").code).toBe(0);

    const after = db();
    expect(getGms(after, old.id).map((gm) => gm.id)).toEqual([danilo.id, mira.id]);
  });

  it("refuses an account or adventure that does not exist", () => {
    expect(run("assign", "nope", "Nobody").code).toBe(1);
    expect(run("reset", "Nobody").code).toBe(1);
  });

  it("reset prints a new phrase that works, and signs the account out everywhere", async () => {
    const setup = db();
    const user = createUser(setup, { name: "Mira", passwordHash: null, recoveryHash: "x" });
    const session = createSession(setup, user.id);
    setup.close();

    const { out, code } = run("reset", "Mira");
    expect(code).toBe(0);
    const phrase = out.match(/[0-9A-Z]{4}(-[0-9A-Z]{4}){5}/)![0];

    const after = db();
    expect(await verifySecret(normalizePhrase(phrase)!, getUserByName(after, "Mira")!.recovery_hash)).toBe(true);
    expect(getSessionUser(after, session)).toBeNull();
  });
});
