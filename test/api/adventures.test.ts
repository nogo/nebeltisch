import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, type TestServer } from "../helpers";
import { createAdventure } from "../../src/db/adventures";
import { createImageRecord } from "../../src/db/images";

describe("Adventure API", () => {
  let ts: TestServer;

  beforeAll(() => {
    ts = startTestServer();
  });

  afterAll(() => {
    ts.stop();
  });

  it("POST /api/adventures with valid body returns 201 + adventure", async () => {
    const res = await fetch(`${ts.url}/api/adventures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Adventure", gmPassword: "secret" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.name).toBe("Test Adventure");
    expect(data.player_link).toBeDefined();
  });

  it("POST /api/adventures with empty name returns 400", async () => {
    const res = await fetch(`${ts.url}/api/adventures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", gmPassword: "secret" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("POST /api/adventures with missing gmPassword returns 400", async () => {
    const res = await fetch(`${ts.url}/api/adventures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/adventures/:id with correct password returns 200", async () => {
    const adventure = createAdventure(ts.db, { name: "Test", gmPassword: "pw" });
    const res = await fetch(`${ts.url}/api/adventures/${adventure.id}`, {
      headers: { "X-GM-Password": "pw" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(adventure.id);
  });

  it("GET /api/adventures/:id with wrong password returns 401", async () => {
    const adventure = createAdventure(ts.db, { name: "Test", gmPassword: "pw" });
    const res = await fetch(`${ts.url}/api/adventures/${adventure.id}`, {
      headers: { "X-GM-Password": "wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/adventures/:id with unknown id returns 404", async () => {
    const res = await fetch(`${ts.url}/api/adventures/nonexistent-id`, {
      headers: { "X-GM-Password": "pw" },
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/adventures/join/:playerLink returns 200 with limited info", async () => {
    const adventure = createAdventure(ts.db, { name: "Join Test", gmPassword: "pw" });
    const res = await fetch(`${ts.url}/api/adventures/join/${adventure.player_link}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(adventure.id);
    expect(data.name).toBe("Join Test");
    expect(data.activeImageId).toBeNull();
    expect(data.gm_password).toBeUndefined();
  });

  it("GET /api/adventures/join/:playerLink with unknown link returns 404", async () => {
    const res = await fetch(`${ts.url}/api/adventures/join/unknownlink`);
    expect(res.status).toBe(404);
  });

  it("PUT /api/adventures/:id/active-image updates adventure", async () => {
    const adventure = createAdventure(ts.db, { name: "Test", gmPassword: "pw" });
    const image = createImageRecord(ts.db, {
      adventureId: adventure.id,
      filename: "test.png",
      originalName: "test.png",
      width: 0,
      height: 0,
    });

    const res = await fetch(`${ts.url}/api/adventures/${adventure.id}/active-image`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-GM-Password": "pw",
      },
      body: JSON.stringify({ imageId: image.id }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.active_image_id).toBe(image.id);
  });

  it("PUT /api/adventures/:id/active-image with imageId null clears active image", async () => {
    const adventure = createAdventure(ts.db, { name: "Test", gmPassword: "pw" });

    const res = await fetch(`${ts.url}/api/adventures/${adventure.id}/active-image`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-GM-Password": "pw",
      },
      body: JSON.stringify({ imageId: null }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.active_image_id).toBeNull();
  });
});
