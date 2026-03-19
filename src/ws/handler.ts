import type { Database } from "bun:sqlite";
import type { Server, ServerWebSocket } from "bun";
import type { WsData, FogMask, Token } from "../types";
import { getAdventure, getAdventureByPlayerLink, setActiveImage } from "../db/adventures";
import { getImage } from "../db/images";
import { repairImageDimensions } from "../routes";
import { findOrCreateToken, createToken, getTokensByAdventure, updateTokenPosition, deleteToken } from "../db/tokens";
import { createMask, applyStroke, applyStrokes } from "../fog/mask";
import { serializeMask, saveFogMask, loadFogMask } from "../fog/serialize";
import {
  registerConnection,
  unregisterConnection,
  getConnection,
  getConnectionsForAdventure,
  getWsForToken,
  getGmWsForAdventure,
} from "./connections";
import { parseMessage, serializeMessage } from "./messages";

// ---- Fog mask in-memory cache ----

const fogMaskCache = new Map<string, FogMask>(); // keyed by imageId
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function getFogMaskForImage(db: Database, imageId: string, uploadsDir?: string): Promise<FogMask> {
  if (fogMaskCache.has(imageId)) return fogMaskCache.get(imageId)!;
  const loaded = await loadFogMask(db, imageId);
  if (loaded) {
    fogMaskCache.set(imageId, loaded);
    return loaded;
  }
  let image = getImage(db, imageId);
  if (!image) throw new Error(`Image ${imageId} not found`);
  if ((image.width === 0 || image.height === 0) && uploadsDir) {
    repairImageDimensions(db, imageId, uploadsDir);
    image = getImage(db, imageId) ?? image;
  }
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
  }, 500);
  saveTimers.set(imageId, timer);
}

export async function flushAllFogCaches(db: Database): Promise<void> {
  for (const timer of saveTimers.values()) clearTimeout(timer);
  saveTimers.clear();
  for (const [imageId, mask] of fogMaskCache) {
    await saveFogMask(db, imageId, mask);
  }
}

async function maskToBase64(mask: FogMask): Promise<string> {
  const buf = await serializeMask(mask);
  return buf.toString("base64");
}

// ---- Roster helpers ----

function buildRoster(
  db: Database,
  adventureId: string
): Array<{ tokenId: string; name: string; color: string; online: boolean }> {
  const tokens = getTokensByAdventure(db, adventureId);
  const conns = getConnectionsForAdventure(adventureId);
  const onlineTokenIds = new Set(conns.map((c) => c.tokenId).filter(Boolean));
  return tokens
    .filter((t) => t.player_link !== null)
    .map((t) => ({
      tokenId: t.id,
      name: t.name,
      color: t.color,
      online: onlineTokenIds.has(t.id),
    }));
}

function sendRosterToGm(db: Database, adventureId: string): void {
  const gmWs = getGmWsForAdventure(adventureId);
  if (!gmWs) return;
  gmWs.send(
    serializeMessage({ type: "player:roster", players: buildRoster(db, adventureId) })
  );
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
  let resolvedPlayerLink: string | undefined;
  let tokenIsNew: boolean | undefined;

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
    // Identity key: adventure invite link + player name.
    // Same bookmark URL (same name) → same token. Different name → different token.
    const playerIdentity = `${playerLink}|${playerName}`;
    const { token, isNew } = findOrCreateToken(db, {
      adventureId,
      playerLink: playerIdentity,
      name: playerName,
      color: playerColor,
    });
    tokenId = token.id;
    resolvedPlayerLink = playerLink;
    tokenIsNew = isNew;
  }

  const wsData: WsData = {
    adventureId,
    role,
    playerName: playerName ?? undefined,
    playerColor: playerColor ?? undefined,
    tokenId,
    playerLink: resolvedPlayerLink,
    tokenIsNew,
  };

  const upgraded = server.upgrade(req, { data: wsData });
  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 });
  }
  // Return undefined so Bun completes the WebSocket handshake
  return undefined;
}

// ---- WebSocket handlers ----

