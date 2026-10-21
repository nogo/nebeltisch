import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "../helpers";
import { createAuthenticator, UP, type FakeAuthenticator } from "../authenticator";
import { getUserByName } from "../../src/db/users";

/** Accounts, end to end over HTTP (#54). The passkey device is `test/authenticator.ts`. */
describe("Accounts", () => {
  let ts: TestServer;

  beforeEach(() => {
    ts = startTestServer();
  });

  afterEach(() => {
    ts.stop();
  });

  function post(path: string, body: unknown = {}, cookie?: string, method = "POST") {
    return fetch(`${ts.url}/api/auth/${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
  }

  /** The cookie a browser would keep from a response, as the header it would send back. */
  function cookieOf(res: Response): string {
    const header = res.headers.get("Set-Cookie");
    if (!header) throw new Error("No cookie set");
    return header.split(";")[0]!;
  }

  function me(cookie: string) {
    return fetch(`${ts.url}/api/auth/me`, { headers: { Cookie: cookie } });
  }

  async function signUpWithPasskey(name: string, device: FakeAuthenticator) {
    const options = await (await post("signup/passkey/options", { name })).json();
    device.userHandle = options.user.id;
    const credential = await device.create(options, ts.url);
    return post("signup/passkey", { challenge: options.challenge, credential });
  }

  async function logInWithPasskey(device: FakeAuthenticator) {
    const options = await (await post("login/passkey/options")).json();
    const credential = await device.get(options, ts.url);
    return post("login/passkey", { challenge: options.challenge, credential });
  }

  describe("signing up with a passkey", () => {
    it("creates an account with no password, signs it in, and shows a recovery phrase", async () => {
      const res = await signUpWithPasskey("Danilo", await createAuthenticator());
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.user).toMatchObject({ name: "Danilo", hasPassword: false, passkeys: 1 });
      expect(data.recoveryPhrase).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);

      const who = await me(cookieOf(res));
      expect(who.status).toBe(200);
      expect((await who.json()).user.name).toBe("Danilo");
    });

    it("refuses a name that is taken, whatever its case", async () => {
      await signUpWithPasskey("Danilo", await createAuthenticator());
      const res = await post("signup/passkey/options", { name: "danilo" });
      expect(res.status).toBe(409);
    });

    it("refuses a passkey made for another site", async () => {
      const device = await createAuthenticator();
      const options = await (await post("signup/passkey/options", { name: "A" })).json();
      const credential = await device.create(options, ts.url, { rpId: "evil.example" });
      const res = await post("signup/passkey", { challenge: options.challenge, credential });
      expect(res.status).toBe(400);
      expect(getUserByName(ts.db, "A")).toBeNull();
    });

    it("refuses a ceremony a page on another origin ran", async () => {
      const device = await createAuthenticator();
      const options = await (await post("signup/passkey/options", { name: "A" })).json();
      const credential = await device.create(options, "https://evil.example");
      expect((await post("signup/passkey", { challenge: options.challenge, credential })).status).toBe(400);
    });

    it("refuses a passkey that did not verify the person", async () => {
      const device = await createAuthenticator();
      const options = await (await post("signup/passkey/options", { name: "A" })).json();
      const credential = await device.create(options, ts.url, { flags: UP | 0x40 });
      expect((await post("signup/passkey", { challenge: options.challenge, credential })).status).toBe(400);
    });

    it("uses each challenge once", async () => {
      const device = await createAuthenticator();
      const options = await (await post("signup/passkey/options", { name: "A" })).json();
      const credential = await device.create(options, ts.url);
      await post("signup/passkey", { challenge: options.challenge, credential });
      const again = await post("signup/passkey", { challenge: options.challenge, credential });
      expect(again.status).toBe(400);
    });
  });

  describe("logging in with a passkey", () => {
    it("signs the account in, with no name typed", async () => {
      const device = await createAuthenticator();
      await signUpWithPasskey("Danilo", device);
      const res = await logInWithPasskey(device);
      expect(res.status).toBe(200);
      expect((await (await me(cookieOf(res))).json()).user.name).toBe("Danilo");
    });

    it("refuses a passkey no account here knows", async () => {
      const res = await logInWithPasskey(await createAuthenticator());
      expect(res.status).toBe(401);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    });

    it("refuses a forged signature", async () => {
      const device = await createAuthenticator();
      await signUpWithPasskey("Danilo", device);
      const options = await (await post("login/passkey/options")).json();
      const credential = await device.get(options, ts.url);
      const signature = Buffer.from(credential.signature, "base64url");
      signature[signature.length - 1]! ^= 1;
      const forged = { ...credential, signature: signature.toString("base64url") };
      expect((await post("login/passkey", { challenge: options.challenge, credential: forged })).status).toBe(401);
    });

    it("refuses a cloned key whose counter went backwards", async () => {
      const device = await createAuthenticator();
      await signUpWithPasskey("Danilo", device);
      device.counter = 5;
      expect((await logInWithPasskey(device)).status).toBe(200);
      device.counter = 5;
      expect((await logInWithPasskey(device)).status).toBe(401);
    });
  });

  it("the first account to sign up gets the adventures from before accounts, with no restart", async () => {
    ts.db.run(`INSERT INTO adventures (id, name, gm_password, player_link) VALUES ('old', 'The Old Campaign', '', 'oldlink')`);
    const signup = await post("signup/password", { name: "Danilo", password: "correct horse" });
    const list = await (await fetch(`${ts.url}/api/adventures`, { headers: { Cookie: cookieOf(signup) } })).json();
    expect(list.map((a: { name: string }) => a.name)).toEqual(["The Old Campaign"]);
  });

  describe("the password fallback", () => {
    it("signs up and logs in with a name and a password", async () => {
      const res = await post("signup/password", { name: "Mira", password: "correct horse" });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.user).toMatchObject({ name: "Mira", hasPassword: true, passkeys: 0 });
      expect(data.recoveryPhrase).toBeString();

      const login = await post("login/password", { name: "mira", password: "correct horse" });
      expect(login.status).toBe(200);
      expect((await me(cookieOf(login))).status).toBe(200);
    });

    it("needs 8 to 128 characters", async () => {
      expect((await post("signup/password", { name: "M", password: "short" })).status).toBe(400);
      expect((await post("signup/password", { name: "M", password: "x".repeat(129) })).status).toBe(400);
      expect((await post("signup/password", { name: "M", password: "12345678" })).status).toBe(201);
    });

    it("answers a wrong password and an unknown name the same way, and grants nothing", async () => {
      await post("signup/password", { name: "Mira", password: "correct horse" });
      const wrongPassword = await post("login/password", { name: "Mira", password: "wrong horse" });
      const unknownName = await post("login/password", { name: "Nobody", password: "correct horse" });
      expect(wrongPassword.status).toBe(401);
      expect(unknownName.status).toBe(401);
      expect(await wrongPassword.json()).toEqual(await unknownName.json());
      expect(wrongPassword.headers.get("Set-Cookie")).toBeNull();
    });

    it("cannot log in to a passkey-only account by password", async () => {
      await signUpWithPasskey("Danilo", await createAuthenticator());
      expect((await post("login/password", { name: "Danilo", password: "anything at all" })).status).toBe(401);
    });

    it("lets a password account add a passkey, and then log in with it", async () => {
      const signup = await post("signup/password", { name: "Mira", password: "correct horse" });
      const cookie = cookieOf(signup);
      const device = await createAuthenticator();
      const options = await (await post("passkeys/options", {}, cookie)).json();
      const credential = await device.create(options, ts.url);
      const added = await post("passkeys", { challenge: options.challenge, credential }, cookie);
      expect(added.status).toBe(201);
      expect((await added.json()).user.passkeys).toBe(1);

      const login = await logInWithPasskey(device);
      expect((await (await me(cookieOf(login))).json()).user.name).toBe("Mira");
    });

    it("lets a passkey account set a password", async () => {
      const signup = await signUpWithPasskey("Danilo", await createAuthenticator());
      const set = await post("password", { password: "correct horse" }, cookieOf(signup), "PUT");
      expect((await set.json()).user.hasPassword).toBe(true);
      expect((await post("login/password", { name: "Danilo", password: "correct horse" })).status).toBe(200);
    });
  });

  describe("the recovery phrase", () => {
    it("signs in once, then works no more, and hands out a new one", async () => {
      const lost = await createAuthenticator();
      const signup = await signUpWithPasskey("Danilo", lost);
      const { recoveryPhrase } = await signup.json();

      // Typed from paper: lower case, no dashes, an O where Crockford has a zero.
      const typed = recoveryPhrase.toLowerCase().replace(/-/g, "").replace(/0/g, "o");
      const recovered = await post("recover", { name: "Danilo", phrase: typed });
      expect(recovered.status).toBe(200);
      const { recoveryPhrase: fresh } = await recovered.json();
      expect(fresh).not.toBe(recoveryPhrase);

      expect((await post("recover", { name: "Danilo", phrase: recoveryPhrase })).status).toBe(401);

      // A new passkey on the new device, with the session the phrase gave.
      const device = await createAuthenticator();
      const cookie = cookieOf(recovered);
      const options = await (await post("passkeys/options", {}, cookie)).json();
      const credential = await device.create(options, ts.url);
      expect((await post("passkeys", { challenge: options.challenge, credential }, cookie)).status).toBe(201);
      expect((await logInWithPasskey(device)).status).toBe(200);
    });

    it("signs out whoever holds the lost device", async () => {
      const signup = await signUpWithPasskey("Danilo", await createAuthenticator());
      const oldCookie = cookieOf(signup);
      const { recoveryPhrase } = await signup.json();
      await post("recover", { name: "Danilo", phrase: recoveryPhrase });
      expect((await me(oldCookie)).status).toBe(401);
    });

    it("refuses a wrong phrase without saying whether the name exists", async () => {
      await signUpWithPasskey("Danilo", await createAuthenticator());
      const wrong = await post("recover", { name: "Danilo", phrase: "0000-0000-0000-0000-0000-0000" });
      const unknown = await post("recover", { name: "Nobody", phrase: "0000-0000-0000-0000-0000-0000" });
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toEqual(await unknown.json());
    });
  });

  describe("sessions", () => {
    it("logging out ends the session, and the old cookie does not restore it", async () => {
      const signup = await post("signup/password", { name: "Mira", password: "correct horse" });
      const cookie = cookieOf(signup);
      const out = await post("logout", {}, cookie);
      expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");
      expect((await me(cookie)).status).toBe(401);
    });

    it("a laptop and a tablet are signed in independently", async () => {
      await post("signup/password", { name: "Mira", password: "correct horse" });
      const laptop = cookieOf(await post("login/password", { name: "Mira", password: "correct horse" }));
      const tablet = cookieOf(await post("login/password", { name: "Mira", password: "correct horse" }));
      expect(laptop).not.toBe(tablet);
      await post("logout", {}, laptop);
      expect((await me(laptop)).status).toBe(401);
      expect((await me(tablet)).status).toBe(200);
    });

    it("the cookie outlives a browser restart, and scripts and other sites cannot use it", async () => {
      const res = await post("signup/password", { name: "Mira", password: "correct horse" });
      const header = res.headers.get("Set-Cookie")!;
      expect(header).toContain("Max-Age=7776000");
      expect(header).toContain("HttpOnly");
      expect(header).toContain("SameSite=Strict");
    });

    it("the cookie is Secure behind an HTTPS proxy", async () => {
      const res = await fetch(`${ts.url}/api/auth/signup/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
        body: JSON.stringify({ name: "Mira", password: "correct horse" }),
      });
      expect(res.headers.get("Set-Cookie")).toContain("Secure");
    });
  });

  describe("what a stolen database gives an attacker", () => {
    it("no password, phrase or session id stored readable, and no hash in any response", async () => {
      const signup = await post("signup/password", { name: "Mira", password: "correct horse" });
      const cookie = cookieOf(signup);
      const body = await signup.text();
      const { recoveryPhrase } = JSON.parse(body);
      const meText = await (await me(cookie)).text();

      const dump = JSON.stringify([
        ts.db.query(`SELECT * FROM users`).all(),
        ts.db.query(`SELECT * FROM sessions`).all(),
      ]);
      expect(dump).not.toContain("correct horse");
      expect(dump).not.toContain(recoveryPhrase.replace(/-/g, ""));
      expect(dump).not.toContain(cookie.split("=")[1]!);
      expect(dump).toContain("$argon2id$");

      for (const text of [body, meText]) {
        expect(text).not.toContain("$argon2");
        expect(text).not.toContain("password_hash");
        expect(text).not.toContain("recovery_hash");
      }
    });

    it("a passkey is stored as its public key alone", async () => {
      await signUpWithPasskey("Danilo", await createAuthenticator());
      const columns = ts.db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('passkeys')`).all();
      expect(columns.map((c) => c.name).sort()).toEqual(["algorithm", "created_at", "id", "public_key", "sign_count", "user_id"]);
    });
  });

  describe("the account page", () => {
    it("is served at /account by the home page, which draws it", async () => {
      const [home, account] = await Promise.all([fetch(`${ts.url}/`), fetch(`${ts.url}/account`)]);
      expect(account.status).toBe(200);
      expect(account.headers.get("Content-Type")).toBe("text/html");
      expect(await account.text()).toBe(await home.text());
    });
  });
});
