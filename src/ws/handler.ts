import type { Database } from "bun:sqlite";
import type { Server, ServerWebSocket } from "bun";
import type { WsData, Token } from "../types";
import type { ServerDeps } from "../deps";
import type { FogSession } from "../fog/session";
import { getAdventure, getAdventureByPlayerLink, setActiveImage, setTokenSize } from "../db/adventures";
import { getImage, setStartPoint } from "../db/images";
import { repairImageDimensions } from "../images";
import { findOrCreateToken, createToken, getTokensByAdventure, getPlayerTokensByAdventure, getGmTokensByImage, updateTokenPosition, rememberTokenPosition, getRememberedPositions, clearRememberedPositions, deleteToken } from "../db/tokens";
import {
  registerConnection,
  unregisterConnection,
  getConnection,
  getConnectionsForAdventure,
  getWsForToken,
  getGmWsForAdventure,
} from "./connections";
import { parseMessage, serializeMessage } from "./messages";

// ---- Spawn position ----

/**
 * Where a newly joined player appears: the active map's start point, offset so
 * successive arrivals do not stack. Falls back to the map centre when no start
 * point is set, and to the old near-the-party spawn when no map is active.
 */
function placeArrivingToken(
  db: Database,
  adventure: { active_image_id: string | null; token_size?: number },
  existingCount: number
): { x: number; y: number } {
  if (adventure.active_image_id) {
    const img = getImage(db, adventure.active_image_id);
    if (img && img.width > 0 && img.height > 0) {
      const tokenSize = adventure.token_size ?? 20;
      const ring = scatterPositions(
        existingCount + 1,
        img.start_x ?? img.width / 2,
        img.start_y ?? img.height / 2,
        img.width,
        img.height,
        tokenSize
      );
      return ring[existingCount];
    }
  }
  return calcSpawnPosition([], adventure, db);
}

function calcSpawnPosition(
  existingTokens: Array<{ x: number; y: number }>,
  adventure: { active_image_id: string | null },
  db: Database
): { x: number; y: number } {
  // Base: average of existing player tokens, or image centre, or fallback
  let baseX = 100;
  let baseY = 100;

  if (existingTokens.length > 0) {
    baseX = existingTokens.reduce((s, t) => s + t.x, 0) / existingTokens.length;
    baseY = existingTokens.reduce((s, t) => s + t.y, 0) / existingTokens.length;
  } else if (adventure.active_image_id) {
    const img = getImage(db, adventure.active_image_id);
    if (img && img.width > 0 && img.height > 0) {
      baseX = img.width / 2;
      baseY = img.height / 2;
    }
  }

  // Small random offset so tokens don't stack on top of each other
  const angle = Math.random() * Math.PI * 2;
  const radius = 40 + Math.random() * 40;
  return {
    x: Math.round(baseX + Math.cos(angle) * radius),
    y: Math.round(baseY + Math.sin(angle) * radius),
  };
}

/**
 * Places `count` tokens around a target point without stacking them, clamped
 * inside the image so a switch to a smaller map can never strand a token
 * off-canvas where nobody can reach it.
 */
export function scatterPositions(
  count: number,
  cx: number,
  cy: number,
  width: number,
  height: number,
  tokenSize: number
): Array<{ x: number; y: number }> {
  const margin = Math.min(tokenSize, width / 2, height / 2);
  // Every token stands around the point, never on it, so the marker underneath
  // stays visible. The ring grows with the party so neighbours never overlap:
  // circumference / count must exceed a token's diameter plus a gap.
  const ring = tokenSize * Math.max(2.2, count * 0.45);
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i++) {
    // Start at the top and go clockwise — predictable, so the GM can learn it.
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    out.push({
      x: Math.round(Math.min(width - margin, Math.max(margin, cx + Math.cos(angle) * ring))),
      y: Math.round(Math.min(height - margin, Math.max(margin, cy + Math.sin(angle) * ring))),
    });
  }
  return out;
}

