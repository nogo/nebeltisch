/**
 * Accounts from the server's shell, for what the app deliberately has no screen for (#54).
 *
 *   bun scripts/accounts.ts list                        accounts, and who owns which adventure
 *   bun scripts/accounts.ts assign <adventure-id> <name>  make an account one of its GMs
 *   bun scripts/accounts.ts reset <name>                a new recovery phrase, printed once
 *
 * Adventures from before accounts go to the oldest account on their own; `assign` is for moving
 * one to someone else later. `reset` is the last
 * resort for someone who lost their passkey and their phrase: it signs them out everywhere and
 * prints a phrase to hand over in person.
 *
 * In the container: `docker compose exec nebeltisch bun scripts/accounts.ts list`.
 */
import { initDatabase } from "../src/db/database";
import { addGm, getAdventure, getGms, listAdventures } from "../src/db/adventures";
import { getUserByName, listUsers, setRecoveryHash } from "../src/db/users";
import { getPasskeysByUser } from "../src/db/passkeys";
import { deleteSessionsOfUser } from "../src/db/sessions";
import { hashSecret, newRecoveryPhrase, normalizePhrase } from "../src/auth/secrets";

const [command, ...args] = process.argv.slice(2);
const db = initDatabase();

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

switch (command) {
  case "list": {
    console.log("Accounts");
    for (const user of listUsers(db)) {
      const ways = [
        `${getPasskeysByUser(db, user.id).length} passkey(s)`,
        user.password_hash ? "password" : "no password",
      ];
      console.log(`  ${user.name}  (${ways.join(", ")})`);
    }
    console.log("\nAdventures");
    for (const adventure of listAdventures(db)) {
      const gms = getGms(db, adventure.id).map((gm) => gm.name).join(", ") || "NO GM";
      console.log(`  ${adventure.id}  ${adventure.created_at}  ${gms}  ${adventure.name}`);
    }
    break;
  }

  case "assign": {
    const [adventureId, name] = args;
    if (!adventureId || !name) fail("usage: assign <adventure-id> <name>");
    const adventure = getAdventure(db, adventureId) ?? fail(`No adventure ${adventureId}`);
    const user = getUserByName(db, name) ?? fail(`No account named ${name}`);
    addGm(db, adventure.id, user.id);
    console.log(`${user.name} is now a GM of ${adventure.name}`);
    break;
  }

  case "reset": {
    const [name] = args;
    if (!name) fail("usage: reset <name>");
    const user = getUserByName(db, name) ?? fail(`No account named ${name}`);
    const phrase = newRecoveryPhrase();
    setRecoveryHash(db, user.id, await hashSecret(normalizePhrase(phrase)!));
    deleteSessionsOfUser(db, user.id);
    console.log(`New recovery phrase for ${user.name}, shown once:\n\n  ${phrase}\n`);
    break;
  }

  default:
    fail("usage: bun scripts/accounts.ts list | assign <adventure-id> <name> | reset <name>");
}
