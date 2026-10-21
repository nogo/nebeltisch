import type { ServerDeps } from "../deps";
import type { User } from "../types";
import { createUser, getUser, getUserByName, setPasswordHash, setRecoveryHash } from "../db/users";
import { addPasskey, getPasskey, getPasskeysByUser, setSignCount } from "../db/passkeys";
import { createSession, deleteSession, deleteSessionsOfUser } from "../db/sessions";
import { cleanName, hashSecret, newRecoveryPhrase, normalizePhrase, passwordProblem, verifySecret } from "./secrets";
import { clearedCookie, currentUser, publicOrigin, rpIdOf, sessionCookie, sessionIdOf } from "./session";
import { ALGORITHMS, PasskeyError, verifyAssertion, verifyCreation, type AssertionResponse, type CreationResponse } from "./webauthn";

/**
 * Signing up, in and out (#54). Everything under `/api/auth/`.
 *
 * A passkey is the default way in and a password the fallback; an account may hold both. Every
 * account has a recovery phrase, shown once — at sign-up and again each time it is used, because
 * using it replaces it.
 *
 * Every way of signing in ends the same way: a new session, its id in a cookie, and the account
 * as `publicUser` describes it. No response ever carries a hash.
 */
export async function handleAuthRoutes(req: Request, deps: ServerDeps, segments: string[]): Promise<Response> {
  const { db } = deps;
  const route = `${req.method} /${segments.slice(2).join("/")}`;

  if (route === "GET /me") {
    const user = currentUser(req, db);
    return user ? json({ user: publicUser(deps, user) }) : error("Not signed in", 401);
  }

  if (route === "POST /logout") {
    const id = sessionIdOf(req);
    if (id) deleteSession(db, id);
    return new Response(null, { status: 204, headers: { "Set-Cookie": clearedCookie(req, deps) } });
  }

  const body = await readBody(req);
  if (body === null) return error("Invalid JSON", 400);

  switch (route) {
    case "POST /signup/password": {
      const name = cleanName(body.name);
      if (!name) return error("A name needs 1 to 40 characters", 400);
      const problem = passwordProblem(body.password);
      if (problem) return error(problem, 400);
      if (getUserByName(db, name)) return error("That name is taken", 409);

      const recoveryPhrase = newRecoveryPhrase();
      const [passwordHash, recoveryHash] = await Promise.all([
        hashSecret(body.password as string),
        hashSecret(normalizePhrase(recoveryPhrase)!),
      ]);
      let user: User;
      try {
        user = createUser(db, { name, passwordHash, recoveryHash });
      } catch {
        // The name was free a moment ago; someone took it while the hashes ran.
        return error("That name is taken", 409);
      }
      return signedIn(req, deps, user, 201, recoveryPhrase);
    }

    case "POST /signup/passkey/options": {
      const name = cleanName(body.name);
      if (!name) return error("A name needs 1 to 40 characters", 400);
      if (getUserByName(db, name)) return error("That name is taken", 409);
      const userId = crypto.randomUUID();
      const challenge = deps.challenges.issue({ kind: "signup", userId, name });
      return json(creationOptions(req, deps, challenge, { id: userId, name }, []));
    }

    case "POST /signup/passkey": {
      const purpose = takeChallenge(deps, body);
      if (purpose?.kind !== "signup") return error("This sign-up has expired — start again", 400);
      const passkey = await checkCreation(req, deps, body);
      if (passkey instanceof Response) return passkey;

      const recoveryPhrase = newRecoveryPhrase();
      const recoveryHash = await hashSecret(normalizePhrase(recoveryPhrase)!);
      let user: User;
      try {
        user = db.transaction(() => {
          const created = createUser(db, { id: purpose.userId, name: purpose.name, passwordHash: null, recoveryHash });
          addPasskey(db, { ...passkey, userId: created.id });
          return created;
        })();
      } catch {
        return error("That name is taken", 409);
      }
      return signedIn(req, deps, user, 201, recoveryPhrase);
    }

    case "POST /login/password": {
      const name = cleanName(body.name);
      const user = name ? getUserByName(db, name) : null;
      const password = typeof body.password === "string" ? body.password.slice(0, 1024) : "";
      // One answer for a wrong name and a wrong password, after the same amount of work.
      if (!(await verifySecret(password, user?.password_hash))) {
        return error("That name and password do not match", 401);
      }
      return signedIn(req, deps, user!, 200);
    }

    case "POST /login/passkey/options": {
      const challenge = deps.challenges.issue({ kind: "login" });
      return json({ challenge, rpId: rpIdOf(req, deps), userVerification: "required", timeout: 300_000 });
    }

    case "POST /login/passkey": {
      const purpose = takeChallenge(deps, body);
      if (purpose?.kind !== "login") return error("This login has expired — try again", 400);
      const credential = body.credential as AssertionResponse | undefined;
      const stored = typeof credential?.id === "string" ? getPasskey(db, credential.id) : null;
      if (!credential || !stored) return error("This passkey does not belong to an account here", 401);
      if (credential.userHandle && credential.userHandle !== encodeUserId(stored.user_id)) {
        return error("This passkey does not belong to an account here", 401);
      }
      try {
        const signCount = await verifyAssertion(
          credential,
          { publicKey: stored.public_key, algorithm: stored.algorithm, signCount: stored.sign_count },
          expected(req, deps, body.challenge as string)
        );
        setSignCount(db, stored.id, signCount);
      } catch (err) {
        if (err instanceof PasskeyError) return error("The passkey could not be verified", 401);
        throw err;
      }
      return signedIn(req, deps, userOf(deps, stored.user_id), 200);
    }

    case "POST /recover": {
      const name = cleanName(body.name);
      const user = name ? getUserByName(db, name) : null;
      const phrase = normalizePhrase(body.phrase) ?? "";
      if (!(await verifySecret(phrase, user?.recovery_hash))) {
        return error("That name and recovery phrase do not match", 401);
      }
      // The phrase works once. Whoever held the lost device is signed out with it.
      const recoveryPhrase = newRecoveryPhrase();
      setRecoveryHash(db, user!.id, await hashSecret(normalizePhrase(recoveryPhrase)!));
      deleteSessionsOfUser(db, user!.id);
      return signedIn(req, deps, user!, 200, recoveryPhrase);
    }
  }

  // ---- Signed in only ----

  const user = currentUser(req, db);
  if (!user) return error("Not signed in", 401);

  switch (route) {
    case "POST /passkeys/options": {
      const challenge = deps.challenges.issue({ kind: "add", userId: user.id });
      const existing = getPasskeysByUser(db, user.id).map((p) => p.id);
      return json(creationOptions(req, deps, challenge, user, existing), 200);
    }

    case "POST /passkeys": {
      const purpose = takeChallenge(deps, body);
      if (purpose?.kind !== "add" || purpose.userId !== user.id) {
        return error("Adding this passkey has expired — try again", 400);
      }
      const passkey = await checkCreation(req, deps, body);
      if (passkey instanceof Response) return passkey;
      try {
        addPasskey(db, { ...passkey, userId: user.id });
      } catch {
        return error("This passkey is already registered", 409);
      }
      return json({ user: publicUser(deps, user) }, 201);
    }

    case "PUT /password": {
      const problem = passwordProblem(body.password);
      if (problem) return error(problem, 400);
      setPasswordHash(db, user.id, await hashSecret(body.password as string));
      return json({ user: publicUser(deps, userOf(deps, user.id)) });
    }
  }

  return error("Not found", 404);
}

