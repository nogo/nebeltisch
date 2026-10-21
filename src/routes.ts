import { readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import {
  addGm,
  createAdventure,
  deleteAdventure,
  getAdventure,
  getAdventureByPlayerLink,
  getAdventuresOfGm,
  getGms,
  isGm,
  removeGm,
  renameAdventure,
  setActiveImage,
} from "./db/adventures";
import { getUserByName } from "./db/users";
import { closeAdventureFor } from "./ws/handler";
import {
  createImageRecord,
  getImagesByAdventure,
  getImage,
  deleteImage,
  setBoardPosition,
} from "./db/images";
import { getGmTokensByImage, deleteTokensByImage } from "./db/tokens";
import { handleAuthRoutes } from "./auth/routes";
import { currentUser, fromOwnSite } from "./auth/session";
import { nextFreeSpot } from "./board";
import { fitsInMask, parseImageDimensions } from "./images";
import type { ServerDeps } from "./deps";

const publicDir = join(import.meta.dir, "..", "public");

/**
 * Uploaded pages, served by Bun rather than by hand.
 *
 * A page is megabytes and the hand-written version sent no validator with it, so every
 * reload refetched the whole map. This sends `ETag` and `Last-Modified` and answers a
 * conditional request with `304`, and it refuses a non-canonical path before it reaches
 * the filesystem — which is what the manual `..` check it replaced was for.
 *
 * `/dist/` stays in `handleRequest` deliberately: it is build output, and `Bun.serve`
 * throws at startup when a `dir` route points at a directory that does not exist yet.
 */
export function staticRoutes(uploadsDir: string) {
  return { "/uploads/*": { dir: uploadsDir } };
}

export function handleRequest(
  req: Request,
  deps: ServerDeps
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

  // A write from a page on another site is refused before any route sees it (#56).
  if (segments[0] === "api" && req.method !== "GET" && req.method !== "HEAD" && !fromOwnSite(req, deps)) {
    return new Response(JSON.stringify({ error: "Cross-site request refused" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (segments[0] === "api" && segments[1] === "auth") {
    return handleAuthRoutes(req, deps, segments);
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

  const user = currentUser(req, db);

  /**
   * The adventure, when the signed-in account is one of its GMs; otherwise the refusal to send.
   * The session is the only GM credential (#56), and every GM is equal (#77).
   */
  const asGm = (adventureId: string) => {
    if (!user) return error("Not signed in", 401);
    const adventure = getAdventure(db, adventureId);
    if (!adventure) return error("Not found", 404);
    if (!isGm(db, adventureId, user.id)) return error("This adventure is not yours", 403);
    return adventure;
  };

  // GET /api/adventures — the dashboard: what the signed-in account runs, and nothing else (#55)
  if (req.method === "GET" && segments.length === 2) {
    if (!user) return error("Not signed in", 401);
    return json(getAdventuresOfGm(db, user.id));
  }

  // POST /api/adventures — whoever creates it is its first GM
  if (req.method === "POST" && segments.length === 2) {
    if (!user) return error("Not signed in", 401);
    const body = await readJson<{ name?: unknown }>(req);
    if (!body) return error("Invalid JSON", 400);
    const name = adventureName(body.name);
    if (!name) return error(ADVENTURE_NAME_RULE, 400);
    const adventure = createAdventure(db, { name, gmId: user.id });
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
      const adventure = asGm(id);
      if (adventure instanceof Response) return adventure;
      return json(adventure);
    }

    // PATCH /api/adventures/:id — rename (#76)
    if (req.method === "PATCH" && segments.length === 3) {
      const adventure = asGm(id);
      if (adventure instanceof Response) return adventure;
      const body = await readJson<{ name?: unknown }>(req);
      if (!body) return error("Invalid JSON", 400);
      const name = adventureName(body.name);
      if (!name) return error(ADVENTURE_NAME_RULE, 400);
      renameAdventure(db, id, name);
      return json(getAdventure(db, id));
    }

    // DELETE /api/adventures/:id — for good, files included (#76)
    //
    // Rows first, in one transaction; files only once that has committed, so a failure leaves the
    // adventure whole rather than pointing at files that are gone — the order #3 settled for a page.
    if (req.method === "DELETE" && segments.length === 3) {
      const adventure = asGm(id);
      if (adventure instanceof Response) return adventure;
      const pages = getImagesByAdventure(db, id);
      try {
        deleteAdventure(db, id);
      } catch (err) {
        console.error("Could not delete the adventure", err);
        return error("Could not delete this adventure", 500);
      }
      closeAdventureFor(id, "deleted");
      for (const page of pages) {
        try {
          unlinkSync(join(uploadsDir, page.filename));
        } catch {
          // file may already be gone
        }
      }
      // Drop the resident masks now rather than at idle; any save still pending lands on rows that
      // are already gone, which changes nothing.
      await deps.fog.forAdventure(id).dispose();
      return new Response(null, { status: 204 });
    }

    // POST /api/adventures/:id/gms — share with another account, by name (#77)
    if (req.method === "POST" && segments[3] === "gms" && segments.length === 4) {
      const adventure = asGm(id);
      if (adventure instanceof Response) return adventure;
      const body = await readJson<{ name?: unknown }>(req);
      if (!body) return error("Invalid JSON", 400);
      const other = typeof body.name === "string" ? getUserByName(db, body.name.trim()) : null;
      if (!other) return error("No account has that name", 404);
      addGm(db, id, other.id);
      return json(getGms(db, id));
    }

    // DELETE /api/adventures/:id/gms/:userId — remove a GM, yourself included (#77)
    if (req.method === "DELETE" && segments[3] === "gms" && segments.length === 5) {
      const adventure = asGm(id);
      if (adventure instanceof Response) return adventure;
      const gms = getGms(db, id);
      if (!gms.some((gm) => gm.id === segments[4])) return error("Not a GM of this adventure", 404);
      // An adventure always has a GM: the last one deletes it instead of leaving it to nobody.
      if (gms.length === 1) return error("You are its only GM — delete it instead", 409);
      removeGm(db, id, segments[4]);
      closeAdventureFor(id, "unshared", segments[4]);
      return json(getGms(db, id));
    }

    // PUT /api/adventures/:id/active-image
    if (
      req.method === "PUT" &&
      segments[3] === "active-image" &&
      segments.length === 4
    ) {
      const adventure = asGm(id);
      if (adventure instanceof Response) return adventure;

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
      const adventure = asGm(id);
      if (adventure instanceof Response) return adventure;

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
      const { width, height } = parseImageDimensions(buf);
      if (!fitsInMask(width, height)) {
        return error("This page is too large — keep it under 25 megapixels", 413);
      }
      writeFileSync(filePath, buf);

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

      const playerLink = req.headers.get("X-Player-Link");

      let forGm = true;
      if (!user || !isGm(db, id, user.id)) {
        if (!playerLink) return error("Not signed in", 401);
        const linked = getAdventureByPlayerLink(db, playerLink);
        if (!linked || linked.id !== id) return error("Unauthorized", 401);
        forGm = false;
      }

      const images = getImagesByAdventure(db, id);
      if (forGm) return json(images);

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
      const adventure = asGm(id);
      if (adventure instanceof Response) return adventure;

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
      const adventure = asGm(id);
      if (adventure instanceof Response) return adventure;

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
      const adventure = asGm(id);
      if (adventure instanceof Response) return adventure;

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
      const adventure = asGm(id);
      if (adventure instanceof Response) return adventure;

      const image = getImage(db, segments[4]);
      if (!image || image.adventure_id !== id) return error("Not found", 404);

      return json(getGmTokensByImage(db, id, image.id));
    }
  }

  return new Response("Not Found", { status: 404 });
}

const ADVENTURE_NAME_MAX = 80;
const ADVENTURE_NAME_RULE = `A name needs 1 to ${ADVENTURE_NAME_MAX} characters`;

/** The trimmed name, or null when it cannot be one. */
function adventureName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed !== "" && trimmed.length <= ADVENTURE_NAME_MAX ? trimmed : null;
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as T) : null;
  } catch {
    return null;
  }
}