export function createWsHandlers(db: Database, uploadsDir?: string) {
  return {
    async open(ws: ServerWebSocket<WsData>) {
      const { adventureId, role, playerName, playerColor, tokenId, playerLink, tokenIsNew } = ws.data;
      registerConnection(ws, { adventureId, role, playerName, playerColor, tokenId, playerLink });

      const adventure = getAdventure(db, adventureId)!;
      const tokens = getTokensByAdventure(db, adventureId);

      let fogMask: string | null = null;
      if (adventure.active_image_id) {
        try {
          const mask = await getFogMaskForImage(db, adventure.active_image_id, uploadsDir);
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
          yourTokenId: tokenId,
        })
      );

      if (role === "gm") {
        // Send roster immediately so GM sees current player status
        ws.send(
          serializeMessage({ type: "player:roster", players: buildRoster(db, adventureId) })
        );
      }

      if (role === "player" && playerName && playerColor) {
        ws.publish(
          `adventure:${adventureId}`,
          serializeMessage({ type: "player:joined", playerName, playerColor })
        );

        if (tokenId && tokenIsNew) {
          // Newly created token — tell other clients to add it
          const newToken = tokens.find((t) => t.id === tokenId);
          if (newToken) {
            ws.publish(
              `adventure:${adventureId}`,
              serializeMessage({ type: "token:added", token: newToken })
            );
          }
        }
        // If reconnecting (tokenIsNew === false), token is already in other clients' state

        // Update GM roster to show this player as online
        sendRosterToGm(db, adventureId);
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
          const mask = await getFogMaskForImage(db, imageId, uploadsDir);
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
          const mask = await getFogMaskForImage(db, imageId, uploadsDir);
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
            const mask = await getFogMaskForImage(db, msg.imageId, uploadsDir);
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

        case "player:remove": {
          if (conn.role !== "gm") {
            ws.send(serializeMessage({ type: "error", message: "Only GM can remove players" }));
            break;
          }
          const tokens = getTokensByAdventure(db, adventureId);
          const target = tokens.find((t) => t.id === msg.tokenId);
          if (!target) {
            ws.send(serializeMessage({ type: "error", message: "Token not found" }));
            break;
          }

          // Notify the player they've been removed (if connected), then close their WS
          const playerWs = getWsForToken(adventureId, msg.tokenId);
          if (playerWs) {
            playerWs.send(serializeMessage({ type: "player:removed" }));
            playerWs.close(4000, "removed");
          }

          deleteToken(db, msg.tokenId);
          ws.publish(topic, serializeMessage({ type: "token:removed", tokenId: msg.tokenId }));

          // Send updated roster after deletion
          sendRosterToGm(db, adventureId);
          break;
        }

        case "fog:undo": {
          if (conn.role !== "gm") {
            ws.send(serializeMessage({ type: "error", message: "Only GM can undo fog strokes" }));
            break;
          }
          const adv = getAdventure(db, adventureId);
          if (!adv?.active_image_id) {
            ws.send(serializeMessage({ type: "error", message: "No active image" }));
            break;
          }
          const imageId = adv.active_image_id;
          let image = getImage(db, imageId);
          if (!image) {
            ws.send(serializeMessage({ type: "error", message: "Image not found" }));
            break;
          }
          if ((image.width === 0 || image.height === 0) && uploadsDir) {
            repairImageDimensions(db, imageId, uploadsDir);
            image = getImage(db, imageId) ?? image;
          }
          const freshMask = createMask(image.width, image.height);
          applyStrokes(freshMask, msg.strokes);
          fogMaskCache.set(imageId, freshMask);
          scheduleSave(db, imageId);
          const fogMaskBase64 = await maskToBase64(freshMask);
          const resetMsg = serializeMessage({ type: "fog:reset", imageId, fogMask: fogMaskBase64 });
          ws.send(resetMsg);
          ws.publish(topic, resetMsg);
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

      if (info.role === "gm") {
        // Flush any pending fog saves immediately on GM disconnect
        for (const [imageId, timer] of saveTimers) {
          clearTimeout(timer);
          saveTimers.delete(imageId);
          const mask = fogMaskCache.get(imageId);
          if (mask) saveFogMask(db, imageId, mask).catch(() => {});
        }
      }

      const topic = `adventure:${info.adventureId}`;

      // Token persists on disconnect — do NOT delete it
      if (info.playerName) {
        ws.publish(topic, serializeMessage({ type: "player:left", playerName: info.playerName }));
      }

      if (info.role === "player") {
        // Update GM roster to show this player as offline
        sendRosterToGm(db, info.adventureId);
      }
    },
  };
}
