import type { Database } from "bun:sqlite";
import type { Server, ServerWebSocket } from "bun";
import type { WsData, Token } from "../types";
import type { ServerDeps } from "../deps";
import type { FogSession } from "../fog/session";
import { getAdventure, getAdventureByPlayerLink, setActiveImage, setTokenSize } from "../db/adventures";
import { getImage, imageBelongsToAdventure, setStartPoint, setStartLocked } from "../db/images";
import { repairImageDimensions } from "../images";
import { findOrCreateToken, createToken, getToken, getAdventureToken, getTokensByAdventure, getPlayerTokensByAdventure, getGmTokensByImage, updateTokenPosition, rememberTokenPosition, getRememberedPositions, deleteToken, renameToken, setTokenState } from "../db/tokens";
import {
  registerConnection,
  unregisterConnection,
  getConnection,
  getConnectionsForAdventure,
  getWsForToken,
  getGmWsForAdventure,
  getGmSocketsForAdventure,
} from "./connections";
import { openDeclaration, getDeclaration, getDeclarationsByImage, getResolvedByImage, deleteDeclaration, answerDeclaration, setDeclarationDamage } from "../db/declarations";
import { parseMessage, serializeMessage } from "./messages";
import { arrivalPosition, landParty } from "../landing";

// ---- Spawn position ----

/**
 * Where a newly joined player appears: the active map's start point, offset so
 * successive arrivals do not stack. Falls back to the map centre when no start
 * point is set, and to a spot near the corner when no page is presented.
 */
function placeArrivingToken(
  db: Database,
  uploadsDir: string,
  adventure: { active_image_id: string | null; token_size?: number },
  existingCount: number
): { x: number; y: number } {
  if (adventure.active_image_id) {
    const img = getSizedImage(db, adventure.active_image_id, uploadsDir);
    if (img && img.width > 0 && img.height > 0) {
      return arrivalPosition(existingCount, img, adventure.token_size ?? 20);
    }
  }
  // No page to stand on: near the corner, jittered so arrivals do not stack.
  const angle = Math.random() * Math.PI * 2;
  const radius = 40 + Math.random() * 40;
  return {
    x: Math.round(100 + Math.cos(angle) * radius),
    y: Math.round(100 + Math.sin(angle) * radius),
  };
}

/**
 * A page row, with its size read from the file first when the upload stored none. Landing needs
 * the size to find the centre and to keep the ring inside the page.
 */
