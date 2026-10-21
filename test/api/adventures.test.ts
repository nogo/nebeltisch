import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { signIn, startTestServer, type TestServer } from "../helpers";
import { existsSync } from "fs";
import { join } from "path";
import { createAdventure, getAdventure, isGm } from "../../src/db/adventures";
import { createToken } from "../../src/db/tokens";
import { createImageRecord } from "../../src/db/images";

describe("Adventure API", () => {
  let ts: TestServer;
  let gm: { user: { id: string }; cookie: string };

  beforeAll(() => {
    ts = startTestServer();
    gm = signIn(ts.db);
  });

  afterAll(() => {
    ts.stop();
  });

  function create(body: unknown, cookie = gm.cookie) {
    return fetch(`${ts.url}/api/adventures`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });
  }

  it("POST /api/adventures creates one that belongs to the signed-in GM", async () => {
    const res = await create({ name: "Test Adventure" });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.name).toBe("Test Adventure");
    expect(data.player_link).toBeDefined();
    expect(isGm(ts.db, data.id, gm.user.id)).toBe(true);
  });

  it("POST /api/adventures with empty name returns 400", async () => {
    const res = await create({ name: "" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("POST /api/adventures without a session creates nothing", async () => {
    const res = await fetch(`${ts.url}/api/adventures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nobody's" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/adventures/:id with the owner's session returns 200", async () => {
    const adventure = createAdventure(ts.db, { name: "Test", gmId: gm.user.id });
    const res = await fetch(`${ts.url}/api/adventures/${adventure.id}`, {
      headers: { Cookie: gm.cookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(adventure.id);
  });

  it("GET /api/adventures/:id without a session returns 401 — knowing the id is not enough", async () => {
    const adventure = createAdventure(ts.db, { name: "Test", gmId: gm.user.id });
    const res = await fetch(`${ts.url}/api/adventures/${adventure.id}`);
    expect(res.status).toBe(401);
  });

  it("GET /api/adventures/:id of another account's adventure returns 403", async () => {
    const stranger = signIn(ts.db);
    const adventure = createAdventure(ts.db, { name: "Theirs", gmId: stranger.user.id });
    const res = await fetch(`${ts.url}/api/adventures/${adventure.id}`, {
      headers: { Cookie: gm.cookie },
    });
    expect(res.status).toBe(403);
  });

  it("GET /api/adventures/:id never returns a stored password", async () => {
    const adventure = createAdventure(ts.db, { name: "No echo", gmId: gm.user.id });
    // A row from before accounts, still holding its plaintext until the next start sweeps it.
    ts.db.run(`UPDATE adventures SET gm_password = 'old-secret' WHERE id = ?`, [adventure.id]);
    const res = await fetch(`${ts.url}/api/adventures/${adventure.id}`, {
      headers: { Cookie: gm.cookie },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("gm_password");
    expect(text).not.toContain("old-secret");
  });

  it("GET /api/adventures/:id with unknown id returns 404", async () => {
    const res = await fetch(`${ts.url}/api/adventures/nonexistent-id`, {
      headers: { Cookie: gm.cookie },
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/adventures/join/:playerLink returns 200 with limited info", async () => {
    const adventure = createAdventure(ts.db, { name: "Join Test", gmId: gm.user.id });
    const res = await fetch(`${ts.url}/api/adventures/join/${adventure.player_link}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(adventure.id);
    expect(data.name).toBe("Join Test");
    expect(data.activeImageId).toBeNull();
  });

  it("GET /api/adventures/join/:playerLink with unknown link returns 404", async () => {
    const res = await fetch(`${ts.url}/api/adventures/join/unknownlink`);
    expect(res.status).toBe(404);
  });

  it("PUT /api/adventures/:id/active-image updates adventure", async () => {
    const adventure = createAdventure(ts.db, { name: "Test", gmId: gm.user.id });
    const image = createImageRecord(ts.db, {
      adventureId: adventure.id,
      filename: "test.png",
      originalName: "test.png",
      width: 0,
      height: 0,
    });

    const res = await fetch(`${ts.url}/api/adventures/${adventure.id}/active-image`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: gm.cookie },
      body: JSON.stringify({ imageId: image.id }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.active_image_id).toBe(image.id);
  });

  it("PUT /api/adventures/:id/active-image with imageId null clears active image", async () => {
    const adventure = createAdventure(ts.db, { name: "Test", gmId: gm.user.id });

    const res = await fetch(`${ts.url}/api/adventures/${adventure.id}/active-image`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: gm.cookie },
      body: JSON.stringify({ imageId: null }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.active_image_id).toBeNull();
  });

  it("a write from a page on another site is refused, even with the GM's cookie", async () => {
    const adventure = createAdventure(ts.db, { name: "Test", gmId: gm.user.id });
    const res = await fetch(`${ts.url}/api/adventures/${adventure.id}/active-image`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: gm.cookie, Origin: "https://evil.ctl.wtf" },
      body: JSON.stringify({ imageId: null }),
    });
    expect(res.status).toBe(403);
  });

  it("a write from the site's own page goes through", async () => {
    const res = await fetch(`${ts.url}/api/adventures`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: gm.cookie, Origin: ts.url },
      body: JSON.stringify({ name: "Same site" }),
    });
    expect(res.status).toBe(201);
  });
});

