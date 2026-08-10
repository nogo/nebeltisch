import { readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import {
  createAdventure,
  getAdventure,
  getAdventureByPlayerLink,
  setActiveImage,
} from "./db/adventures";
import {
  createImageRecord,
  getImagesByAdventure,
  getImage,
  deleteImage,
  setBoardPosition,
} from "./db/images";
import { getGmTokensByImage, deleteTokensByImage } from "./db/tokens";
import { nextFreeSpot } from "./board";
import { parseImageDimensions } from "./images";
import type { ServerDeps } from "./deps";

const publicDir = join(import.meta.dir, "..", "public");

export function handleRequest(
  req: Request,
  deps: ServerDeps
): Promise<Response> | Response {
  const { uploadsDir } = deps;
  const url = new URL(req.url);
  const { pathname } = url;
  const segments = pathname.split("/").filter(Boolean);

  if (req.method === "GET" && pathname === "/") {
    try {
      const html = readFileSync(join(publicDir, "index.html"), "utf-8");
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }

  if (req.method === "GET" && (pathname === "/gm" || pathname === "/player")) {
    const fileName = pathname === "/gm" ? "gm.html" : "player.html";
    try {
      const html = readFileSync(join(publicDir, fileName), "utf-8");
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }

  if (req.method === "GET" && segments[0] === "join" && segments.length === 2) {
    try {
      const html = readFileSync(join(publicDir, "player.html"), "utf-8");
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }

  if (req.method === "GET" && (pathname.startsWith("/dist/") || pathname.startsWith("/css/"))) {
    const filePath = join(publicDir, pathname);
    const file = Bun.file(filePath);
    return file.exists().then((exists) => {
      if (!exists) return new Response("Not Found", { status: 404 });
      return new Response(file);
    });
  }

  if (req.method === "GET" && pathname === "/api/health") {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method === "GET" && segments[0] === "uploads" && segments.length === 2) {
    const filename = segments[1];
    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      return new Response("Not Found", { status: 404 });
    }
    const file = Bun.file(join(uploadsDir, filename));
    return file.exists().then((exists) => {
      if (!exists) return new Response("Not Found", { status: 404 });
      return new Response(file);
    });
  }

  if (pathname.startsWith("/public/")) {
    const filePath = join(publicDir, pathname.replace("/public/", ""));
    try {
      const file = Bun.file(filePath);
      return new Response(file);
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }

  if (segments[0] === "api" && segments[1] === "adventures") {
    return handleAdventureRoutes(req, deps, segments);
  }

  return new Response("Not Found", { status: 404 });
}

async function handleAdventureRoutes(
  req: Request,
  deps: ServerDeps,
  segments: string[]
): Promise<Response> {
  const { db, uploadsDir } = deps;
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const error = (msg: string, status: number) => json({ error: msg }, status);

  // POST /api/adventures
  if (req.method === "POST" && segments.length === 2) {
    let body: { name?: unknown; gmPassword?: unknown };
    try {
      body = await req.json();
    } catch {
      return error("Invalid JSON", 400);
    }
    if (!body.name || typeof body.name !== "string" || body.name.trim() === "") {
      return error("name is required", 400);
    }
    if (
      !body.gmPassword ||
      typeof body.gmPassword !== "string" ||
      body.gmPassword.trim() === ""
    ) {
      return error("gmPassword is required", 400);
    }
    const adventure = createAdventure(db, {
      name: body.name.trim(),
      gmPassword: body.gmPassword,
    });
    return json(adventure, 201);
  }

  // GET /api/adventures/join/:playerLink
  if (req.method === "GET" && segments[2] === "join" && segments.length === 4) {
    const adventure = getAdventureByPlayerLink(db, segments[3]);
    if (!adventure) return error("Not found", 404);
    return json({
      id: adventure.id,
      name: adventure.name,
      activeImageId: adventure.active_image_id,
    });
  }

  // Routes with :id
  if (segments.length >= 3) {
    const id = segments[2];

    // GET /api/adventures/:id
    if (req.method === "GET" && segments.length === 3) {
      const adventure = getAdventure(db, id);
      if (!adventure) return error("Not found", 404);
      if (req.headers.get("X-GM-Password") !== adventure.gm_password)
        return error("Unauthorized", 401);
      return json(adventure);
    }

    // PUT /api/adventures/:id/active-image
    if (
      req.method === "PUT" &&
      segments[3] === "active-image" &&
      segments.length === 4
    ) {
      const adventure = getAdventure(db, id);
      if (!adventure) return error("Not found", 404);
      if (req.headers.get("X-GM-Password") !== adventure.gm_password)
        return error("Unauthorized", 401);

      let body: { imageId?: unknown };
      try {
        body = await req.json();
      } catch {
        return error("Invalid JSON", 400);
      }

      if (body.imageId === null) {
        db.run(`UPDATE adventures SET active_image_id = NULL WHERE id = ?`, [id]);
        return json(getAdventure(db, id));
      }
      if (!body.imageId || typeof body.imageId !== "string") {
        return error("imageId must be a string or null", 400);
      }
      try {
        setActiveImage(db, id, body.imageId);
      } catch {
        return error("Image does not belong to this adventure", 400);
      }
      return json(getAdventure(db, id));
    }

    // POST /api/adventures/:id/images
    if (
      req.method === "POST" &&
      segments[3] === "images" &&
      segments.length === 4
    ) {
      const adventure = getAdventure(db, id);
      if (!adventure) return error("Not found", 404);
      if (req.headers.get("X-GM-Password") !== adventure.gm_password)
        return error("Unauthorized", 401);

      let formData: FormData;
      try {
        formData = await req.formData();
      } catch {
        return error("Invalid form data", 400);
      }

      const file = formData.get("file");
      if (!file || !(file instanceof File)) return error("file is required", 400);
      if (!file.type.startsWith("image/")) return error("file must be an image", 400);

      const rawExt = file.name.split(".").pop() ?? "bin";
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "").substring(0, 10) || "bin";
      const filename = `${crypto.randomUUID()}.${ext}`;
      const filePath = join(uploadsDir, filename);

      const buffer = await file.arrayBuffer();
      const buf = Buffer.from(buffer);
      writeFileSync(filePath, buf);

      const { width, height } = parseImageDimensions(buf);

      // A new page lands on the board at a free spot, ready to be dragged where it belongs —
      // never on top of one that is already there.
      const existing = getImagesByAdventure(db, id).map((img) => ({
        x: img.board_x ?? 0,
        y: img.board_y ?? 0,
        width: img.width,
        height: img.height,
      }));
      const spot = nextFreeSpot(existing, width, height);

      const imageRecord = createImageRecord(db, {
        adventureId: id,
        filename,
        originalName: file.name,
        width,
        height,
        boardX: spot.x,
        boardY: spot.y,
      });
      return json(imageRecord, 201);
    }

    // GET /api/adventures/:id/images
    if (
      req.method === "GET" &&
      segments[3] === "images" &&
      segments.length === 4
    ) {
      const adventure = getAdventure(db, id);
      if (!adventure) return error("Not found", 404);

      const gmPassword = req.headers.get("X-GM-Password");
      const playerLink = req.headers.get("X-Player-Link");

      let isGm = true;
      if (gmPassword !== adventure.gm_password) {
        if (!playerLink) return error("Unauthorized", 401);
        const linked = getAdventureByPlayerLink(db, playerLink);
        if (!linked || linked.id !== id) return error("Unauthorized", 401);
        isGm = false;
      }

      const images = getImagesByAdventure(db, id);
      if (isGm) return json(images);

      // The WebSocket path is careful never to publish a start point — "players must never learn
      // where the party will appear" — and this route was handing them every one over REST. The
      // client reads none of these fields (#57).
      return json(
        images.map(({ start_x, start_y, start_locked, ...rest }) => rest)
      );
    }

    // DELETE /api/adventures/:id/images/:imageId
    if (
      req.method === "DELETE" &&
      segments[3] === "images" &&
      segments.length === 5
    ) {
      const imageId = segments[4];
      const adventure = getAdventure(db, id);
      if (!adventure) return error("Not found", 404);
      if (req.headers.get("X-GM-Password") !== adventure.gm_password)
        return error("Unauthorized", 401);

      const image = getImage(db, imageId);
      if (!image || image.adventure_id !== id) return error("Not found", 404);

      // The page the party is looking at is not deletable; it comes off the table first. Enforced
      // here rather than by the menu, because a second GM tab with a stale board must not be able
      // to delete the page on screen (principle 1).
      if (adventure.active_image_id === imageId) {
        return error("This page is on the table — take it off first", 409);
      }

      // Rows before files, in one transaction. The previous order unlinked the image and *then*
      // deleted the row, so a page with monsters on it — or the presented one — left an orphaned
      // record pointing at a file that was already gone (#3). Monsters belong to this page and go
      // with it; `token_positions` cascades on its own.
      try {
        db.transaction(() => {
          deleteTokensByImage(db, imageId);
          deleteImage(db, imageId);
        })();
      } catch (err) {
        console.error("Could not delete the page", err);
        return error("Could not delete this page", 500);
      }

      // Only now, with the database committed: a failed delete leaves the file intact.
      try {
        unlinkSync(join(uploadsDir, image.filename));
      } catch {
        // file may already be gone
      }
      // Drop the cached mask and its pending save, or a deleted map would keep
      // its fog resident until the adventure idles out.
      await deps.fog.forAdventure(id).evict(imageId);
      return new Response(null, { status: 204 });
    }

    // PUT /api/adventures/:id/images/:imageId/position
    // Board layout is REST, not WebSocket: players never see the board and the GM is the only
    // writer, so nothing here belongs on the wire (#48).
    if (
      req.method === "PUT" &&
      segments[3] === "images" &&
      segments[5] === "position" &&
      segments.length === 6
    ) {
      const adventure = getAdventure(db, id);
      if (!adventure) return error("Not found", 404);
      if (req.headers.get("X-GM-Password") !== adventure.gm_password)
        return error("Unauthorized", 401);

      const image = getImage(db, segments[4]);
      if (!image || image.adventure_id !== id) return error("Not found", 404);

      let body: { x?: unknown; y?: unknown };
      try {
        body = await req.json();
      } catch {
        return error("Invalid JSON", 400);
      }
      if (
        typeof body.x !== "number" ||
        typeof body.y !== "number" ||
        !Number.isFinite(body.x) ||
        !Number.isFinite(body.y)
      ) {
        return error("x and y must be finite numbers", 400);
      }

      setBoardPosition(db, image.id, body.x, body.y);
      return json({ id: image.id, board_x: body.x, board_y: body.y });
    }

    // GET /api/adventures/:id/images/:imageId/fog
    // Lets the board show a page's fog once the GM selects it.
    //
    // Reads through the fog registry rather than the stored blob, because #51 lets the GM paint a
    // page the party is not looking at: a resident mask can be up to the save debounce ahead of
    // `images.fog_mask`, and the board would show the GM their own work rolled back.
    //
    // `peek` never *loads* a mask — a page with no live session has nothing ahead of the blob,
    // since both eviction and idle disposal flush first. So browsing the board still makes nothing
    // resident, which is what principle 8 asks of this route.
    if (
      req.method === "GET" &&
      segments[3] === "images" &&
      segments[5] === "fog" &&
      segments.length === 6
    ) {
      const adventure = getAdventure(db, id);
      if (!adventure) return error("Not found", 404);
      if (req.headers.get("X-GM-Password") !== adventure.gm_password)
        return error("Unauthorized", 401);

      const image = getImage(db, segments[4]);
      if (!image || image.adventure_id !== id) return error("Not found", 404);

      // Same encoding either way: the blob is byte-for-byte what `toBase64()` produces
      // (`fog/serialize.ts`).
      const session = deps.fog.forAdventure(id).peek(image.id);
      const fogMask = session
        ? await session.toBase64()
        : image.fog_mask
          ? Buffer.from(image.fog_mask).toString("base64")
          : null;
      return json({ fogMask });
    }

    // GET /api/adventures/:id/images/:imageId/tokens
    // The monsters and NPCs standing on one page. GM only.
    //
    // REST for the same reason the board is: the wire only ever carries the presented page's GM
    // tokens (`joined`, `map:switched`), and a page in preparation reaches nobody by design. This
    // is the read that lets the GM see what they already placed there (#51).
    //
    // Player tokens are deliberately absent. They belong to the adventure and stand on whatever is
    // presented — the party is not on a page the GM is preparing.
    if (
      req.method === "GET" &&
      segments[3] === "images" &&
      segments[5] === "tokens" &&
      segments.length === 6
    ) {
      const adventure = getAdventure(db, id);
      if (!adventure) return error("Not found", 404);
      if (req.headers.get("X-GM-Password") !== adventure.gm_password)
        return error("Unauthorized", 401);

      const image = getImage(db, segments[4]);
      if (!image || image.adventure_id !== id) return error("Not found", 404);

      return json(getGmTokensByImage(db, id, image.id));
    }
  }

  return new Response("Not Found", { status: 404 });
}
