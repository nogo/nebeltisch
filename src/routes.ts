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
} from "./db/images";

const publicDir = join(import.meta.dir, "..", "public");

function parseImageDimensions(buf: Buffer): { width: number; height: number } {
  // PNG: bytes 0-7 = signature, 8-15 = IHDR length+type, 16-19 = width, 20-23 = height
  if (buf.length >= 24 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  }
  // JPEG: scan for SOF0/SOF2 markers (0xFF 0xC0 or 0xFF 0xC2)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xc0 || marker === 0xc2) {
        return {
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
        };
      }
      // Skip to next marker
      const segLen = buf.readUInt16BE(i + 2);
      i += 2 + segLen;
    }
  }
  // WebP: RIFF header, bytes 24-27 = width (LE 14 bits), 26-29 = height (LE 14 bits) for VP8
  // Simplified: just return 0 for unsupported formats
  return { width: 0, height: 0 };
}

export function handleRequest(
  req: Request,
  db?: Database,
  uploadsDir: string = "./data/uploads/"
): Promise<Response> | Response {
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

  if (segments[0] === "api" && segments[1] === "adventures" && db) {
    return handleAdventureRoutes(req, db, uploadsDir, segments);
  }

  return new Response("Not Found", { status: 404 });
}

async function handleAdventureRoutes(
  req: Request,
  db: Database,
  uploadsDir: string,
  segments: string[]
): Promise<Response> {
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

      const imageRecord = createImageRecord(db, {
        adventureId: id,
        filename,
        originalName: file.name,
        width,
        height,
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

      if (gmPassword !== adventure.gm_password) {
        if (!playerLink) return error("Unauthorized", 401);
        const linked = getAdventureByPlayerLink(db, playerLink);
        if (!linked || linked.id !== id) return error("Unauthorized", 401);
      }

      return json(getImagesByAdventure(db, id));
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
      return new Response(null, { status: 204 });
    }
  }

  return new Response("Not Found", { status: 404 });
}