describe("Dashboard (#55)", () => {
  let ts: TestServer;

  beforeAll(() => {
    ts = startTestServer();
  });

  afterAll(() => {
    ts.stop();
  });

  async function list(cookie?: string) {
    return fetch(`${ts.url}/api/adventures`, { headers: cookie ? { Cookie: cookie } : {} });
  }

  it("lists exactly the adventures the GM owns, newest first", async () => {
    const mine = signIn(ts.db);
    const theirs = signIn(ts.db);
    const first = createAdventure(ts.db, { name: "Lost Mines", gmId: mine.user.id });
    createAdventure(ts.db, { name: "Someone else's", gmId: theirs.user.id });
    const second = createAdventure(ts.db, { name: "Curse of Strahd", gmId: mine.user.id });

    const res = await list(mine.cookie);
    expect(res.status).toBe(200);
    const entries = await res.json();
    expect(entries.map((e: { id: string }) => e.id)).toEqual([second.id, first.id]);
  });

  it("tells two campaigns apart without opening them, and carries the invite link", async () => {
    const gm = signIn(ts.db);
    const adventure = createAdventure(ts.db, { name: "Lost Mines", gmId: gm.user.id });
    createImageRecord(ts.db, { adventureId: adventure.id, filename: "a.png", originalName: "a.png", width: 1, height: 1 });
    createImageRecord(ts.db, { adventureId: adventure.id, filename: "b.png", originalName: "b.png", width: 1, height: 1 });

    const [entry] = await (await list(gm.cookie)).json();
    expect(entry).toEqual({
      id: adventure.id,
      name: "Lost Mines",
      player_link: adventure.player_link,
      created_at: adventure.created_at,
      page_count: 2,
      thumbnail: "a.png",
      gms: [{ id: gm.user.id, name: gm.user.name }],
    });
  });

  it("a GM with no adventures gets an empty list, not an error", async () => {
    const gm = signIn(ts.db);
    expect(await (await list(gm.cookie)).json()).toEqual([]);
  });

  it("is refused without a session", async () => {
    expect((await list()).status).toBe(401);
  });

  it("an adventure created from the dashboard appears in it", async () => {
    const gm = signIn(ts.db);
    await fetch(`${ts.url}/api/adventures`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: gm.cookie },
      body: JSON.stringify({ name: "New one" }),
    });
    const entries = await (await list(gm.cookie)).json();
    expect(entries.map((e: { name: string }) => e.name)).toEqual(["New one"]);
  });
});

