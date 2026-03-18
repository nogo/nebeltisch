import type { Database } from "bun:sqlite";
import type { Server, ServerWebSocket } from "bun";
import type { WsData, FogMask } from "../types";
import { getAdventure, getAdventureByPlayerLink, setActiveImage } from "../db/adventures";
import { getImage } from "../db/images";
import { createToken, getTokensByAdventure, updateTokenPosition, deleteToken } from "../db/tokens";
import { createMask, applyStroke, applyStrokes } from "../fog/mask";
import { serializeMask, saveFogMask, loadFogMask } from "../fog/serialize";
import {
  registerConnection,
  unregisterConnection,
  getConnection,
} from "./connections";
import { parseMessage, serializeMessage } from "./messages";

// ---- Fog mask in-memory cache ----

const fogMaskCache = new Map<string, FogMask>(); // keyed by imageId
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function getFogMaskForImage(db: Database, imageId: string): Promise<FogMask> {
  if (fogMaskCache.has(imageId)) return fogMaskCache.get(imageId)!;
  const loaded = await loadFogMask(db, imageId);
  if (loaded) {
    fogMaskCache.set(imageId, loaded);
    return loaded;
  }
  const image = getImage(db, imageId);
  if (!image) throw new Error(`Image ${imageId} not found`);
  const mask = createMask(image.width, image.height);
  fogMaskCache.set(imageId, mask);
  return mask;
}

function scheduleSave(db: Database, imageId: string): void {
  const existing = saveTimers.get(imageId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    saveTimers.delete(imageId);
    const mask = fogMaskCache.get(imageId);
    if (mask) await saveFogMask(db, imageId, mask);
  }, 1000);
  saveTimers.set(imageId, timer);
}

async function maskToBase64(mask: FogMask): Promise<string> {
  const buf = await serializeMask(mask);
  return buf.toString("base64");
}

// ---- WebSocket upgrade (called from fetch handler) ----

export function handleWsUpgrade(
  req: Request,
  db: Database,
  server: Server
): Response | undefined {
  const url = new URL(req.url);
  const adventureId = url.searchParams.get("adventureId");
  const role = url.searchParams.get("role") as "gm" | "player" | null;
  const password = url.searchParams.get("password");
  const playerLink = url.searchParams.get("playerLink");
  const playerName = url.searchParams.get("playerName");
  const playerColor = url.searchParams.get("playerColor");

  if (!adventureId || !role) {
    return new Response("adventureId and role are required", { status: 400 });
  }
  if (role !== "gm" && role !== "player") {
    return new Response("role must be gm or player", { status: 400 });
  }

  const adventure = getAdventure(db, adventureId);
  if (!adventure) {
    return new Response("Adventure not found", { status: 404 });
  }

  let tokenId: string | undefined;

  if (role === "gm") {
    if (!password || password !== adventure.gm_password) {
      return new Response("Invalid password", { status: 401 });
    }
  } else {
    if (!playerLink) {
      return new Response("playerLink is required for players", { status: 400 });
    }
    const linked = getAdventureByPlayerLink(db, playerLink);
    if (!linked || linked.id !== adventureId) {
      return new Response("Invalid player link", { status: 401 });
    }
    if (!playerName || !playerColor) {
      return new Response("playerName and playerColor are required", { status: 400 });
    }
    const token = createToken(db, { adventureId, name: playerName, color: playerColor });
    tokenId = token.id;
  }

  const wsData: WsData = {
    adventureId,
    role,
    playerName: playerName ?? undefined,
    playerColor: playerColor ?? undefined,
    tokenId,
  };

  const upgraded = server.upgrade(req, { data: wsData });
  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 });
  }
  // Return undefined so Bun completes the WebSocket handshake
  return undefined;
}

// ---- WebSocket handlers ----

