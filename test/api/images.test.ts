import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "../helpers";
import { createAdventure } from "../../src/db/adventures";

// Minimal valid 1x1 PNG
const PNG_BYTES = Buffer.from([
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

function makeImageFile() {
  return new File([PNG_BYTES], "test.png", { type: "image/png" });
}

describe("Image API", () => {
  let ts: TestServer;
  let adventureId: string;
  const gmPassword = "secret";

  beforeAll(() => {
    ts = startTestServer();
    const adventure = createAdventure(ts.db, { name: "Image Test", gmPassword });
    adventureId = adventure.id;
  });

  afterAll(() => {
    ts.stop();
  });

  it("POST upload with valid image file returns 201 + image record", async () => {
    const formData = new FormData();
    formData.append("file", makeImageFile());

    const res = await fetch(`${ts.url}/api/adventures/${adventureId}/images`, {
      method: "POST",
      headers: { "X-GM-Password": gmPassword },
      body: formData,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.adventure_id).toBe(adventureId);
    expect(data.original_name).toBe("test.png");
    expect(data.filename).not.toBe("test.png"); // server-generated UUID name
  });

  it("POST upload with no file returns 400", async () => {
    const formData = new FormData();

    const res = await fetch(`${ts.url}/api/adventures/${adventureId}/images`, {
      method: "POST",
      headers: { "X-GM-Password": gmPassword },
      body: formData,
    });
    expect(res.status).toBe(400);
  });

  it("POST upload without GM password returns 401", async () => {
    const formData = new FormData();
    formData.append("file", makeImageFile());

    const res = await fetch(`${ts.url}/api/adventures/${adventureId}/images`, {
      method: "POST",
      body: formData,
    });
    expect(res.status).toBe(401);
  });

  it("GET images list returns uploaded images", async () => {
    const formData = new FormData();
    formData.append("file", makeImageFile());
    await fetch(`${ts.url}/api/adventures/${adventureId}/images`, {
      method: "POST",
      headers: { "X-GM-Password": gmPassword },
      body: formData,
    });

    const res = await fetch(`${ts.url}/api/adventures/${adventureId}/images`, {
      headers: { "X-GM-Password": gmPassword },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("DELETE image removes file from disk and DB", async () => {
    const formData = new FormData();
    formData.append("file", makeImageFile());
    const uploadRes = await fetch(`${ts.url}/api/adventures/${adventureId}/images`, {
      method: "POST",
      headers: { "X-GM-Password": gmPassword },
      body: formData,
    });
    const image = await uploadRes.json();
    const filePath = join(ts.uploadsDir, image.filename);
    expect(existsSync(filePath)).toBe(true);

    const deleteRes = await fetch(
      `${ts.url}/api/adventures/${adventureId}/images/${image.id}`,
      { method: "DELETE", headers: { "X-GM-Password": gmPassword } }
    );
    expect(deleteRes.status).toBe(204);
    expect(existsSync(filePath)).toBe(false);
  });

  it("uploaded file is served at /uploads/:filename", async () => {
    const formData = new FormData();
    formData.append("file", makeImageFile());
    const uploadRes = await fetch(`${ts.url}/api/adventures/${adventureId}/images`, {
      method: "POST",
      headers: { "X-GM-Password": gmPassword },
      body: formData,
    });
    const image = await uploadRes.json();

    const fileRes = await fetch(`${ts.url}/uploads/${image.filename}`);
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get("content-type")).toContain("image");
  });
});
