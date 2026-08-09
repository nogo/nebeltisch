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

      try {
        unlinkSync(join(uploadsDir, image.filename));
      } catch {
        // file may already be gone
      }
      deleteImage(db, imageId);
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
    // Lets the board show a page's stored fog once the GM zooms into it. Reads the stored blob
    // rather than opening a `FogSession`: the blob is byte-for-byte what `toBase64()` produces
    // (`fog/serialize.ts`), and opening a session per page the GM looks at would make every mask in
    // the adventure resident at once, which principle 8 forbids.
    //
    // The blob is authoritative only because nothing writes fog to a page that is not presented.
    // #51 changes that — when it lands, this must read through `deps.fog` instead.
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

      const fogMask = image.fog_mask
        ? Buffer.from(image.fog_mask).toString("base64")
        : null;
      return json({ fogMask });
    }
  }

  return new Response("Not Found", { status: 404 });
}