export function createWsHandlers(db: Database) {
  return {
    async open(ws: ServerWebSocket<WsData>) {
      const { adventureId, role, playerName, playerColor, tokenId } = ws.data;
      registerConnection(ws, { adventureId, role, playerName, playerColor, tokenId });

      const adventure = getAdventure(db, adventureId)!;
      const tokens = getTokensByAdventure(db, adventureId);

      let fogMask: string | null = null;
      if (adventure.active_image_id) {
        try {
          const mask = await getFogMaskForImage(db, adventure.active_image_id);
          fogMask = await maskToBase64(mask);
        } catch {
          fogMask = null;
        }
      }

      ws.send(
        serializeMessage({
          type: "joined",
          adventure: {
            id: adventure.id,
            name: adventure.name,
            activeImageId: adventure.active_image_id,
          },
          tokens,
          fogMask,
        })
      );

      if (role === "player" && playerName && playerColor) {
        ws.publish(
          `adventure:${adventureId}`,
          serializeMessage({ type: "player:joined", playerName, playerColor })
        );
        if (tokenId) {
          const token = tokens.find((t) => t.id === tokenId);
          if (token) {
            ws.publish(
              `adventure:${adventureId}`,
              serializeMessage({ type: "token:added", token })
            );
          }
        }
      }
    },

    async message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
      const conn = getConnection(ws);
      if (!conn) return;

      const msg = parseMessage(typeof raw === "string" ? raw : raw.toString());
      if (!msg) {
        ws.send(serializeMessage({ type: "error", message: "Invalid message format" }));
        return;
      }

      const { adventureId } = conn;
      const topic = `adventure:${adventureId}`;

      switch (msg.type) {
        case "join": {
          ws.send(serializeMessage({ type: "error", message: "Already joined" }));
          break;
        }

        case "fog:stroke": {
          if (conn.role !== "gm") {
            ws.send(serializeMessage({ type: "error", message: "Only GM can send fog strokes" }));
            break;
          }
          const adv = getAdventure(db, adventureId);
          if (!adv?.active_image_id) {
            ws.send(serializeMessage({ type: "error", message: "No active image" }));
            break;
          }
          const imageId = adv.active_image_id;
          const mask = await getFogMaskForImage(db, imageId);
          applyStroke(mask, msg.stroke);
          scheduleSave(db, imageId);
          ws.publish(topic, serializeMessage({ type: "fog:stroke", stroke: msg.stroke, imageId }));
          break;
        }

        case "fog:stroke:batch": {
          if (conn.role !== "gm") {
            ws.send(serializeMessage({ type: "error", message: "Only GM can send fog strokes" }));
            break;
          }
          const adv = getAdventure(db, adventureId);
          if (!adv?.active_image_id) {
            ws.send(serializeMessage({ type: "error", message: "No active image" }));
            break;
          }
          const imageId = adv.active_image_id;
          const mask = await getFogMaskForImage(db, imageId);
          applyStrokes(mask, msg.strokes);
          scheduleSave(db, imageId);
          ws.publish(topic, serializeMessage({ type: "fog:stroke:batch", strokes: msg.strokes, imageId }));
          break;
        }

        case "token:move": {
          if (!conn.tokenId || conn.tokenId !== msg.tokenId) {
            ws.send(serializeMessage({ type: "error", message: "You do not own this token" }));
            break;
          }
          updateTokenPosition(db, msg.tokenId, msg.x, msg.y);
          const moved = serializeMessage({
            type: "token:moved",
            tokenId: msg.tokenId,
            x: msg.x,
            y: msg.y,
          });
          ws.send(moved);
          ws.publish(topic, moved);
          break;
        }

        case "map:switch": {
          if (conn.role !== "gm") {
            ws.send(serializeMessage({ type: "error", message: "Only GM can switch maps" }));
            break;
          }
          try {
            setActiveImage(db, adventureId, msg.imageId);
          } catch {
            ws.send(serializeMessage({ type: "error", message: "Invalid image" }));
            break;
          }
          let fogMask: string | null = null;
          try {
            const mask = await getFogMaskForImage(db, msg.imageId);
            fogMask = await maskToBase64(mask);
          } catch {
            fogMask = null;
          }
          const switched = serializeMessage({
            type: "map:switched",
            imageId: msg.imageId,
            fogMask,
          });
          ws.send(switched);
          ws.publish(topic, switched);
          break;
        }

        case "ping": {
          ws.send(serializeMessage({ type: "pong" }));
          break;
        }

        default: {
          ws.send(serializeMessage({ type: "error", message: "Unknown message type" }));
        }
      }
    },

    close(ws: ServerWebSocket<WsData>) {
      const info = unregisterConnection(ws);
      if (!info) return;

      const topic = `adventure:${info.adventureId}`;

      if (info.role === "player" && info.tokenId) {
        deleteToken(db, info.tokenId);
        ws.publish(topic, serializeMessage({ type: "token:removed", tokenId: info.tokenId }));
      }

      if (info.playerName) {
        ws.publish(topic, serializeMessage({ type: "player:left", playerName: info.playerName }));
      }
    },
  };
}
