import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "../helpers";
import { createAdventure, getAdventure, setActiveImage } from "../../src/db/adventures";
import { getImage } from "../../src/db/images";
import { createToken, getGmTokensByImage } from "../../src/db/tokens";

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

  it("DELETE takes the page's monsters with it", async () => {
    const formData = new FormData();
    formData.append("file", makeImageFile());
    const uploadRes = await fetch(`${ts.url}/api/adventures/${adventureId}/images`, {
      method: "POST",
      headers: { "X-GM-Password": gmPassword },
      body: formData,
    });
    const image = await uploadRes.json();

    // `tokens.image_id` references `images(id)` with no ON DELETE clause, so before #3 was fixed
    // this delete threw — after the file had already been unlinked.
    createToken(ts.db, {
      adventureId,
      name: "Ork",
      color: "#ff0000",
      tokenType: "monster",
      x: 5,
      y: 5,
      imageId: image.id,
    });
    expect(getGmTokensByImage(ts.db, adventureId, image.id).length).toBe(1);

    const deleteRes = await fetch(
      `${ts.url}/api/adventures/${adventureId}/images/${image.id}`,
      { method: "DELETE", headers: { "X-GM-Password": gmPassword } }
    );
    expect(deleteRes.status).toBe(204);
    expect(getImage(ts.db, image.id)).toBe(null);
    expect(getGmTokensByImage(ts.db, adventureId, image.id).length).toBe(0);
  });

  it("DELETE refuses the presented page, and changes nothing", async () => {
    const formData = new FormData();
    formData.append("file", makeImageFile());
    const uploadRes = await fetch(`${ts.url}/api/adventures/${adventureId}/images`, {
      method: "POST",
      headers: { "X-GM-Password": gmPassword },
      body: formData,
    });
    const image = await uploadRes.json();
    const filePath = join(ts.uploadsDir, image.filename);
    setActiveImage(ts.db, adventureId, image.id);

    const deleteRes = await fetch(
      `${ts.url}/api/adventures/${adventureId}/images/${image.id}`,
      { method: "DELETE", headers: { "X-GM-Password": gmPassword } }
    );

    expect(deleteRes.status).toBe(409);
    // The row, the file and the pointer all survive. Before #3 was fixed this path unlinked the
    // file first and then threw, leaving a row addressing nothing.
    expect(getImage(ts.db, image.id)).not.toBe(null);
    expect(existsSync(filePath)).toBe(true);
    expect(getAdventure(ts.db, adventureId)?.active_image_id).toBe(image.id);
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

  // A page is megabytes and the party reloads constantly — tablet sleep, router blip. The
  // validator is the whole reason this route is Bun's `dir` rather than hand-written, so it
  // is what the test asserts.
  it("a page is revalidated, not refetched", async () => {
    const formData = new FormData();
    formData.append("file", makeImageFile());
    const uploadRes = await fetch(`${ts.url}/api/adventures/${adventureId}/images`, {
      method: "POST",
      headers: { "X-GM-Password": gmPassword },
      body: formData,
    });
    const image = await uploadRes.json();

    const first = await fetch(`${ts.url}/uploads/${image.filename}`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await fetch(`${ts.url}/uploads/${image.filename}`, {
      headers: { "If-None-Match": etag! },
    });
    expect(second.status).toBe(304);
    expect((await second.arrayBuffer()).byteLength).toBe(0);
  });

  // The hand-written route this replaced rejected `..` itself. Bun refuses a non-canonical
  // path before it reaches the filesystem; keep the guarantee asserted either way.
  it("refuses a path that climbs out of the uploads directory", async () => {
    const res = await fetch(`${ts.url}/uploads/..%2F..%2Fpackage.json`);
    expect(res.status).toBe(404);
  });
});
