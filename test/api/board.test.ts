import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, type TestServer } from "../helpers";
import { createAdventure } from "../../src/db/adventures";
import { createImageRecord, getImage, updateFogMask } from "../../src/db/images";
import { serializeMask } from "../../src/fog/serialize";

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

describe("Board API", () => {
  let ts: TestServer;
  let adventureId: string;
  const gmPassword = "secret";

  beforeAll(() => {
    ts = startTestServer();
    adventureId = createAdventure(ts.db, { name: "Board Test", gmPassword }).id;
  });

  afterAll(() => {
    ts.stop();
  });

  function makePage(width = 800, height = 600, boardX?: number, boardY?: number) {
    return createImageRecord(ts.db, {
      adventureId,
      filename: `${crypto.randomUUID()}.png`,
      originalName: "page.png",
      width,
      height,
      boardX,
      boardY,
    });
  }

  describe("PUT position", () => {
    it("persists where the GM dragged a page", async () => {
      const page = makePage();
      const res = await fetch(
        `${ts.url}/api/adventures/${adventureId}/images/${page.id}/position`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-GM-Password": gmPassword },
          body: JSON.stringify({ x: 1200, y: -340.5 }),
        }
      );
      expect(res.status).toBe(200);
      const stored = getImage(ts.db, page.id)!;
      expect(stored.board_x).toBe(1200);
      expect(stored.board_y).toBe(-340.5);
    });

    it("rejects a wrong password and leaves the page where it was", async () => {
      const page = makePage(800, 600, 10, 20);
      const res = await fetch(
        `${ts.url}/api/adventures/${adventureId}/images/${page.id}/position`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-GM-Password": "wrong" },
          body: JSON.stringify({ x: 999, y: 999 }),
        }
      );
      expect(res.status).toBe(401);
      expect(getImage(ts.db, page.id)!.board_x).toBe(10);
    });

    it("rejects a page belonging to another adventure", async () => {
      const other = createAdventure(ts.db, { name: "Other", gmPassword: "pw2" });
      const foreign = createImageRecord(ts.db, {
        adventureId: other.id,
        filename: "foreign.png",
        originalName: "foreign.png",
        width: 100,
        height: 100,
      });
      const res = await fetch(
        `${ts.url}/api/adventures/${adventureId}/images/${foreign.id}/position`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-GM-Password": gmPassword },
          body: JSON.stringify({ x: 1, y: 1 }),
        }
      );
      expect(res.status).toBe(404);
    });

    it("rejects a position that is not a pair of finite numbers", async () => {
      const page = makePage();
      for (const body of [{ x: "1", y: 2 }, { x: 1 }, { x: 1, y: null }]) {
        const res = await fetch(
          `${ts.url}/api/adventures/${adventureId}/images/${page.id}/position`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json", "X-GM-Password": gmPassword },
            body: JSON.stringify(body),
          }
        );
        expect(res.status).toBe(400);
      }
    });
  });

  describe("GET fog", () => {
    it("returns null for a page nobody has painted", async () => {
      const page = makePage();
      const res = await fetch(
        `${ts.url}/api/adventures/${adventureId}/images/${page.id}/fog`,
        { headers: { "X-GM-Password": gmPassword } }
      );
      expect(res.status).toBe(200);
      expect((await res.json()).fogMask).toBeNull();
    });

    it("returns the stored mask in the same encoding the WebSocket sends", async () => {
      const page = makePage(4, 3);
      const mask = {
        width: 4,
        height: 3,
        data: new Uint8Array(new ArrayBuffer(12)).fill(255),
      };
      mask.data[0] = 0; // one revealed pixel, so the payload is not uniform
      const stored = await serializeMask(mask);
      updateFogMask(ts.db, page.id, stored);

      const res = await fetch(
        `${ts.url}/api/adventures/${adventureId}/images/${page.id}/fog`,
        { headers: { "X-GM-Password": gmPassword } }
      );
      const { fogMask } = await res.json();
      // The client decodes this with the same reader it uses for a `map:switched` payload, so the
      // bytes must be identical to what `FogSession.toBase64()` produces.
      expect(fogMask).toBe(stored.toString("base64"));
    });

    it("refuses a wrong password", async () => {
      const page = makePage();
      const res = await fetch(
        `${ts.url}/api/adventures/${adventureId}/images/${page.id}/fog`,
        { headers: { "X-GM-Password": "wrong" } }
      );
      expect(res.status).toBe(401);
    });
  });

  describe("the player image list", () => {
    // The WebSocket path never publishes a start point — "players must never learn where the party
    // will appear" — and this route was handing them every one (#57).
    it("carries no start point", async () => {
      const adventure = createAdventure(ts.db, { name: "Leak", gmPassword });
      const page = createImageRecord(ts.db, {
        adventureId: adventure.id,
        filename: "leak.png",
        originalName: "leak.png",
        width: 400,
        height: 300,
      });
      ts.db.run(`UPDATE images SET start_x = 111, start_y = 222, start_locked = 1 WHERE id = ?`, [
        page.id,
      ]);

      const asPlayer = await fetch(`${ts.url}/api/adventures/${adventure.id}/images`, {
        headers: { "X-Player-Link": adventure.player_link },
      }).then((r) => r.json());

      expect(asPlayer).toHaveLength(1);
      expect(asPlayer[0].id).toBe(page.id);
      expect(asPlayer[0].start_x).toBeUndefined();
      expect(asPlayer[0].start_y).toBeUndefined();
      expect(asPlayer[0].start_locked).toBeUndefined();
      expect(JSON.stringify(asPlayer)).not.toContain("111");
    });

    it("still carries the start point for the GM", async () => {
      const adventure = createAdventure(ts.db, { name: "GM sees it", gmPassword });
      const page = createImageRecord(ts.db, {
        adventureId: adventure.id,
        filename: "gm.png",
        originalName: "gm.png",
        width: 400,
        height: 300,
      });
      ts.db.run(`UPDATE images SET start_x = 111, start_y = 222 WHERE id = ?`, [page.id]);

      const asGm = await fetch(`${ts.url}/api/adventures/${adventure.id}/images`, {
        headers: { "X-GM-Password": gmPassword },
      }).then((r) => r.json());

      expect(asGm[0].start_x).toBe(111);
      expect(asGm[0].start_y).toBe(222);
      expect(asGm[0].start_locked).toBe(0);
    });
  });

  describe("upload placement", () => {
    // The geometry is covered in `test/board.test.ts`; what matters here is that the route
    // actually goes through it instead of leaving every upload at the origin.
    it("gives each new page its own spot on the board", async () => {
      const fresh = createAdventure(ts.db, { name: "Fresh", gmPassword });
      const spots: string[] = [];

      for (let i = 0; i < 3; i++) {
        const formData = new FormData();
        formData.append("file", new File([PNG_BYTES], "page.png", { type: "image/png" }));
        const res = await fetch(`${ts.url}/api/adventures/${fresh.id}/images`, {
          method: "POST",
          headers: { "X-GM-Password": gmPassword },
          body: formData,
        });
        expect(res.status).toBe(201);
        const page = await res.json();
        expect(page.board_x).not.toBeNull();
        expect(page.board_y).not.toBeNull();
        spots.push(`${page.board_x},${page.board_y}`);
      }

      expect(spots[0]).toBe("0,0");
      expect(new Set(spots).size).toBe(3);
    });
  });
});