/** What a client may know about an account: never a hash. */
function publicUser({ db }: ServerDeps, user: User) {
  return {
    id: user.id,
    name: user.name,
    hasPassword: user.password_hash !== null,
    passkeys: getPasskeysByUser(db, user.id).length,
  };
}

function signedIn(req: Request, deps: ServerDeps, user: User, status: number, recoveryPhrase?: string): Response {
  const sessionId = createSession(deps.db, user.id);
  return json(
    { user: publicUser(deps, user), ...(recoveryPhrase ? { recoveryPhrase } : {}) },
    status,
    { "Set-Cookie": sessionCookie(req, deps, sessionId) }
  );
}

/**
 * Options for `navigator.credentials.create()`, every buffer as base64url.
 *
 * A discoverable credential, so logging in needs no name; user verification required, because the
 * passkey is the only factor.
 */
function creationOptions(
  req: Request,
  deps: ServerDeps,
  challenge: string,
  user: { id: string; name: string },
  exclude: string[]
) {
  return {
    challenge,
    rp: { id: rpIdOf(req, deps), name: "Nebeltisch" },
    user: { id: encodeUserId(user.id), name: user.name, displayName: user.name },
    pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    attestation: "none",
    excludeCredentials: exclude.map((id) => ({ type: "public-key", id })),
    timeout: 300_000,
  };
}

async function checkCreation(req: Request, deps: ServerDeps, body: Record<string, unknown>) {
  const credential = body.credential as CreationResponse | undefined;
  if (!credential || typeof credential !== "object") return error("credential is required", 400);
  try {
    const passkey = await verifyCreation(credential, expected(req, deps, body.challenge as string));
    if (getPasskey(deps.db, passkey.id)) return error("This passkey is already registered", 409);
    return passkey;
  } catch (err) {
    if (err instanceof PasskeyError) return error("The passkey could not be verified", 400);
    throw err;
  }
}

function takeChallenge({ challenges }: ServerDeps, body: Record<string, unknown>) {
  return typeof body.challenge === "string" ? challenges.take(body.challenge) : null;
}

function expected(req: Request, deps: ServerDeps, challenge: string) {
  return { challenge, origin: publicOrigin(req, deps), rpId: rpIdOf(req, deps) };
}

/** The WebAuthn user handle: the account id, as base64url bytes. */
function encodeUserId(userId: string): string {
  return Buffer.from(userId).toString("base64url");
}

function userOf({ db }: ServerDeps, userId: string): User {
  return getUser(db, userId)!;
}

/** An empty body reads as `{}`: the options steps have nothing to send. */
async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    const body = text === "" ? {} : JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function error(message: string, status: number): Response {
  return json({ error: message }, status);
}