describe("Managing an adventure (#76, #77)", () => {
  let ts: TestServer;

  beforeAll(() => {
    ts = startTestServer();
  });

  afterAll(() => {
    ts.stop();
  });

  // Minimal valid 1x1 PNG
  const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
  ]);

  function call(method: string, path: string, cookie: string, body?: unknown) {
    return fetch(`${ts.url}/api/adventures${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function dashboard(cookie: string): Promise<{ id: string; name: string; gms: { name: string }[] }[]> {
    return (await fetch(`${ts.url}/api/adventures`, { headers: { Cookie: cookie } })).json();
  }

  describe("rename", () => {
    it("a GM renames it, and the new name is what the board and the dashboard read", async () => {
      const gm = signIn(ts.db);
      const adventure = createAdventure(ts.db, { name: "Lost Mnies", gmId: gm.user.id });
      const res = await call("PATCH", `/${adventure.id}`, gm.cookie, { name: "  Lost Mines " });
      expect(res.status).toBe(200);
      expect((await res.json()).name).toBe("Lost Mines");
      expect((await dashboard(gm.cookie))[0]!.name).toBe("Lost Mines");
    });

    it("refuses an empty or over-long name and keeps the old one", async () => {
      const gm = signIn(ts.db);
      const adventure = createAdventure(ts.db, { name: "Kept", gmId: gm.user.id });
      expect((await call("PATCH", `/${adventure.id}`, gm.cookie, { name: "  " })).status).toBe(400);
      expect((await call("PATCH", `/${adventure.id}`, gm.cookie, { name: "x".repeat(81) })).status).toBe(400);
      expect((await dashboard(gm.cookie))[0]!.name).toBe("Kept");
    });

    it("nobody who is not its GM can rename it", async () => {
      const gm = signIn(ts.db);
      const stranger = signIn(ts.db);
      const adventure = createAdventure(ts.db, { name: "Mine", gmId: gm.user.id });
      expect((await call("PATCH", `/${adventure.id}`, stranger.cookie, { name: "Theirs" })).status).toBe(403);
    });
  });

  describe("delete", () => {
    it("removes it for good: rows, files, invite link, dashboards", async () => {
      const gm = signIn(ts.db);
      const friend = signIn(ts.db);
      const adventure = createAdventure(ts.db, { name: "Doomed", gmId: gm.user.id });
      await call("POST", `/${adventure.id}/gms`, gm.cookie, { name: friend.user.name });

      const form = new FormData();
      form.append("file", new File([PNG], "map.png", { type: "image/png" }));
      const uploaded = await (await fetch(`${ts.url}/api/adventures/${adventure.id}/images`, {
        method: "POST", headers: { Cookie: gm.cookie }, body: form,
      })).json();
      const file = join(ts.uploadsDir, uploaded.filename);
      expect(existsSync(file)).toBe(true);

      // The hard case: presented, with a monster and a player standing on it.
      ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [uploaded.id, adventure.id]);
      createToken(ts.db, { adventureId: adventure.id, name: "Orc", color: "#c0392b", tokenType: "monster", imageId: uploaded.id });
      createToken(ts.db, { adventureId: adventure.id, name: "Alice", color: "#ff0000" });

      const res = await call("DELETE", `/${adventure.id}`, friend.cookie);
      expect(res.status).toBe(204);
      expect(existsSync(file)).toBe(false);
      expect(getAdventure(ts.db, adventure.id)).toBeNull();
      expect(ts.db.query(`SELECT COUNT(*) AS n FROM tokens WHERE adventure_id = ?`).get(adventure.id)).toEqual({ n: 0 });
      expect((await fetch(`${ts.url}/api/adventures/join/${adventure.player_link}`)).status).toBe(404);
      expect(await dashboard(gm.cookie)).toEqual([]);
      expect(await dashboard(friend.cookie)).toEqual([]);
    });

    it("nobody who is not its GM can delete it", async () => {
      const gm = signIn(ts.db);
      const stranger = signIn(ts.db);
      const adventure = createAdventure(ts.db, { name: "Safe", gmId: gm.user.id });
      expect((await call("DELETE", `/${adventure.id}`, stranger.cookie)).status).toBe(403);
      expect(getAdventure(ts.db, adventure.id)).not.toBeNull();
    });
  });

  describe("sharing", () => {
    it("by name, after which it is on both dashboards and names both GMs", async () => {
      const gm = signIn(ts.db, "Danilo");
      const friend = signIn(ts.db, "Mira");
      const adventure = createAdventure(ts.db, { name: "Together", gmId: gm.user.id });
      const res = await call("POST", `/${adventure.id}/gms`, gm.cookie, { name: "mira" });
      expect(res.status).toBe(200);

      const [entry] = await dashboard(friend.cookie);
      expect(entry!.id).toBe(adventure.id);
      expect(entry!.gms.map((g) => g.name)).toEqual(["Danilo", "Mira"]);
      // And the board opens for the friend.
      expect((await call("GET", `/${adventure.id}`, friend.cookie)).status).toBe(200);
    });

    it("an unknown name shares nothing", async () => {
      const gm = signIn(ts.db);
      const adventure = createAdventure(ts.db, { name: "Alone", gmId: gm.user.id });
      expect((await call("POST", `/${adventure.id}/gms`, gm.cookie, { name: "Nobody here" })).status).toBe(404);
      expect((await dashboard(gm.cookie))[0]!.gms).toHaveLength(1);
    });

    it("a stranger cannot share themselves in", async () => {
      const gm = signIn(ts.db);
      const stranger = signIn(ts.db);
      const adventure = createAdventure(ts.db, { name: "Closed", gmId: gm.user.id });
      expect((await call("POST", `/${adventure.id}/gms`, stranger.cookie, { name: stranger.user.name })).status).toBe(403);
    });

    it("the GM who made it can leave, and the friend carries on with everything", async () => {
      const gm = signIn(ts.db);
      const friend = signIn(ts.db);
      const adventure = createAdventure(ts.db, { name: "Handed over", gmId: gm.user.id });
      await call("POST", `/${adventure.id}/gms`, gm.cookie, { name: friend.user.name });

      expect((await call("DELETE", `/${adventure.id}/gms/${gm.user.id}`, gm.cookie)).status).toBe(200);
      expect(await dashboard(gm.cookie)).toEqual([]);
      expect((await call("GET", `/${adventure.id}`, gm.cookie)).status).toBe(403);

      expect((await call("PATCH", `/${adventure.id}`, friend.cookie, { name: "Mine now" })).status).toBe(200);
      const leave = await call("DELETE", `/${adventure.id}/gms/${friend.user.id}`, friend.cookie);
      expect(leave.status).toBe(409);
      expect((await dashboard(friend.cookie))[0]!.name).toBe("Mine now");
    });
  });
});