/** Radius the clients draw to show where the party will land. */
export function gatherRingRadius(count: number, tokenSize: number): number {
  return tokenSize * Math.max(2.2, Math.max(count, 1) * 0.45);
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
  { db }: ServerDeps,
  server: Server<WsData>
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

export function createWsHandlers(deps: ServerDeps) {
  const { db, uploadsDir } = deps;
  return {
    async open(ws: ServerWebSocket<WsData>) {
      const { adventureId, role, playerName, playerColor, tokenId, playerLink, tokenIsNew } = ws.data;
      registerConnection(ws, { adventureId, role, playerName, playerColor, tokenId, playerLink });

      const fog = deps.fog.forAdventure(adventureId);
      fog.retain();

      const adventure = getAdventure(db, adventureId)!;
      const playerTokens = getPlayerTokensByAdventure(db, adventureId);
      const gmTokens = adventure.active_image_id
        ? getGmTokensByImage(db, adventureId, adventure.active_image_id)
        : [];
      const tokens = [...playerTokens, ...gmTokens];

      let fogMask: string | null = null;
      if (adventure.active_image_id) {
        try {
          fogMask = await (await fog.open(adventure.active_image_id)).toBase64();
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
            tokenSize: adventure.token_size,
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
        if (adventure.active_image_id) {
          ws.send(
            serializeMessage({
              type: "fog:history",
              imageId: adventure.active_image_id,
              ...fog.historyState(adventure.active_image_id),
            })
          );
        }
      }

      if (role === "player" && playerName && playerColor) {
        ws.publish(
          `adventure:${adventureId}`,
          serializeMessage({ type: "player:joined", playerName, playerColor })
        );

        if (tokenId && tokenIsNew) {
          // Arrivals land on the map's start point, not beside the party, so a
          // latecomer walks in from the entrance instead of appearing mid-scene.
          const others = playerTokens.filter((t) => t.id !== tokenId).length;
          const spawnPos = placeArrivingToken(db, adventure, others);
          updateTokenPosition(db, tokenId, spawnPos.x, spawnPos.y);
          if (adventure.active_image_id) {
            rememberTokenPosition(db, tokenId, adventure.active_image_id, spawnPos.x, spawnPos.y);
          }

          // Broadcast with updated position
          const newToken = getTokensByAdventure(db, adventureId).find((t) => t.id === tokenId);
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
      const fog = deps.fog.forAdventure(adventureId);

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
          (await fog.open(imageId)).applyStrokes([msg.stroke]);
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
          (await fog.open(imageId)).applyStrokes(msg.strokes);
          ws.publish(topic, serializeMessage({ type: "fog:stroke:batch", strokes: msg.strokes, imageId }));
          break;
        }

        case "token:move": {
          if (conn.role !== "gm" && (!conn.tokenId || conn.tokenId !== msg.tokenId)) {
            ws.send(serializeMessage({ type: "error", message: "You do not own this token" }));
            break;
          }
          updateTokenPosition(db, msg.tokenId, msg.x, msg.y);
          // Remember it per map, so switching away and back restores the party.
          const activeImageId = getAdventure(db, adventureId)?.active_image_id;
          if (activeImageId) {
            rememberTokenPosition(db, msg.tokenId, activeImageId, msg.x, msg.y);
          }
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

        case "settings:update": {
          if (conn.role !== "gm") {
            ws.send(serializeMessage({ type: "error", message: "Only GM can change settings" }));
            break;
          }
          const newSize = Math.min(100, Math.max(5, Math.round(Number(msg.tokenSize) || 20)));
          setTokenSize(db, adventureId, newSize);
          const settingsMsg = serializeMessage({ type: "settings:updated", tokenSize: newSize });
          ws.send(settingsMsg);
          ws.publish(topic, settingsMsg);
          break;
        }

        case "map:switch": {
          if (conn.role !== "gm") {
            ws.send(serializeMessage({ type: "error", message: "Only GM can switch maps" }));
            break;
          }
          const prevImageId = getAdventure(db, adventureId)?.active_image_id ?? null;
          try {
            setActiveImage(db, adventureId, msg.imageId);
          } catch {
            ws.send(serializeMessage({ type: "error", message: "Invalid image" }));
            break;
          }

          // Move the party onto the new map. Player tokens are adventure-scoped,
          // so without this they keep coordinates from the previous map and can
          // land outside a smaller one, where nobody can select them.
          let playerTokens = getPlayerTokensByAdventure(db, adventureId);
          if (prevImageId !== msg.imageId && playerTokens.length > 0) {
            let image = getImage(db, msg.imageId);
            if (image && (image.width === 0 || image.height === 0) && uploadsDir) {
              repairImageDimensions(db, msg.imageId, uploadsDir);
              image = getImage(db, msg.imageId) ?? image;
            }
            if (image && image.width > 0 && image.height > 0) {
              const tokenSize = getAdventure(db, adventureId)?.token_size ?? 20;
              const remembered = getRememberedPositions(db, msg.imageId);
              // Only tokens that have never stood on this map get placed at the
              // start point; the rest return to where they last were.
              const arriving = playerTokens.filter((t) => !remembered.has(t.id));
              const positions = scatterPositions(
                arriving.length,
                image.start_x ?? image.width / 2,
                image.start_y ?? image.height / 2,
                image.width,
                image.height,
                tokenSize
              );
              const margin = Math.min(tokenSize, image.width / 2, image.height / 2);
              let arrivingIndex = 0;
              for (const t of playerTokens) {
                const previous = remembered.get(t.id);
                const pos = previous
                  ? {
                      // Only rescue positions outside the image. The player chose
                      // this spot and token:move does not clamp, so the margin
                      // applied to arrivals must not drag them off it.
                      x: Math.round(Math.min(image.width, Math.max(0, previous.x))),
                      y: Math.round(Math.min(image.height, Math.max(0, previous.y))),
                    }
                  : positions[arrivingIndex++];
                updateTokenPosition(db, t.id, pos.x, pos.y);
                rememberTokenPosition(db, t.id, msg.imageId, pos.x, pos.y);
              }
              playerTokens = getPlayerTokensByAdventure(db, adventureId);
            }
          }

          let fogMask: string | null = null;
          try {
            fogMask = await (await fog.open(msg.imageId)).toBase64();
          } catch {
            fogMask = null;
          }
          const newGmTokens = getGmTokensByImage(db, adventureId, msg.imageId);
          const switched = serializeMessage({
            type: "map:switched",
            imageId: msg.imageId,
            fogMask,
            gmTokens: newGmTokens,
            playerTokens,
          });
          ws.send(switched);
          ws.publish(topic, switched);
          ws.send(
            serializeMessage({
              type: "fog:history",
              imageId: msg.imageId,
              ...fog.historyState(msg.imageId),
            })
          );
          break;
        }

        case "map:start_point": {
          if (conn.role !== "gm") {
            ws.send(serializeMessage({ type: "error", message: "Only GM can set the start point" }));
            break;
          }
          const image = getImage(db, msg.imageId);
          if (!image || image.adventure_id !== adventureId) {
            ws.send(serializeMessage({ type: "error", message: "Image not found" }));
            break;
          }
          const clearing = msg.x === null || msg.y === null;
          const x = clearing ? null : Math.round(Math.min(image.width, Math.max(0, Number(msg.x) || 0)));
          const y = clearing ? null : Math.round(Math.min(image.height, Math.max(0, Number(msg.y) || 0)));
          setStartPoint(db, msg.imageId, x, y);
          if (!clearing) {
            // Declaring where arrival happens overrides positions recorded
            // earlier — typically while painting fog before the flag was set.
            clearRememberedPositions(db, msg.imageId);
          }
          // GM-only: players must never learn where the party will appear.
          ws.send(serializeMessage({ type: "map:start_point:set", imageId: msg.imageId, x, y }));
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

        case "fog:action:end": {
          if (conn.role !== "gm") break;
          const adv = getAdventure(db, adventureId);
          if (!adv?.active_image_id) break;
          const imageId = adv.active_image_id;
          const session = fog.peek(imageId);
          if (!session) break;
          session.commit();
          ws.send(serializeMessage({ type: "fog:history", imageId, ...fog.historyState(imageId) }));
          break;
        }

        case "fog:undo":
        case "fog:redo": {
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
          let session: FogSession;
          try {
            session = await fog.open(imageId);
          } catch {
            ws.send(serializeMessage({ type: "error", message: "Image not found" }));
            break;
          }

          // Nothing to step to — report the unchanged button state and stop.
          const stepped = msg.type === "fog:undo" ? session.undo() : session.redo();
          if (!stepped) {
            ws.send(serializeMessage({ type: "fog:history", imageId, ...fog.historyState(imageId) }));
            break;
          }

          const resetMsg = serializeMessage({
            type: "fog:reset",
            imageId,
            fogMask: await session.toBase64(),
          });
          ws.send(resetMsg);
          ws.publish(topic, resetMsg);
          ws.send(serializeMessage({ type: "fog:history", imageId, ...fog.historyState(imageId) }));
          break;
        }

        case "gm_token:place": {
          if (conn.role !== "gm") {
            ws.send(serializeMessage({ type: "error", message: "Only GM can place tokens" }));
            break;
          }
          const adv = getAdventure(db, adventureId);
          if (!adv?.active_image_id) {
            ws.send(serializeMessage({ type: "error", message: "No active map to place token on" }));
            break;
          }
          const tokenType = msg.tokenType === 'npc' ? 'npc' : 'monster';
          const color = tokenType === 'monster' ? '#c0392b' : '#7f8c9a';
          const placed = createToken(db, {
            adventureId,
            name: String(msg.name ?? 'Unknown').slice(0, 40),
            color,
            tokenType,
            x: Number(msg.x) || 0,
            y: Number(msg.y) || 0,
            imageId: adv.active_image_id,
          });
          const placedMsg = serializeMessage({ type: 'gm_token:added', token: placed });
          ws.send(placedMsg);
          ws.publish(topic, placedMsg);
          break;
        }

        case "gm_token:remove": {
          if (conn.role !== "gm") {
            ws.send(serializeMessage({ type: "error", message: "Only GM can remove GM tokens" }));
            break;
          }
          const allTokens = getTokensByAdventure(db, adventureId);
          const target = allTokens.find((t) => t.id === msg.tokenId);
          if (!target || target.token_type === 'player') {
            ws.send(serializeMessage({ type: "error", message: "GM token not found" }));
            break;
          }
          deleteToken(db, msg.tokenId);
          const removedMsg = serializeMessage({ type: "token:removed", tokenId: msg.tokenId });
          ws.send(removedMsg);
          ws.publish(topic, removedMsg);
          break;
        }

        case "ping": {
          ws.send(serializeMessage({ type: "pong" }));
          break;
        }

        case "ping:map": {
          const name = conn.role === "gm" ? "GM" : (conn.playerName ?? "Player");
          const pingBroadcast = serializeMessage({
            type: "ping:map",
            x: msg.x,
            y: msg.y,
            color: msg.color,
            name,
          });
          ws.send(pingBroadcast);
          ws.publish(topic, pingBroadcast);
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

      const fog = deps.fog.forAdventure(info.adventureId);
      if (info.role === "gm") {
        // Flush pending fog saves immediately on GM disconnect — for this
        // adventure only. It used to flush every adventure on the server (#9).
        fog.flush().catch(() => {});
      }
      // Masks stay resident for a grace period, so a page reload keeps its undo
      // history; see IDLE_DISPOSE_MS in fog/session.ts.
      fog.release();

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
