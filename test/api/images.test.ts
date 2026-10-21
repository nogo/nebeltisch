import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { signIn, startTestServer, type TestServer } from "../helpers";
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
  let gmCookie: string;
  let gmUserId: string;

  beforeAll(() => {
    ts = startTestServer();
    ({ cookie: gmCookie, user: { id: gmUserId } } = signIn(ts.db));
    const adventure = createAdventure(ts.db, { name: "Image Test", gmId: gmUserId });
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
      headers: { Cookie: gmCookie },
      body: formData,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.adventure_id).toBe(adventureId);
    expect(data.original_name).toBe("test.png");
    // The file's name and the fog stay on the server (#5); the map is fetched by page id.
    expect(data.filename).toBeUndefined();
    expect(data.fog_mask).toBeUndefined();
    expect(getImage(ts.db, data.id)!.filename).not.toBe("test.png"); // server-generated UUID name
  });

  // The header is the client's word. A forged one used to make the fog layer allocate up to 4 GB
  // for one mask, on a host shared with other services.
  it("POST upload refuses a page whose header claims more pixels than a mask may hold", async () => {
    const forged = Buffer.from(PNG_BYTES);
    forged.writeUInt32BE(60_000, 16);
    forged.writeUInt32BE(60_000, 20);
    const formData = new FormData();
    formData.append("file", new File([forged], "huge.png", { type: "image/png" }));

    const res = await fetch(`${ts.url}/api/adventures/${adventureId}/images`, {
      method: "POST",
      headers: { Cookie: gmCookie },
      body: formData,
    });
    expect(res.status).toBe(413);
    const stored = ts.db
      .query<{ n: number }, string>(`SELECT COUNT(*) AS n FROM images WHERE original_name = ?`)
      .get("huge.png");
    expect(stored!.n).toBe(0);
  });

  it("POST upload with no file returns 400", async () => {
    const formData = new FormData();

    const res = await fetch(`${ts.url}/api/adventures/${adventureId}/images`, {
      method: "POST",
      headers: { Cookie: gmCookie },
      body: formData,
    });
    expect(res.status).toBe(400);
  });

  it("POST upload without a session returns 401", async () => {
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
      headers: { Cookie: gmCookie },
      body: formData,
    });

    const res = await fetch(`${ts.url}/api/adventures/${adventureId}/images`, {
      headers: { Cookie: gmCookie },
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
      headers: { Cookie: gmCookie },
      body: formData,
    });
    const image = await uploadRes.json();
    const filePath = join(ts.uploadsDir, getImage(ts.db, image.id)!.filename);
    expect(existsSync(filePath)).toBe(true);

    const deleteRes = await fetch(
      `${ts.url}/api/adventures/${adventureId}/images/${image.id}`,
      { method: "DELETE", headers: { Cookie: gmCookie } }
    );
    expect(deleteRes.status).toBe(204);
    expect(existsSync(filePath)).toBe(false);
  });

  it("DELETE takes the page's monsters with it", async () => {
    const formData = new FormData();
    formData.append("file", makeImageFile());
    const uploadRes = await fetch(`${ts.url}/api/adventures/${adventureId}/images`, {
      method: "POST",
      headers: { Cookie: gmCookie },
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
      { method: "DELETE", headers: { Cookie: gmCookie } }
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
      headers: { Cookie: gmCookie },
      body: formData,
    });
    const image = await uploadRes.json();
    const filePath = join(ts.uploadsDir, getImage(ts.db, image.id)!.filename);
    setActiveImage(ts.db, adventureId, image.id);

    const deleteRes = await fetch(
      `${ts.url}/api/adventures/${adventureId}/images/${image.id}`,
      { method: "DELETE", headers: { Cookie: gmCookie } }
    );

    expect(deleteRes.status).toBe(409);
    // The row, the file and the pointer all survive. Before #3 was fixed this path unlinked the
    // file first and then threw, leaving a row addressing nothing.
    expect(getImage(ts.db, image.id)).not.toBe(null);
    expect(existsSync(filePath)).toBe(true);
    expect(getAdventure(ts.db, adventureId)?.active_image_id).toBe(image.id);
  });

  describe("a page's map (#4, #5)", () => {
    async function upload(adventure = adventureId, file = makeImageFile()): Promise<{ id: string }> {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${ts.url}/api/adventures/${adventure}/images`, {
        method: "POST",
        headers: { Cookie: gmCookie },
        body: formData,
      });
      return res.json();
    }

    const fileOf = (imageId: string, headers: Record<string, string> = {}, adventure = adventureId) =>
      fetch(`${ts.url}/api/adventures/${adventure}/images/${imageId}/file`, { headers });
    const asPlayer = () => ({ "X-Player-Link": getAdventure(ts.db, adventureId)!.player_link });

    it("a GM gets any page of their adventure, as an image", async () => {
      const image = await upload();
      const res = await fileOf(image.id, { Cookie: gmCookie });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
    });

    // A page is megabytes and the party reloads constantly — tablet sleep, router blip.
    it("a page is revalidated, not refetched", async () => {
      const image = await upload();
      const first = await fileOf(image.id, { Cookie: gmCookie });
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();

      const second = await fileOf(image.id, { Cookie: gmCookie, "If-None-Match": etag! });
      expect(second.status).toBe(304);
      expect((await second.arrayBuffer()).byteLength).toBe(0);
    });

    it("a player gets the presented page, and no other", async () => {
      const shown = await upload();
      const hidden = await upload();
      setActiveImage(ts.db, adventureId, shown.id);

      expect((await fileOf(shown.id, asPlayer())).status).toBe(200);
      expect((await fileOf(hidden.id, asPlayer())).status).toBe(404);

      // The page the party has left is closed to them again.
      setActiveImage(ts.db, adventureId, hidden.id);
      expect((await fileOf(shown.id, asPlayer())).status).toBe(404);
    });

    it("an invite link opens nothing in another adventure", async () => {
      const other = createAdventure(ts.db, { name: "Other table", gmId: gmUserId });
      const image = await upload(other.id);
      setActiveImage(ts.db, other.id, image.id);
      expect((await fileOf(image.id, asPlayer(), other.id)).status).toBe(404);
      // Nor does naming this adventure while asking for the other's page.
      expect((await fileOf(image.id, asPlayer())).status).toBe(404);
    });

    it("another GM, or nobody at all, gets nothing", async () => {
      const image = await upload();
      const stranger = signIn(ts.db);
      expect((await fileOf(image.id, { Cookie: stranger.cookie })).status).toBe(404);
      expect((await fileOf(image.id)).status).toBe(401);
    });

    it("the uploads directory is not served", async () => {
      const image = await upload();
      const res = await fetch(`${ts.url}/uploads/${getImage(ts.db, image.id)!.filename}`);
      expect(res.status).toBe(404);
    });

    // The extension comes from the uploader's file name, and Bun derives the upload's type from it,
    // so `.svg` passes as an image. Served by extension, an SVG runs its script on the site's origin.
    it("a file named like an SVG is served as bytes, never as a document", async () => {
      const image = await upload(adventureId, new File([PNG_BYTES], "map.svg", { type: "image/svg+xml" }));
      const res = await fileOf(image.id, { Cookie: gmCookie });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("a player gets no list of pages", async () => {
      const res = await fetch(`${ts.url}/api/adventures/${adventureId}/images`, { headers: asPlayer() });
      expect(res.status).toBe(401);
    });

    it("the GM's list carries no file name and no fog", async () => {
      await upload();
      const res = await fetch(`${ts.url}/api/adventures/${adventureId}/images`, { headers: { Cookie: gmCookie } });
      const pages = await res.json();
      expect(pages.length).toBeGreaterThan(0);
      for (const page of pages) {
        expect(page.filename).toBeUndefined();
        expect(page.fog_mask).toBeUndefined();
      }
    });
  });
});