function getSizedImage(db: Database, imageId: string, uploadsDir: string) {
  const image = getImage(db, imageId);
  if (image && (image.width === 0 || image.height === 0) && uploadsDir) {
    repairImageDimensions(db, imageId, uploadsDir);
    return getImage(db, imageId) ?? image;
  }
  return image;
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

function sendToGms(adventureId: string, message: string): void {
  for (const gmWs of getGmSocketsForAdventure(adventureId)) gmWs.send(message);
}

// ---- Which page an edit targets, and who hears about it ----

/**
 * **Only the presented page reaches the players.**
 *
 * The GM prepares a page the party is not looking at, so every fog and token message names its
 * page and the server decides the audience: applied to whichever page is named, published to the
 * adventure topic *only* when that page is `active_image_id`. The GM's phase never reaches here —
 * if it did, what the players see would depend on a browser's opinion (#51).
 *
 * Null means the id is not a page of this adventure.
 */
function resolvePage(
  db: Database,
  adventureId: string,
  imageId: string
): { imageId: string; isLive: boolean } | null {
  if (!imageBelongsToAdventure(db, imageId, adventureId)) return null;
  return { imageId, isLive: reachesTable(db, adventureId, imageId) };
}

/**
 * Whether the players hear about something on this page — the one place that rule lives. `null`
 * is a player token's page: it stands on whatever is presented, so it is always heard. So is a
 * monster row with no image, which predates per-map GM tokens.
 */
function reachesTable(db: Database, adventureId: string, imageId: string | null): boolean {
  return imageId === null || getAdventure(db, adventureId)?.active_image_id === imageId;
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

/**
 * A number a table can plausibly roll. Not a rule — the tool computes nothing with it — just the
 * boundary check that keeps a typo or a forged message off everybody's screen.
 */
const MAX_DAMAGE = 999;

/** Tells the table that declarations are gone, whatever removed them. Silent on an empty list. */
function publishCleared(
  ws: ServerWebSocket<WsData>,
  topic: string,
  declarationIds: string[],
  live = true
): void {
  if (declarationIds.length === 0) return;
  const cleared = serializeMessage({ type: "declaration:cleared", declarationIds });
  ws.send(cleared);
  if (live) ws.publish(topic, cleared);
}

/**
 * Sends a declaration's new state to the sender and, when its page is the one on the table, to
 * everybody else. Re-read from the database rather than assembled here, so what the table is shown
 * is what was stored (principle 2).
 */
function publishDeclaration(
  db: Database,
  ws: ServerWebSocket<WsData>,
  topic: string,
  adventureId: string,
  declarationId: string
): void {
  const declaration = getDeclaration(db, declarationId);
  if (!declaration) return;
  const updated = serializeMessage({ type: "declaration:updated", declaration });
  ws.send(updated);
  if (reachesTable(db, adventureId, declaration.image_id)) ws.publish(topic, updated);
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
      let playerTokens = getPlayerTokensByAdventure(db, adventureId);

      // A newcomer is placed before `joined` is built, never after.
      //
      // The token row is created during the upgrade with no coordinates, so it defaults to 0,0.
      // Placing it after the payload had gone left the joining client the one client never told
      // where its own token stood — everybody else learned it from the `token:added` broadcast,
      // which excludes the sender. The player then dragged it out of the corner, and that drag was
      // stored as truth for everyone (#44).
      //
      // Arrivals land on the map's start point, not beside the party, so a latecomer walks in from
      // the entrance instead of appearing mid-scene. A spawn is an arrival, so it is not
      // remembered: `updateTokenPosition` writes the token, never `token_positions`. Recording it
      // made a player who joined on a map return to their spawn on every later visit instead of
      // arriving on its flag (#46, found while verifying #57).
      if (tokenId && tokenIsNew) {
        const others = playerTokens.filter((t) => t.id !== tokenId).length;
        const spawnPos = placeArrivingToken(db, uploadsDir, adventure, others);
        updateTokenPosition(db, tokenId, spawnPos.x, spawnPos.y);
        playerTokens = getPlayerTokensByAdventure(db, adventureId);
      }

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
          declarations: adventure.active_image_id
            ? getDeclarationsByImage(db, adventure.active_image_id)
            : [],
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
          // Already placed and re-read above, so this is the arrival position the joiner was sent.
          const newToken = playerTokens.find((t) => t.id === tokenId);
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

      const parsed = parseMessage(typeof raw === "string" ? raw : raw.toString());
      if ("error" in parsed) {
        ws.send(serializeMessage({ type: "error", message: parsed.error }));
        return;
      }
      const msg = parsed.message;

      const { adventureId } = conn;
      const topic = `adventure:${adventureId}`;
      const fog = deps.fog.forAdventure(adventureId);

      // The last net. A throw that escapes this async handler exits the process, and with it every
      // table on the server — so one bad message costs its sender an error and nothing more.
      try {
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
            const page = resolvePage(db, adventureId, msg.imageId);
            if (!page) {
              ws.send(serializeMessage({ type: "error", message: "No such page" }));
              break;
            }
            let session: FogSession;
            try {
              session = await fog.open(page.imageId);
            } catch {
              // A map whose dimensions never parsed has no mask to paint on. Left
              // unguarded this rejection escapes the handler and exits the process.
              ws.send(serializeMessage({ type: "error", message: "Map dimensions unknown" }));
              break;
            }
            session.applyStrokes([msg.stroke]);
            // Stored on every page; heard on one. A page in preparation is silent.
            if (page.isLive) {
              ws.publish(
                topic,
                serializeMessage({ type: "fog:stroke", stroke: msg.stroke, imageId: page.imageId })
              );
            }
            break;
          }

          case "fog:stroke:batch": {
            if (conn.role !== "gm") {
              ws.send(serializeMessage({ type: "error", message: "Only GM can send fog strokes" }));
              break;
            }
            const page = resolvePage(db, adventureId, msg.imageId);
            if (!page) {
              ws.send(serializeMessage({ type: "error", message: "No such page" }));
              break;
            }
            let session: FogSession;
            try {
              session = await fog.open(page.imageId);
            } catch {
              ws.send(serializeMessage({ type: "error", message: "Map dimensions unknown" }));
              break;
            }
            session.applyStrokes(msg.strokes);
            if (page.isLive) {
              ws.publish(
                topic,
                serializeMessage({
                  type: "fog:stroke:batch",
                  strokes: msg.strokes,
                  imageId: page.imageId,
                })
              );
            }
            break;
          }

          case "token:move": {
            if (conn.role !== "gm" && (!conn.tokenId || conn.tokenId !== msg.tokenId)) {
              ws.send(serializeMessage({ type: "error", message: "You do not own this token" }));
              break;
            }
            const token = getAdventureToken(db, adventureId, msg.tokenId);
            if (!token) {
              ws.send(serializeMessage({ type: "error", message: "Token not found" }));
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

            if (token.image_id === null) {
              // A player token belongs to the adventure and stands on whatever is presented, so its
              // walk is remembered against that page — the only writer of `token_positions` (#46).
              const activeImageId = getAdventure(db, adventureId)?.active_image_id ?? null;
              if (activeImageId) {
                rememberTokenPosition(db, msg.tokenId, activeImageId, msg.x, msg.y);
              }
            }
            // A monster belongs to one page. Dragging one on a page in preparation is stored and
            // silent, the same rule fog follows — and it is not a walk, so nothing is remembered.
            if (reachesTable(db, adventureId, token.image_id)) ws.publish(topic, moved);
            break;
          }

          case "settings:update": {
            if (conn.role !== "gm") {
              ws.send(serializeMessage({ type: "error", message: "Only GM can change settings" }));
              break;
            }
            const newSize = Math.min(100, Math.max(5, Math.round(msg.tokenSize)));
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
              const image = getSizedImage(db, msg.imageId, uploadsDir);
              if (image && image.width > 0 && image.height > 0) {
                const landed = landParty(
                  playerTokens.map((t) => t.id),
                  getRememberedPositions(db, msg.imageId),
                  image,
                  getAdventure(db, adventureId)?.token_size ?? 20
                );
                for (const [tokenId, pos] of landed) {
                  updateTokenPosition(db, tokenId, pos.x, pos.y);
                  // Arrival is deliberately *not* remembered (#46). Recording it made the very first
                  // visit consume the start point permanently, including a visit the GM made alone to
                  // paint fog. `token:move` is the only writer of token_positions, so a remembered
                  // position always means a token actually walked there.
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
              declarations: getDeclarationsByImage(db, msg.imageId),
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

          case "map:unpresent": {
            if (conn.role !== "gm") {
              ws.send(serializeMessage({ type: "error", message: "Only GM can clear the table" }));
              break;
            }
            setActiveImage(db, adventureId, null);
            // No token is moved and no fog is touched. Taking a page off the table is about what the
            // players are shown, and everything prepared on that page is waiting when it returns.
            const unpresented = serializeMessage({ type: "map:unpresented" });
            ws.send(unpresented);
            ws.publish(topic, unpresented);
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
            // The lock outlives the browser tab that set it, so the server enforces it rather than
            // trusting a client not to send (principle 1).
            if (image.start_locked) {
              ws.send(serializeMessage({ type: "error", message: "This start point is locked" }));
              break;
            }
            const point =
              msg.x === null || msg.y === null
                ? null
                : {
                    x: Math.round(Math.min(image.width, Math.max(0, msg.x))),
                    y: Math.round(Math.min(image.height, Math.max(0, msg.y))),
                  };
            const x = point?.x ?? null;
            const y = point?.y ?? null;
            setStartPoint(db, msg.imageId, x, y);
            // Remembered positions are left alone. They mean a token walked there, and the flag
            // governs first entry while walking governs return — moving one must not erase the other
            // (#57). The clear that used to live here compensated for #46 and retires with it.
            // GM-only: players must never learn where the party will appear. A GM may have the board
            // open on two devices, so this fans out to GM sockets only — never the adventure topic.
            sendToGms(
              adventureId,
              serializeMessage({
                type: "map:start_point:set",
                imageId: msg.imageId,
                x,
                y,
                locked: false,
              })
            );
            break;
          }

          case "map:start_point:lock": {
            if (conn.role !== "gm") {
              ws.send(serializeMessage({ type: "error", message: "Only GM can lock the start point" }));
              break;
            }
            const image = getImage(db, msg.imageId);
            if (!image || image.adventure_id !== adventureId) {
              ws.send(serializeMessage({ type: "error", message: "Image not found" }));
              break;
            }
            setStartLocked(db, msg.imageId, msg.locked);
            // Same GM-only path, and the same message, so the client has one place to read the start
            // point's whole state from. This must not use the player-visible adventure topic.
            sendToGms(
              adventureId,
              serializeMessage({
                type: "map:start_point:set",
                imageId: msg.imageId,
                x: image.start_x,
                y: image.start_y,
                locked: msg.locked,
              })
            );
            break;
          }

          case "player:remove": {
            if (conn.role !== "gm") {
              ws.send(serializeMessage({ type: "error", message: "Only GM can remove players" }));
              break;
            }
            const target = getAdventureToken(db, adventureId, msg.tokenId);
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
            const page = resolvePage(db, adventureId, msg.imageId);
            if (!page) break;
            const session = fog.peek(page.imageId);
            if (!session) break;
            session.commit();
            ws.send(
              serializeMessage({
                type: "fog:history",
                imageId: page.imageId,
                ...fog.historyState(page.imageId),
              })
            );
            break;
          }

          // History is per page and server-owned, so selecting a page on the board is when the GM's
          // buttons need its state. `historyState` reads what is resident and never loads a mask.
          case "fog:history:query": {
            if (conn.role !== "gm") break;
            const page = resolvePage(db, adventureId, msg.imageId);
            if (!page) break;
            ws.send(
              serializeMessage({
                type: "fog:history",
                imageId: page.imageId,
                ...fog.historyState(page.imageId),
              })
            );
            break;
          }

          case "fog:undo":
          case "fog:redo": {
            if (conn.role !== "gm") {
              ws.send(serializeMessage({ type: "error", message: "Only GM can undo fog strokes" }));
              break;
            }
            const page = resolvePage(db, adventureId, msg.imageId);
            if (!page) {
              ws.send(serializeMessage({ type: "error", message: "No such page" }));
              break;
            }
            const imageId = page.imageId;
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
            // The GM always sees their own step; the table only when it is the page on it.
            ws.send(resetMsg);
            if (page.isLive) ws.publish(topic, resetMsg);
            ws.send(serializeMessage({ type: "fog:history", imageId, ...fog.historyState(imageId) }));
            break;
          }

          case "gm_token:place": {
            if (conn.role !== "gm") {
              ws.send(serializeMessage({ type: "error", message: "Only GM can place tokens" }));
              break;
            }
            const page = resolvePage(db, adventureId, msg.imageId);
            if (!page) {
              ws.send(serializeMessage({ type: "error", message: "No such page to place token on" }));
              break;
            }
            const color = msg.tokenType === 'monster' ? '#c0392b' : '#7f8c9a';
            const placed = createToken(db, {
              adventureId,
              name: msg.name.slice(0, 40),
              color,
              tokenType: msg.tokenType,
              x: msg.x,
              y: msg.y,
              imageId: page.imageId,
            });
            const placedMsg = serializeMessage({ type: 'gm_token:added', token: placed });
            ws.send(placedMsg);
            // A monster prepared on a page nobody is looking at waits there in silence.
            if (page.isLive) ws.publish(topic, placedMsg);
            break;
          }

          case "gm_token:remove": {
            if (conn.role !== "gm") {
              ws.send(serializeMessage({ type: "error", message: "Only GM can remove GM tokens" }));
              break;
            }
            const target = getAdventureToken(db, adventureId, msg.tokenId);
            if (!target || target.token_type === 'player') {
              ws.send(serializeMessage({ type: "error", message: "GM token not found" }));
              break;
            }
            deleteToken(db, msg.tokenId);
            const removedMsg = serializeMessage({ type: "token:removed", tokenId: msg.tokenId });
            ws.send(removedMsg);
            // A monster the players never received must not have its removal announced either.
            if (reachesTable(db, adventureId, target.image_id)) ws.publish(topic, removedMsg);
            break;
          }

          case "gm_token:rename": {
            if (conn.role !== "gm") {
              ws.send(serializeMessage({ type: "error", message: "Only GM can rename GM tokens" }));
              break;
            }
            const target = getAdventureToken(db, adventureId, msg.tokenId);
            if (!target || target.token_type === 'player') {
              // A player token is refused here rather than filtered by the caller: its name is half
              // of `playerLink|playerName`, which is how its owner reconnects.
              ws.send(serializeMessage({ type: "error", message: "GM token not found" }));
              break;
            }
            // The first client-supplied string this handler stores. Principle 9 — cap it at the
            // length the placement form already accepts rather than trusting what arrives.
            const name = msg.name.trim().slice(0, 40);
            if (name === "") {
              ws.send(serializeMessage({ type: "error", message: "A name is required" }));
              break;
            }
            renameToken(db, msg.tokenId, name);
            const renamedMsg = serializeMessage({
              type: "token:renamed",
              tokenId: msg.tokenId,
              name,
            });
            ws.send(renamedMsg);
            if (reachesTable(db, adventureId, target.image_id)) ws.publish(topic, renamedMsg);
            break;
          }

          case "gm_token:state": {
            if (conn.role !== "gm") {
              ws.send(serializeMessage({ type: "error", message: "Only GM can set a token state" }));
              break;
            }
            const target = getAdventureToken(db, adventureId, msg.tokenId);
            if (!target) {
              ws.send(serializeMessage({ type: "error", message: "Token not found" }));
              break;
            }
            // A player token is accepted here — deliberately, and unlike rename. The GM adjudicates
            // every token's state, so this is the one message that writes to a player's token.
            const state = msg.state;
            setTokenState(db, msg.tokenId, state);
            const stateMsg = serializeMessage({
              type: "token:state:set",
              tokenId: msg.tokenId,
              state,
            });
            ws.send(stateMsg);
            if (reachesTable(db, adventureId, target.image_id)) ws.publish(topic, stateMsg);
            break;
          }

          case "declaration:open": {
            // The page is the presented one, always. A declaration is something said at the table,
            // and the table is looking at one page — there is nothing to declare on a page in
            // preparation, and nothing that would ever be seen.
            const liveImageId = getAdventure(db, adventureId)?.active_image_id ?? null;
            if (!liveImageId) {
              ws.send(serializeMessage({ type: "error", message: "Nothing is on the table" }));
              break;
            }

            // The attacker, read off the connection and never off the message. A player has exactly
            // one token and it is the only thing they may attack from; the GM has no source token at
            // all. This is the whole of the authorisation rule for the first thing a player writes
            // that is not their own position — there is nothing here a client could forge.
            let sourceId: string | null = null;
            if (conn.role !== "gm") {
              if (!conn.tokenId) {
                ws.send(serializeMessage({ type: "error", message: "You have no token" }));
                break;
              }
              sourceId = conn.tokenId;
            }

            const target = getAdventureToken(db, adventureId, msg.targetId);
            if (!target) {
              ws.send(serializeMessage({ type: "error", message: "Token not found" }));
              break;
            }
            // A player token has no image and is therefore always on the presented page.
            if (target.image_id !== null && target.image_id !== liveImageId) {
              ws.send(serializeMessage({ type: "error", message: "That token is not on the table" }));
              break;
            }
            // The party attacks monsters and the GM attacks the party. Player against player and an
            // NPC helping the party are both out of scope (#62), and this is where that is true.
            const targetIsGmToken = target.token_type !== "player";
            if (sourceId !== null && !targetIsGmToken) {
              ws.send(serializeMessage({ type: "error", message: "You cannot attack another player" }));
              break;
            }
            if (sourceId === null && targetIsGmToken) {
              ws.send(serializeMessage({ type: "error", message: "Only the party can be attacked from a monster" }));
              break;
            }

            const { declaration, cleared } = openDeclaration(db, {
              imageId: liveImageId,
              sourceId,
              targetId: target.id,
            });
            // The swept-away records go first, so nobody watches the new pip appear beside the old
            // one. Records on a page nobody is looking at go quietly, like everything else off it.
            publishCleared(ws, topic, cleared.filter((d) => d.image_id === liveImageId).map((d) => d.id));
            const opened = serializeMessage({ type: "declaration:opened", declaration });
            ws.send(opened);
            ws.publish(topic, opened);
            break;
          }

          case "declaration:retract": {
            const declaration = getDeclaration(db, msg.declarationId);
            if (!declaration) {
              ws.send(serializeMessage({ type: "error", message: "Declaration not found" }));
              break;
            }
            if (!imageBelongsToAdventure(db, declaration.image_id, adventureId)) {
              ws.send(serializeMessage({ type: "error", message: "Declaration not found" }));
              break;
            }
            // Only the one who said it can take it back. The GM's are the sourceless ones, and a
            // player's are their own token's — the same rule the declaring side is built on.
            const mine =
              conn.role === "gm"
                ? declaration.source_id === null
                : !!conn.tokenId && declaration.source_id === conn.tokenId;
            if (!mine) {
              ws.send(serializeMessage({ type: "error", message: "This is not your declaration" }));
              break;
            }
            deleteDeclaration(db, declaration.id);
            publishCleared(ws, topic, [declaration.id], reachesTable(db, adventureId, declaration.image_id));
            break;
          }

          case "declaration:clear": {
            if (conn.role !== "gm") {
              ws.send(serializeMessage({ type: "error", message: "Only GM can clear the table" }));
              break;
            }
            const liveImageId = getAdventure(db, adventureId)?.active_image_id ?? null;
            if (!liveImageId) {
              ws.send(serializeMessage({ type: "error", message: "Nothing is on the table" }));
              break;
            }
            // Answered ones only. What is still open is waiting on somebody, and the count beside the
            // control is what says so — this can never destroy an exchange nobody has seen.
            const resolved = getResolvedByImage(db, liveImageId);
            for (const row of resolved) deleteDeclaration(db, row.id);
            publishCleared(ws, topic, resolved.map((d) => d.id));
            break;
          }

          case "declaration:answer": {
            const declaration = getDeclaration(db, msg.declarationId);
            if (!declaration || !imageBelongsToAdventure(db, declaration.image_id, adventureId)) {
              ws.send(serializeMessage({ type: "error", message: "Declaration not found" }));
              break;
            }
            // Immutable once answered. A record of what happened is not a control, and only
            // clearing removes it (#73).
            if (declaration.state !== "open") {
              ws.send(serializeMessage({ type: "error", message: "This attack has already been answered" }));
              break;
            }
            const target = getToken(db, declaration.target_id);
            if (!target) {
              ws.send(serializeMessage({ type: "error", message: "Token not found" }));
              break;
            }
            // The target's owner answers, and nobody else: a player for their own token, the GM for
            // every monster and NPC. One writer per object, and the object is the declaration.
            const answersForTarget =
              target.token_type === "player"
                ? conn.role !== "gm" && !!conn.tokenId && conn.tokenId === target.id
                : conn.role === "gm";
            if (!answersForTarget) {
              ws.send(serializeMessage({ type: "error", message: "This attack is not aimed at you" }));
              break;
            }
            answerDeclaration(db, declaration.id, msg.parried);
            publishDeclaration(db, ws, topic, adventureId, declaration.id);
            break;
          }

          case "declaration:damage": {
            const declaration = getDeclaration(db, msg.declarationId);
            if (!declaration || !imageBelongsToAdventure(db, declaration.image_id, adventureId)) {
              ws.send(serializeMessage({ type: "error", message: "Declaration not found" }));
              break;
            }
            // Only where a number has a meaning: a parried attack rolled none, and an open one has
            // not been answered yet. Written once, for the same reason answering is.
            if (declaration.state !== "not_parried") {
              ws.send(serializeMessage({ type: "error", message: "No damage to send on this attack" }));
              break;
            }
            if (declaration.damage !== null) {
              ws.send(serializeMessage({ type: "error", message: "The damage has already been sent" }));
              break;
            }
            // The other half of the pair: the source's owner sends the number they rolled. The GM's
            // declarations have no source token, and the GM is who owns those.
            const sendsForSource =
              declaration.source_id === null
                ? conn.role === "gm"
                : conn.role !== "gm" && !!conn.tokenId && conn.tokenId === declaration.source_id;
            if (!sendsForSource) {
              ws.send(serializeMessage({ type: "error", message: "This is not your attack" }));
              break;
            }
            // The first client-supplied *number* on the wire. Checked rather than clamped: a 7 that
            // silently became a 999 would be a lie the table acts on (principle 9, #12).
            const damage = msg.damage;
            if (!Number.isInteger(damage) || damage < 0 || damage > MAX_DAMAGE) {
              ws.send(serializeMessage({ type: "error", message: `Damage must be a whole number from 0 to ${MAX_DAMAGE}` }));
              break;
            }
            setDeclarationDamage(db, declaration.id, damage);
            publishDeclaration(db, ws, topic, adventureId, declaration.id);
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

        }
      } catch (err) {
        console.error(`ws: ${msg.type} failed`, err);
        ws.send(serializeMessage({ type: "error", message: "Something went wrong" }));
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
