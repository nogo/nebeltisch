import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { signIn, startTestServer, type TestServer } from "../helpers";
import { createAdventure } from "../../src/db/adventures";
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
    expect(data.owner_id).toBe(gm.user.id);
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
    const adventure = createAdventure(ts.db, { name: "Test", ownerId: gm.user.id });
    const res = await fetch(`${ts.url}/api/adventures/${adventure.id}`, {
      headers: { Cookie: gm.cookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(adventure.id);
  });

  it("GET /api/adventures/:id without a session returns 401 — knowing the id is not enough", async () => {
    const adventure = createAdventure(ts.db, { name: "Test", ownerId: gm.user.id });
    const res = await fetch(`${ts.url}/api/adventures/${adventure.id}`);
    expect(res.status).toBe(401);
  });

  it("GET /api/adventures/:id of another account's adventure returns 403", async () => {
    const stranger = signIn(ts.db);
    const adventure = createAdventure(ts.db, { name: "Theirs", ownerId: stranger.user.id });
    const res = await fetch(`${ts.url}/api/adventures/${adventure.id}`, {
      headers: { Cookie: gm.cookie },
    });
    expect(res.status).toBe(403);
  });

  it("GET /api/adventures/:id never returns a stored password", async () => {
    const adventure = createAdventure(ts.db, { name: "No echo", ownerId: gm.user.id });
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
    const adventure = createAdventure(ts.db, { name: "Join Test", ownerId: gm.user.id });
    const res = await fetch(`${ts.url}/api/adventures/join/${adventure.player_link}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(adventure.id);
    expect(data.name).toBe("Join Test");
    expect(data.activeImageId).toBeNull();
    expect(data.owner_id).toBeUndefined();
  });

  it("GET /api/adventures/join/:playerLink with unknown link returns 404", async () => {
    const res = await fetch(`${ts.url}/api/adventures/join/unknownlink`);
    expect(res.status).toBe(404);
  });

  it("PUT /api/adventures/:id/active-image updates adventure", async () => {
    const adventure = createAdventure(ts.db, { name: "Test", ownerId: gm.user.id });
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
    const adventure = createAdventure(ts.db, { name: "Test", ownerId: gm.user.id });

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
    const adventure = createAdventure(ts.db, { name: "Test", ownerId: gm.user.id });
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
    const first = createAdventure(ts.db, { name: "Lost Mines", ownerId: mine.user.id });
    createAdventure(ts.db, { name: "Someone else's", ownerId: theirs.user.id });
    createAdventure(ts.db, { name: "From before accounts", ownerId: null });
    const second = createAdventure(ts.db, { name: "Curse of Strahd", ownerId: mine.user.id });

    const res = await list(mine.cookie);
    expect(res.status).toBe(200);
    const entries = await res.json();
    expect(entries.map((e: { id: string }) => e.id)).toEqual([second.id, first.id]);
  });

  it("tells two campaigns apart without opening them, and carries the invite link", async () => {
    const gm = signIn(ts.db);
    const adventure = createAdventure(ts.db, { name: "Lost Mines", ownerId: gm.user.id });
    createImageRecord(ts.db, { adventureId: adventure.id, filename: "a.png", originalName: "a.png", width: 1, height: 1 });
    createImageRecord(ts.db, { adventureId: adventure.id, filename: "b.png", originalName: "b.png", width: 1, height: 1 });

    const [entry] = await (await list(gm.cookie)).json();
    expect(entry).toEqual({
      id: adventure.id,
      name: "Lost Mines",
      player_link: adventure.player_link,
      created_at: adventure.created_at,
      page_count: 2,
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
