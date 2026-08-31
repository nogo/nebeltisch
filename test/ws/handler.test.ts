import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { startWsTestServer, type WsTestServer } from "../helpers";
import { createAdventure, getAdventure } from "../../src/db/adventures";
import { createImageRecord } from "../../src/db/images";
import { getTokensByAdventure } from "../../src/db/tokens";
import { getDeclarationsByImage, getDeclaration } from "../../src/db/declarations";
// Fog state is reached through the test server’s own registry, not a module global.
import { loadFogMask } from "../../src/fog/serialize";
import { isRevealed } from "../../src/fog/mask";

// ---- WebSocket test helpers ----

function connectWS(wsUrl: string, params: Record<string, string>): Promise<WebSocket> {
  const url = new URL(`${wsUrl}/ws`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.toString());
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket connect timeout"));
    }, 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket connection error"));
    };
  });
}

function waitForMessage(ws: WebSocket, type: string, timeout = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error(`Timeout waiting for message type: ${type}`));
    }, timeout);
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type === type) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    ws.addEventListener("message", handler);
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.onclose = () => resolve();
    ws.close();
  });
}

// ---- Tests ----

describe("WebSocket handler", () => {
  let ts: WsTestServer;
  let adventureId: string;
  let gmPassword: string;
  let playerLink: string;
  let imageId: string;
  const openSockets: WebSocket[] = [];

  function track(ws: WebSocket): WebSocket {
    openSockets.push(ws);
    return ws;
  }

  beforeEach(() => {
    ts = startWsTestServer();
    const adventure = createAdventure(ts.db, { name: "Test Adventure", gmPassword: "secret" });
    adventureId = adventure.id;
    gmPassword = adventure.gm_password;
    playerLink = adventure.player_link;
    const image = createImageRecord(ts.db, {
      adventureId,
      filename: "test.png",
      originalName: "test.png",
      width: 100,
      height: 100,
    });
    imageId = image.id;
  });

  afterEach(async () => {
    for (const ws of openSockets) {
      if (ws.readyState !== WebSocket.CLOSED) ws.close();
    }
    openSockets.length = 0;
    // Small delay to let close handlers fire before stopping server
    await new Promise((r) => setTimeout(r, 50));
    ts.stop();
  });

  it("GM connects with correct password → receives joined", async () => {
    const ws = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    const msg = await waitForMessage(ws, "joined");
    expect(msg.adventure.id).toBe(adventureId);
    expect(msg.adventure.name).toBe("Test Adventure");
    expect(Array.isArray(msg.tokens)).toBe(true);
  });

  it("GM connects with wrong password → HTTP 401", async () => {
    const url = new URL(`${ts.wsUrl}/ws`.replace("ws://", "http://"));
    url.searchParams.set("adventureId", adventureId);
    url.searchParams.set("role", "gm");
    url.searchParams.set("password", "wrong");
    const res = await fetch(url.toString());
    expect(res.status).toBe(401);
  });

  it("Player connects with valid player link → receives joined with token", async () => {
    const ws = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Alice",
        playerColor: "#ff0000",
      })
    );
    const msg = await waitForMessage(ws, "joined");
    expect(msg.adventure.id).toBe(adventureId);
    expect(msg.tokens.length).toBeGreaterThan(0);
    const token = msg.tokens.find((t: any) => t.name === "Alice");
    expect(token).toBeDefined();
    expect(token.color).toBe("#ff0000");
  });

  // The token row is created during the upgrade with no coordinates, so it defaults to 0,0. The
  // arrival position used to be computed *after* `joined` had gone, and the broadcast that carried
  // it excludes the sender — so the joining client was the one client never told where it stood
  // (#44).
  it("A new player's joined payload carries its arrival position, never 0,0", async () => {
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const ws = track(
      await connectWS(ts.wsUrl, {
        adventureId, role: "player", playerLink, playerName: "Alice", playerColor: "#ff0000",
      })
    );
    const msg = await waitForMessage(ws, "joined");
    const mine = msg.tokens.find((t: any) => t.id === msg.yourTokenId);

    expect(mine).toBeDefined();
    expect(mine.x === 0 && mine.y === 0).toBe(false);
    // No start point is set on this image, so the party lands at the map centre.
    expect(Math.hypot(mine.x - 50, mine.y - 50)).toBeLessThan(60);
  });

  it("The joining player and the GM agree on where the new token is", async () => {
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const gm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(gm, "joined");
    const tokenAddedPromise = waitForMessage(gm, "token:added");

    const player = track(
      await connectWS(ts.wsUrl, {
        adventureId, role: "player", playerLink, playerName: "Alice", playerColor: "#ff0000",
      })
    );
    const joined = await waitForMessage(player, "joined");
    const mine = joined.tokens.find((t: any) => t.id === joined.yourTokenId);
    const asGmSeesIt = (await tokenAddedPromise).token;

    expect(asGmSeesIt.id).toBe(mine.id);
    expect(mine.x).toBe(asGmSeesIt.x);
    expect(mine.y).toBe(asGmSeesIt.y);
  });

  it("A returning player still appears where they last stood", async () => {
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const first = await connectWS(ts.wsUrl, {
      adventureId, role: "player", playerLink, playerName: "Alice", playerColor: "#ff0000",
    });
    const joined = await waitForMessage(first, "joined");
    const tokenId = joined.yourTokenId;

    const moved = waitForMessage(first, "token:moved");
    first.send(JSON.stringify({ type: "token:move", tokenId, x: 77, y: 33 }));
    await moved;
    await closeWs(first);

    const again = track(
      await connectWS(ts.wsUrl, {
        adventureId, role: "player", playerLink, playerName: "Alice", playerColor: "#ff0000",
      })
    );
    const rejoined = await waitForMessage(again, "joined");
    const mine = rejoined.tokens.find((t: any) => t.id === tokenId);

    expect(mine.x).toBe(77);
    expect(mine.y).toBe(33);
  });

  it("Player connects with invalid player link → HTTP 401", async () => {
    const url = new URL(`${ts.wsUrl}/ws`.replace("ws://", "http://"));
    url.searchParams.set("adventureId", adventureId);
    url.searchParams.set("role", "player");
    url.searchParams.set("playerLink", "badlink");
    url.searchParams.set("playerName", "Alice");
    url.searchParams.set("playerColor", "#ff0000");
    const res = await fetch(url.toString());
    expect(res.status).toBe(401);
  });

  it("Player connects → other clients receive player:joined and token:added", async () => {
    const gm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(gm, "joined");

    // Connect player while listening for notifications on gm
    const playerJoinedPromise = waitForMessage(gm, "player:joined");
    const tokenAddedPromise = waitForMessage(gm, "token:added");

    const player = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Bob",
        playerColor: "#00ff00",
      })
    );
    await waitForMessage(player, "joined");

    const playerJoined = await playerJoinedPromise;
    expect(playerJoined.playerName).toBe("Bob");
    expect(playerJoined.playerColor).toBe("#00ff00");

    const tokenAdded = await tokenAddedPromise;
    expect(tokenAdded.token.name).toBe("Bob");
  });

  it("GM sends fog:stroke → players receive it", async () => {
    // Set active image
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const gm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(gm, "joined");

    const player = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Alice",
        playerColor: "#ff0000",
      })
    );
    await waitForMessage(player, "joined");

    const strokePromise = waitForMessage(player, "fog:stroke");
    gm.send(
      JSON.stringify({
        type: "fog:stroke",
        imageId,
        stroke: { x: 50, y: 50, radius: 10, mode: "reveal" },
      })
    );

    const stroke = await strokePromise;
    expect(stroke.imageId).toBe(imageId);
    expect(stroke.stroke.x).toBe(50);
    expect(stroke.stroke.mode).toBe("reveal");
  });

  it("Player sends fog:stroke → receives error", async () => {
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const player = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Alice",
        playerColor: "#ff0000",
      })
    );
    await waitForMessage(player, "joined");

    const errPromise = waitForMessage(player, "error");
    player.send(
      JSON.stringify({
        type: "fog:stroke",
        imageId,
        stroke: { x: 50, y: 50, radius: 10, mode: "reveal" },
      })
    );

    const err = await errPromise;
    expect(err.message).toContain("GM");
  });

  it("Player moves their own token → all clients receive token:moved", async () => {
    const gm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(gm, "joined");

    const player = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Alice",
        playerColor: "#ff0000",
      })
    );
    const joinedMsg = await waitForMessage(player, "joined");
    const tokenId = joinedMsg.tokens.find((t: any) => t.name === "Alice").id;

    const gmMovedPromise = waitForMessage(gm, "token:moved");
    const playerMovedPromise = waitForMessage(player, "token:moved");

    player.send(JSON.stringify({ type: "token:move", tokenId, x: 42, y: 17 }));

    const gmMoved = await gmMovedPromise;
    expect(gmMoved.tokenId).toBe(tokenId);
    expect(gmMoved.x).toBe(42);
    expect(gmMoved.y).toBe(17);

    const playerMoved = await playerMovedPromise;
    expect(playerMoved.tokenId).toBe(tokenId);
  });

  it("Player moves another player's token → receives error", async () => {
    // Create second player
    const adventure2 = ts.db
      .query<{ player_link: string }, string>(
        "SELECT player_link FROM adventures WHERE id = ?"
      )
      .get(adventureId)!;

    const player1 = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Alice",
        playerColor: "#ff0000",
      })
    );
    const joined1 = await waitForMessage(player1, "joined");
    const alice = joined1.tokens.find((t: any) => t.name === "Alice");

    const player2 = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Bob",
        playerColor: "#00ff00",
      })
    );
    await waitForMessage(player2, "joined");

    const errPromise = waitForMessage(player2, "error");
    // player2 tries to move player1's token
    player2.send(JSON.stringify({ type: "token:move", tokenId: alice.id, x: 10, y: 10 }));

    const err = await errPromise;
    expect(err.message).toContain("own");
  });

  it("GM sends map:switch → all clients receive map:switched", async () => {
    const gm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(gm, "joined");

    const player = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Alice",
        playerColor: "#ff0000",
      })
    );
    await waitForMessage(player, "joined");

    const gmSwitchedPromise = waitForMessage(gm, "map:switched");
    const playerSwitchedPromise = waitForMessage(player, "map:switched");

    gm.send(JSON.stringify({ type: "map:switch", imageId }));

    const gmSwitched = await gmSwitchedPromise;
    expect(gmSwitched.imageId).toBe(imageId);

    const playerSwitched = await playerSwitchedPromise;
    expect(playerSwitched.imageId).toBe(imageId);
  });

  it("GM sends map:unpresent → all clients hear it and nothing is presented", async () => {
    const gm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(gm, "joined");

    const player = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Alice",
        playerColor: "#ff0000",
      })
    );
    await waitForMessage(player, "joined");

    gm.send(JSON.stringify({ type: "map:switch", imageId }));
    await waitForMessage(player, "map:switched");

    const gmCleared = waitForMessage(gm, "map:unpresented");
    const playerCleared = waitForMessage(player, "map:unpresented");
    gm.send(JSON.stringify({ type: "map:unpresent" }));
    await gmCleared;
    await playerCleared;

    expect(getAdventure(ts.db, adventureId)?.active_image_id).toBe(null);
  });

  it("A player cannot clear the table", async () => {
    const player = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Alice",
        playerColor: "#ff0000",
      })
    );
    await waitForMessage(player, "joined");
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const errPromise = waitForMessage(player, "error");
    player.send(JSON.stringify({ type: "map:unpresent" }));
    await errPromise;

    expect(getAdventure(ts.db, adventureId)?.active_image_id).toBe(imageId);
  });

  it("Presenting again after unpresenting returns the party to where it stood", async () => {
    const gm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(gm, "joined");

    const player = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Alice",
        playerColor: "#ff0000",
      })
    );
    await waitForMessage(player, "joined");

    gm.send(JSON.stringify({ type: "map:switch", imageId }));
    await waitForMessage(player, "map:switched");

    // The party walks somewhere deliberate. `token:move` is the only writer of token_positions,
    // so this is what "where it stood" means.
    const alice = getTokensByAdventure(ts.db, adventureId).find((t) => t.token_type === "player")!;
    const moved = waitForMessage(gm, "token:moved");
    player.send(JSON.stringify({ type: "token:move", tokenId: alice.id, x: 37, y: 41 }));
    await moved;

    gm.send(JSON.stringify({ type: "map:unpresent" }));
    await waitForMessage(player, "map:unpresented");

    const back = waitForMessage(player, "map:switched");
    gm.send(JSON.stringify({ type: "map:switch", imageId }));
    const returned = await back;

    const token = returned.playerTokens.find((t: { id: string }) => t.id === alice.id);
    expect(token.x).toBe(37);
    expect(token.y).toBe(41);
  });

  it("Player disconnects → other clients receive player:left, token persists in DB", async () => {
    const gm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(gm, "joined");

    // Subscribe before connecting: the server publishes player:joined during the
    // player's open() handler, so a listener attached afterwards never sees it.
    const playerJoinedPromise = waitForMessage(gm, "player:joined");

    const player = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Alice",
        playerColor: "#ff0000",
      })
    );
    const joinedMsg = await waitForMessage(player, "joined");
    const tokenId = joinedMsg.tokens.find((t: any) => t.name === "Alice").id;

    // Wait for gm to receive player:joined before disconnecting
    await playerJoinedPromise;

    const leftPromise = waitForMessage(gm, "player:left");

    await closeWs(player);

    const left = await leftPromise;
    expect(left.playerName).toBe("Alice");

    // Token must persist — not deleted on disconnect
    const tokens = getTokensByAdventure(ts.db, adventureId);
    expect(tokens.find((t) => t.id === tokenId)).toBeDefined();
  });

  it("Late joiner receives current fog state and existing tokens", async () => {
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const gm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(gm, "joined");

    // GM applies a fog stroke
    gm.send(
      JSON.stringify({
        type: "fog:stroke",
        imageId,
        stroke: { x: 50, y: 50, radius: 20, mode: "reveal" },
      })
    );

    // Give the stroke time to be applied
    await new Promise((r) => setTimeout(r, 50));

    // Player joins late
    const player = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Alice",
        playerColor: "#ff0000",
      })
    );
    const joined = await waitForMessage(player, "joined");

    // Should have the fog mask
    expect(joined.fogMask).not.toBeNull();
    expect(typeof joined.fogMask).toBe("string");

    // Should have existing tokens (Alice's token was just created, at minimum)
    expect(joined.tokens.length).toBeGreaterThan(0);
  });

  it("Fog mask survives flush", async () => {
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const gm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(gm, "joined");

    gm.send(JSON.stringify({
      type: "fog:stroke",
      imageId,
      stroke: { x: 50, y: 50, radius: 20, mode: "reveal" },
    }));
    await new Promise((r) => setTimeout(r, 50));

    await ts.fog.flushAll();

    const loaded = await loadFogMask(ts.db, imageId);
    expect(loaded).not.toBeNull();
    expect(loaded!.width).toBe(100);
    expect(loaded!.height).toBe(100);
  });

  it("Painting a map whose dimensions never parsed is refused, not fatal", async () => {
    // The upload gate accepts any image/*, but only PNG, JPEG and WebP headers
    // are parsed, so an unsupported format is stored 0x0 (#10). Opening its mask
    // throws; unguarded, that rejection escaped the message handler and Bun
    // exited the process — a restart loop for as long as the GM kept painting.
    const unparsed = createImageRecord(ts.db, {
      adventureId,
      filename: "map.gif",
      originalName: "map.gif",
      width: 0,
      height: 0,
    }).id;
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [unparsed, adventureId]);

    const gm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(gm, "joined");

    const err = waitForMessage(gm, "error");
    gm.send(JSON.stringify({
      type: "fog:stroke",
      imageId: unparsed,
      stroke: { x: 10, y: 10, radius: 5, mode: "reveal" },
    }));
    expect((await err).message).toContain("dimensions");

    const batchErr = waitForMessage(gm, "error");
    gm.send(JSON.stringify({
      type: "fog:stroke:batch",
      imageId: unparsed,
      strokes: [{ x: 10, y: 10, radius: 5, mode: "reveal" }],
    }));
    expect((await batchErr).message).toContain("dimensions");

    // Still serving: the point of the guard is that the connection survives.
    const pong = waitForMessage(gm, "pong");
    gm.send(JSON.stringify({ type: "ping" }));
    await pong;
  });

  it("A GM disconnect flushes its own adventure only", async () => {
    // GM disconnect used to clear every pending save timer on the server and
    // write every cached mask, including other tables' (#9).
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const other = createAdventure(ts.db, { name: "Other table", gmPassword: "other-pw" });
    const otherImageId = createImageRecord(ts.db, {
      adventureId: other.id,
      filename: "other.png",
      originalName: "other.png",
      width: 100,
      height: 100,
    }).id;
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [otherImageId, other.id]);

    const otherGm = track(
      await connectWS(ts.wsUrl, {
        adventureId: other.id,
        role: "gm",
        password: "other-pw",
      })
    );
    await waitForMessage(otherGm, "joined");
    otherGm.send(JSON.stringify({
      type: "fog:stroke",
      imageId: otherImageId,
      stroke: { x: 50, y: 50, radius: 20, mode: "reveal" },
    }));

    const gm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(gm, "joined");
    gm.send(JSON.stringify({
      type: "fog:stroke",
      imageId,
      stroke: { x: 50, y: 50, radius: 20, mode: "reveal" },
    }));
    await new Promise((r) => setTimeout(r, 50));

    await closeWs(gm);
    await new Promise((r) => setTimeout(r, 50));

    expect(await loadFogMask(ts.db, imageId)).not.toBeNull();
    expect(await loadFogMask(ts.db, otherImageId)).toBeNull();
  });

  it("Fog mask persists across GM reconnection", async () => {
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const gm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(gm, "joined");

    gm.send(JSON.stringify({
      type: "fog:stroke",
      imageId,
      stroke: { x: 50, y: 50, radius: 20, mode: "reveal" },
    }));
    await new Promise((r) => setTimeout(r, 50));

    // Disconnect GM → triggers flush
    await closeWs(gm);
    // Wait for async flush to complete
    await new Promise((r) => setTimeout(r, 100));

    // Verify fog is in DB
    const loaded = await loadFogMask(ts.db, imageId);
    expect(loaded).not.toBeNull();

    // GM reconnects and receives the persisted fog mask
    const gm2 = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    const joined = await waitForMessage(gm2, "joined");
    expect(joined.fogMask).not.toBeNull();
    expect(typeof joined.fogMask).toBe("string");
  });

  it("Ping/pong works", async () => {
    const ws = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(ws, "joined");

    const pongPromise = waitForMessage(ws, "pong");
    ws.send(JSON.stringify({ type: "ping" }));
    await pongPromise;
  });

  it("Invalid message format → receives error", async () => {
    const ws = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(ws, "joined");

    const errPromise = waitForMessage(ws, "error");
    ws.send("not valid json {{{");
    const err = await errPromise;
    expect(err.message).toBeDefined();
  });

  // ---- Fog undo history (server-owned) ----

  async function connectGm() {
    const gm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    // The GM also gets fog:history right after joining. Drain it here, or the
    // next listener registered for that type catches it instead of its own.
    const joinHistory = waitForMessage(gm, "fog:history").catch(() => null);
    await waitForMessage(gm, "joined");
    await joinHistory;
    return gm;
  }

  /** Paints one action on a page. Defaults to the adventure's only map, which is the live one. */
  async function paint(gm: WebSocket, x: number, y: number, radius = 8, page = imageId) {
    const historyPromise = waitForMessage(gm, "fog:history");
    gm.send(
      JSON.stringify({ type: "fog:stroke", imageId: page, stroke: { x, y, radius, mode: "reveal" } })
    );
    gm.send(JSON.stringify({ type: "fog:action:end", imageId: page }));
    return historyPromise;
  }

  async function currentMask(page = imageId) {
    await ts.fog.flushAll();
    return (await loadFogMask(ts.db, page))!;
  }

  /** Registers both listeners before sending, so neither can catch a stale message. */
  async function undoOrRedo(gm: WebSocket, type: "fog:undo" | "fog:redo", page = imageId) {
    const reset = waitForMessage(gm, "fog:reset");
    const history = waitForMessage(gm, "fog:history");
    gm.send(JSON.stringify({ type, imageId: page }));
    await reset;
    return await history;
  }

  it("Undo after a reload keeps fog painted in an earlier session", async () => {
    // The regression this whole rework exists for. The GM's browser stack is
    // empty after a reload; undo must not rebuild the mask from nothing.
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const first = await connectGm();
    await paint(first, 50, 50);
    await closeWs(first);

    // Fresh connection = fresh page, no client-side history whatsoever.
    const second = await connectGm();
    await paint(second, 10, 10);

    const reset = waitForMessage(second, "fog:reset");
    second.send(JSON.stringify({ type: "fog:undo", imageId }));
    await reset;

    const mask = await currentMask();
    expect(isRevealed(mask, 50, 50)).toBe(true);  // survived the reload
    expect(isRevealed(mask, 10, 10)).toBe(false); // the undo did undo something
  });

  it("Undo history survives a GM reload", async () => {
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const gm = await connectGm();
    await paint(gm, 50, 50);
    await closeWs(gm);

    // History is keyed by image on the server, so a new tab inherits it.
    // Connected inline rather than via connectGm, which drains fog:history.
    const fresh = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    const history = waitForMessage(fresh, "fog:history");
    await waitForMessage(fresh, "joined");
    expect((await history).canUndo).toBe(true);
  });

  it("Undo is a no-op when the server has no history for the map", async () => {
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const gm = await connectGm();
    await paint(gm, 50, 50);

    // A server restart loses the in-memory history; the baseline is reseeded
    // from the persisted mask, so there is nothing to step back to.
    await ts.fog.forAdventure(adventureId).evict(imageId);

    const history = waitForMessage(gm, "fog:history");
    gm.send(JSON.stringify({ type: "fog:undo", imageId }));
    expect((await history).canUndo).toBe(false);

    const mask = await currentMask();
    expect(isRevealed(mask, 50, 50)).toBe(true);
  });

  it("Redo re-applies an undone action", async () => {
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const gm = await connectGm();
    await paint(gm, 50, 50);
    const afterSecond = await paint(gm, 20, 20);
    expect(afterSecond.canUndo).toBe(true);

    await undoOrRedo(gm, "fog:undo");
    expect(isRevealed(await currentMask(), 20, 20)).toBe(false);

    await undoOrRedo(gm, "fog:redo");
    const mask = await currentMask();
    expect(isRevealed(mask, 20, 20)).toBe(true);
    expect(isRevealed(mask, 50, 50)).toBe(true);
  });

  it("A new action clears the redo stack", async () => {
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const gm = await connectGm();
    await paint(gm, 50, 50);
    expect((await undoOrRedo(gm, "fog:undo")).canRedo).toBe(true);

    const afterPaint = await paint(gm, 80, 80);
    expect(afterPaint.canRedo).toBe(false);
  });

  it("Player cannot undo fog", async () => {
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);
    const player = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Mallory",
        playerColor: "#123456",
      })
    );
    await waitForMessage(player, "joined");

    const errPromise = waitForMessage(player, "error");
    player.send(JSON.stringify({ type: "fog:undo", imageId }));
    const err = await errPromise;
    expect(err.message).toContain("GM");
  });

  // ---- Preparing a page the party is not looking at (#51) ----
  //
  // One rule carries the whole story: the server applies an edit to whichever page the message
  // names, and publishes it **only** when that page is `active_image_id`. It never asks what phase
  // the GM's browser is in. Every test here connects a real player and asserts silence.

  describe("preparing an unpresented page", () => {
    /** The page the party is on, plus one the GM is preparing behind their back. */
    let prepImageId: string;

    beforeEach(() => {
      ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);
      prepImageId = createImageRecord(ts.db, {
        adventureId,
        filename: "cellar.png",
        originalName: "cellar.png",
        width: 100,
        height: 100,
      }).id;
    });

    async function connectGmAnd(player: string) {
      const gm = track(
        await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
      );
      await waitForMessage(gm, "joined");
      const ws = track(
        await connectWS(ts.wsUrl, {
          adventureId,
          role: "player",
          playerLink,
          playerName: player,
          playerColor: "#ff0000",
        })
      );
      await waitForMessage(ws, "joined");
      return { gm, player: ws };
    }

    /** Everything a socket hears from now on, so a test can assert it heard nothing. */
    function record(ws: WebSocket): string[] {
      const heard: string[] = [];
      ws.addEventListener("message", (event) => {
        heard.push(JSON.parse(event.data as string).type);
      });
      return heard;
    }

    /** Long enough for anything the server was going to publish to have arrived. */
    const settle = () => new Promise((r) => setTimeout(r, 120));

    it("a stroke on a page that is not presented is stored and never published", async () => {
      const { gm, player } = await connectGmAnd("Alice");
      const heard = record(player);

      gm.send(
        JSON.stringify({
          type: "fog:stroke",
          imageId: prepImageId,
          stroke: { x: 50, y: 50, radius: 20, mode: "reveal" },
        })
      );
      await settle();

      expect(heard).toEqual([]);
      // Stored, though — the whole point is that it is there when the page is presented.
      await ts.fog.flushAll();
      expect(isRevealed((await loadFogMask(ts.db, prepImageId))!, 50, 50)).toBe(true);
      // And the page on the table is untouched.
      expect(isRevealed((await loadFogMask(ts.db, imageId))!, 50, 50)).toBe(false);
    });

    it("a batch on a page that is not presented is stored and never published", async () => {
      const { gm, player } = await connectGmAnd("Alice");
      const heard = record(player);

      gm.send(
        JSON.stringify({
          type: "fog:stroke:batch",
          imageId: prepImageId,
          strokes: [
            { x: 20, y: 20, radius: 10, mode: "reveal" },
            { x: 60, y: 60, radius: 10, mode: "reveal" },
          ],
        })
      );
      await settle();

      expect(heard).toEqual([]);
      await ts.fog.flushAll();
      const mask = (await loadFogMask(ts.db, prepImageId))!;
      expect(isRevealed(mask, 20, 20)).toBe(true);
      expect(isRevealed(mask, 60, 60)).toBe(true);
    });

    it("painting the presented page still streams to the players", async () => {
      // The other half of the rule. Preparation must not have made the live path conditional on
      // anything the GM's browser believes.
      const { gm, player } = await connectGmAnd("Alice");

      const streamed = waitForMessage(player, "fog:stroke");
      gm.send(
        JSON.stringify({
          type: "fog:stroke",
          imageId,
          stroke: { x: 30, y: 30, radius: 10, mode: "reveal" },
        })
      );
      expect((await streamed).imageId).toBe(imageId);
    });

    it("fog prepared in secret is on the page when it is presented", async () => {
      const { gm, player } = await connectGmAnd("Alice");

      await paint(gm, 50, 50, 20, prepImageId);

      const switched = waitForMessage(player, "map:switched");
      gm.send(JSON.stringify({ type: "map:switch", imageId: prepImageId }));
      const msg = await switched;

      expect(msg.imageId).toBe(prepImageId);
      expect(typeof msg.fogMask).toBe("string");
      // The mask the player is handed is the one the GM prepared, not the untouched blob.
      await ts.fog.flushAll();
      expect(isRevealed((await loadFogMask(ts.db, prepImageId))!, 50, 50)).toBe(true);
    });

    it("undo on the page being prepared leaves the live page's history alone", async () => {
      const { gm, player } = await connectGmAnd("Alice");

      await paint(gm, 50, 50, 8, imageId);
      await paint(gm, 20, 20, 8, prepImageId);

      const heard = record(player);
      await undoOrRedo(gm, "fog:undo", prepImageId);
      await settle();

      // The player saw no reset: the page that was rolled back is not the one on the table.
      expect(heard).toEqual([]);
      expect(isRevealed(await currentMask(prepImageId), 20, 20)).toBe(false);
      expect(isRevealed(await currentMask(imageId), 50, 50)).toBe(true);

      // And the live page's own stack is still exactly one action deep.
      const liveHistory = waitForMessage(gm, "fog:history");
      gm.send(JSON.stringify({ type: "fog:history:query", imageId }));
      expect(await liveHistory).toMatchObject({ imageId, canUndo: true, canRedo: false });
    });

    it("undoing the live page still reaches the players", async () => {
      const { gm, player } = await connectGmAnd("Alice");
      await paint(gm, 50, 50, 8, imageId);

      const reset = waitForMessage(player, "fog:reset");
      gm.send(JSON.stringify({ type: "fog:undo", imageId }));
      expect((await reset).imageId).toBe(imageId);
    });

    it("fog:history:query answers for a page with no history without loading its mask", async () => {
      const { gm } = await connectGmAnd("Alice");

      const history = waitForMessage(gm, "fog:history");
      gm.send(JSON.stringify({ type: "fog:history:query", imageId: prepImageId }));
      expect(await history).toMatchObject({
        imageId: prepImageId,
        canUndo: false,
        canRedo: false,
      });
      // Asking about a page must not make it resident — the board asks on every selection.
      expect(ts.fog.forAdventure(adventureId).peek(prepImageId)).toBeUndefined();
    });

    it("a monster prepared on an unpresented page reaches nobody, and is waiting when it is presented", async () => {
      const { gm, player } = await connectGmAnd("Alice");
      const heard = record(player);

      const added = waitForMessage(gm, "gm_token:added");
      gm.send(
        JSON.stringify({
          type: "gm_token:place",
          imageId: prepImageId,
          name: "Ogre",
          tokenType: "monster",
          x: 40,
          y: 40,
        })
      );
      const placed = (await added).token;
      expect(placed.image_id).toBe(prepImageId);
      await settle();
      expect(heard).toEqual([]);

      const switched = waitForMessage(player, "map:switched");
      gm.send(JSON.stringify({ type: "map:switch", imageId: prepImageId }));
      expect((await switched).gmTokens.map((t: any) => t.name)).toEqual(["Ogre"]);
    });

    it("placing a monster on the presented page still reaches the players", async () => {
      const { gm, player } = await connectGmAnd("Alice");

      const added = waitForMessage(player, "gm_token:added");
      gm.send(
        JSON.stringify({
          type: "gm_token:place",
          imageId,
          name: "Goblin",
          tokenType: "monster",
          x: 10,
          y: 10,
        })
      );
      expect((await added).token.name).toBe("Goblin");
    });

    it("moving and removing a monster on an unpresented page is silent too", async () => {
      const { gm, player } = await connectGmAnd("Alice");

      const added = waitForMessage(gm, "gm_token:added");
      gm.send(
        JSON.stringify({
          type: "gm_token:place",
          imageId: prepImageId,
          name: "Ogre",
          tokenType: "monster",
          x: 40,
          y: 40,
        })
      );
      const tokenId = (await added).token.id;

      const heard = record(player);
      gm.send(JSON.stringify({ type: "token:move", tokenId, x: 70, y: 70 }));
      gm.send(JSON.stringify({ type: "gm_token:remove", tokenId }));
      await settle();

      expect(heard).toEqual([]);
      expect(getTokensByAdventure(ts.db, adventureId).find((t) => t.id === tokenId)).toBeUndefined();
    });

    it("a monster on an unpresented page never writes the party's remembered positions", async () => {
      // `token:move` is the only writer of `token_positions`, and a remembered position means a
      // token *walked* there (#46). A monster dragged during prep is neither a walk nor on the
      // live page, so it must not leave a row keyed by whatever happens to be presented.
      const { gm } = await connectGmAnd("Alice");

      const added = waitForMessage(gm, "gm_token:added");
      gm.send(
        JSON.stringify({
          type: "gm_token:place",
          imageId: prepImageId,
          name: "Ogre",
          tokenType: "monster",
          x: 40,
          y: 40,
        })
      );
      const tokenId = (await added).token.id;

      const moved = waitForMessage(gm, "token:moved");
      gm.send(JSON.stringify({ type: "token:move", tokenId, x: 70, y: 70 }));
      await moved;

      const rows = ts.db
        .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM token_positions`)
        .get()!;
      expect(rows.n).toBe(0);
    });

    it("renaming a monster on an unpresented page is stored and reaches nobody", async () => {
      const { gm, player } = await connectGmAnd("Alice");

      const added = waitForMessage(gm, "gm_token:added");
      gm.send(
        JSON.stringify({
          type: "gm_token:place",
          imageId: prepImageId,
          name: "Ork",
          tokenType: "monster",
          x: 40,
          y: 40,
        })
      );
      const tokenId = (await added).token.id;

      const heard = record(player);
      const renamed = waitForMessage(gm, "token:renamed");
      gm.send(JSON.stringify({ type: "gm_token:rename", tokenId, name: "Ork 2" }));
      expect((await renamed).name).toBe("Ork 2");
      await settle();

      expect(heard).toEqual([]);
      expect(getTokensByAdventure(ts.db, adventureId).find((t) => t.id === tokenId)?.name)
        .toBe("Ork 2");
    });

    it("renaming a monster on the presented page reaches the party", async () => {
      const { gm, player } = await connectGmAnd("Alice");

      const added = waitForMessage(gm, "gm_token:added");
      gm.send(
        JSON.stringify({
          type: "gm_token:place",
          imageId,
          name: "Ork",
          tokenType: "monster",
          x: 40,
          y: 40,
        })
      );
      const tokenId = (await added).token.id;

      const seen = waitForMessage(player, "token:renamed");
      gm.send(JSON.stringify({ type: "gm_token:rename", tokenId, name: "Ork 2" }));
      const msg = await seen;
      expect(msg.tokenId).toBe(tokenId);
      expect(msg.name).toBe("Ork 2");
    });

    it("a player token is never renamed, and a player never renames anything", async () => {
      // The name is half of `playerLink|playerName`, which is how a player reconnects. Renaming
      // one leaves a token its owner can no longer rejoin, so the message refuses it outright.
      const { gm, player } = await connectGmAnd("Alice");
      const alice = getTokensByAdventure(ts.db, adventureId).find(
        (t) => t.token_type === "player"
      )!;

      const refusedForPlayerToken = waitForMessage(gm, "error");
      gm.send(JSON.stringify({ type: "gm_token:rename", tokenId: alice.id, name: "Bob" }));
      await refusedForPlayerToken;
      expect(getTokensByAdventure(ts.db, adventureId).find((t) => t.id === alice.id)?.name)
        .toBe("Alice");

      const added = waitForMessage(gm, "gm_token:added");
      gm.send(
        JSON.stringify({
          type: "gm_token:place",
          imageId,
          name: "Ork",
          tokenType: "monster",
          x: 40,
          y: 40,
        })
      );
      const tokenId = (await added).token.id;

      const refusedForPlayer = waitForMessage(player, "error");
      player.send(JSON.stringify({ type: "gm_token:rename", tokenId, name: "Kitten" }));
      await refusedForPlayer;
      expect(getTokensByAdventure(ts.db, adventureId).find((t) => t.id === tokenId)?.name)
        .toBe("Ork");
    });

    it("a name is trimmed, capped, and never blank", async () => {
      // Principle 9: the first client-supplied string this handler stores.
      const { gm } = await connectGmAnd("Alice");

      const added = waitForMessage(gm, "gm_token:added");
      gm.send(
        JSON.stringify({
          type: "gm_token:place",
          imageId,
          name: "Ork",
          tokenType: "monster",
          x: 40,
          y: 40,
        })
      );
      const tokenId = (await added).token.id;

      const trimmed = waitForMessage(gm, "token:renamed");
      gm.send(JSON.stringify({ type: "gm_token:rename", tokenId, name: "   Ork 2   " }));
      expect((await trimmed).name).toBe("Ork 2");

      const capped = waitForMessage(gm, "token:renamed");
      gm.send(JSON.stringify({ type: "gm_token:rename", tokenId, name: "o".repeat(200) }));
      expect((await capped).name).toHaveLength(40);

      const refused = waitForMessage(gm, "error");
      gm.send(JSON.stringify({ type: "gm_token:rename", tokenId, name: "   " }));
      await refused;
      expect(getTokensByAdventure(ts.db, adventureId).find((t) => t.id === tokenId)?.name)
        .toHaveLength(40);
    });

    it("a token is placed alive, and the GM can mark it down and back up", async () => {
      const { gm } = await connectGmAnd("Alice");

      const added = waitForMessage(gm, "gm_token:added");
      gm.send(
        JSON.stringify({
          type: "gm_token:place",
          imageId,
          name: "Ork",
          tokenType: "monster",
          x: 40,
          y: 40,
        })
      );
      const placed = (await added).token;
      // Nobody set this, and that is the point: a token placed today is alive.
      expect(placed.state).toBe("alive");

      const down = waitForMessage(gm, "token:state:set");
      gm.send(JSON.stringify({ type: "gm_token:state", tokenId: placed.id, state: "dead" }));
      expect((await down).state).toBe("dead");

      const up = waitForMessage(gm, "token:state:set");
      gm.send(JSON.stringify({ type: "gm_token:state", tokenId: placed.id, state: "alive" }));
      await up;
      expect(getTokensByAdventure(ts.db, adventureId).find((t) => t.id === placed.id)?.state)
        .toBe("alive");
    });

    it("a monster marked on the presented page reaches the party", async () => {
      const { gm, player } = await connectGmAnd("Alice");

      const added = waitForMessage(gm, "gm_token:added");
      gm.send(
        JSON.stringify({
          type: "gm_token:place",
          imageId,
          name: "Ork",
          tokenType: "monster",
          x: 40,
          y: 40,
        })
      );
      const tokenId = (await added).token.id;

      const seen = waitForMessage(player, "token:state:set");
      gm.send(JSON.stringify({ type: "gm_token:state", tokenId, state: "unconscious" }));
      const msg = await seen;
      expect(msg.tokenId).toBe(tokenId);
      expect(msg.state).toBe("unconscious");
    });

    it("marking a monster on an unpresented page is stored and reaches nobody", async () => {
      const { gm, player } = await connectGmAnd("Alice");

      const added = waitForMessage(gm, "gm_token:added");
      gm.send(
        JSON.stringify({
          type: "gm_token:place",
          imageId: prepImageId,
          name: "Ork",
          tokenType: "monster",
          x: 40,
          y: 40,
        })
      );
      const tokenId = (await added).token.id;

      const heard = record(player);
      const marked = waitForMessage(gm, "token:state:set");
      gm.send(JSON.stringify({ type: "gm_token:state", tokenId, state: "dead" }));
      await marked;
      await settle();

      expect(heard).toEqual([]);
      expect(getTokensByAdventure(ts.db, adventureId).find((t) => t.id === tokenId)?.state)
        .toBe("dead");
    });

    it("the GM marks a player token; the player marks nothing, not even their own", async () => {
      // The opposite of rename, and deliberately: a player does not adjudicate their own
      // unconsciousness, so the GM is the only writer of every token's state.
      const { gm, player } = await connectGmAnd("Alice");
      const alice = getTokensByAdventure(ts.db, adventureId).find(
        (t) => t.token_type === "player"
      )!;

      // A player token has no image, so it is always on the presented page.
      const seen = waitForMessage(player, "token:state:set");
      gm.send(JSON.stringify({ type: "gm_token:state", tokenId: alice.id, state: "unconscious" }));
      expect((await seen).state).toBe("unconscious");
      expect(getTokensByAdventure(ts.db, adventureId).find((t) => t.id === alice.id)?.state)
        .toBe("unconscious");

      const refused = waitForMessage(player, "error");
      player.send(JSON.stringify({ type: "gm_token:state", tokenId: alice.id, state: "alive" }));
      await refused;
      expect(getTokensByAdventure(ts.db, adventureId).find((t) => t.id === alice.id)?.state)
        .toBe("unconscious");
    });

    it("a state outside the three is refused", async () => {
      const { gm } = await connectGmAnd("Alice");
      const alice = getTokensByAdventure(ts.db, adventureId).find(
        (t) => t.token_type === "player"
      )!;

      const refused = waitForMessage(gm, "error");
      gm.send(JSON.stringify({ type: "gm_token:state", tokenId: alice.id, state: "poisoned" }));
      await refused;
      expect(getTokensByAdventure(ts.db, adventureId).find((t) => t.id === alice.id)?.state)
        .toBe("alive");
    });

    it("a page belonging to another adventure cannot be painted", async () => {
      const other = createAdventure(ts.db, { name: "Other table", gmPassword: "other-pw" });
      const theirPage = createImageRecord(ts.db, {
        adventureId: other.id,
        filename: "theirs.png",
        originalName: "theirs.png",
        width: 100,
        height: 100,
      }).id;

      const { gm } = await connectGmAnd("Alice");
      const err = waitForMessage(gm, "error");
      gm.send(
        JSON.stringify({
          type: "fog:stroke",
          imageId: theirPage,
          stroke: { x: 50, y: 50, radius: 20, mode: "reveal" },
        })
      );
      expect((await err).message).toContain("page");
      expect(await loadFogMask(ts.db, theirPage)).toBeNull();
    });

    it("the fog route serves what the GM just painted, ahead of the debounced save", async () => {
      // `GET .../fog` used to read `images.fog_mask` straight from the table. That was only correct
      // while nothing could write fog to an unpresented page; now the board would show the GM their
      // own work rolled back to the last save.
      const { gm } = await connectGmAnd("Alice");
      await paint(gm, 50, 50, 20, prepImageId);

      // Deliberately *not* flushed: the blob is still empty at this point.
      expect(await loadFogMask(ts.db, prepImageId)).toBeNull();

      const res = await fetch(
        `${ts.url}/api/adventures/${adventureId}/images/${prepImageId}/fog`,
        { headers: { "X-GM-Password": gmPassword } }
      );
      expect((await res.json()).fogMask).toBe(
        await ts.fog.forAdventure(adventureId).peek(prepImageId)!.toBase64()
      );
    });

    it("the tokens route serves the monsters standing on one page, and only those", async () => {
      const { gm } = await connectGmAnd("Alice");

      for (const [page, name] of [[prepImageId, "Ogre"], [imageId, "Goblin"]] as const) {
        const added = waitForMessage(gm, "gm_token:added");
        gm.send(
          JSON.stringify({
            type: "gm_token:place",
            imageId: page,
            name,
            tokenType: "monster",
            x: 10,
            y: 10,
          })
        );
        await added;
      }

      const res = await fetch(
        `${ts.url}/api/adventures/${adventureId}/images/${prepImageId}/tokens`,
        { headers: { "X-GM-Password": gmPassword } }
      );
      const tokens = await res.json();
      // The party is not on a page in preparation, so no player token is in here either.
      expect(tokens.map((t: any) => t.name)).toEqual(["Ogre"]);
    });

    it("the tokens route is GM-only", async () => {
      const res = await fetch(
        `${ts.url}/api/adventures/${adventureId}/images/${prepImageId}/tokens`,
        { headers: { "X-Player-Link": playerLink } }
      );
      expect(res.status).toBe(401);
    });
  });

  // ---- Map switch repositioning ----

  async function connectGmAndPlayer(name = "Alice") {
    const gm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(gm, "joined");
    const player = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: name,
        playerColor: "#ff0000",
      })
    );
    const joined = await waitForMessage(player, "joined");
    const tokenId = joined.tokens.find((t: any) => t.name === name).id;
    return { gm, player, tokenId };
  }

  it("Map switch to a smaller map never strands a token off-canvas", async () => {
    const small = createImageRecord(ts.db, {
      adventureId,
      filename: "small.png",
      originalName: "small.png",
      width: 40,
      height: 40,
    });
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const { gm, tokenId } = await connectGmAndPlayer();

    // Park the token near the far corner of the 100x100 map.
    ts.db.run(`UPDATE tokens SET x = 95, y = 95 WHERE id = ?`, [tokenId]);

    const switched = waitForMessage(gm, "map:switched");
    gm.send(JSON.stringify({ type: "map:switch", imageId: small.id }));
    const msg = await switched;

    expect(Array.isArray(msg.playerTokens)).toBe(true);
    const broadcast = msg.playerTokens.find((t: any) => t.id === tokenId);
    expect(broadcast).toBeDefined();

    const token = getTokensByAdventure(ts.db, adventureId).find((t) => t.id === tokenId)!;
    expect(token.x).toBeLessThanOrEqual(40);
    expect(token.y).toBeLessThanOrEqual(40);
    expect(token.x).toBeGreaterThanOrEqual(0);
    expect(token.y).toBeGreaterThanOrEqual(0);
    expect(broadcast.x).toBe(token.x);
    expect(broadcast.y).toBe(token.y);
  });

  it("Party lands on the GM's start point when one is set", async () => {
    const next = createImageRecord(ts.db, {
      adventureId,
      filename: "next.png",
      originalName: "next.png",
      width: 200,
      height: 200,
    });
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const { gm, tokenId } = await connectGmAndPlayer();

    const setAck = waitForMessage(gm, "map:start_point:set");
    gm.send(JSON.stringify({ type: "map:start_point", imageId: next.id, x: 150, y: 60 }));
    const ack = await setAck;
    expect(ack.x).toBe(150);
    expect(ack.y).toBe(60);

    const switched = waitForMessage(gm, "map:switched");
    gm.send(JSON.stringify({ type: "map:switch", imageId: next.id }));
    await switched;

    // Placed around the point, not on it, so the marker stays visible.
    const token = getTokensByAdventure(ts.db, adventureId).find((t) => t.id === tokenId)!;
    const dist = Math.hypot(token.x - 150, token.y - 60);
    expect(dist).toBeGreaterThan(0);
    expect(dist).toBeLessThan(100);
  });

  it("Switching away and back restores where each player was standing", async () => {
    const second = createImageRecord(ts.db, {
      adventureId,
      filename: "second.png",
      originalName: "second.png",
      width: 300,
      height: 300,
    });
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const { gm, player, tokenId } = await connectGmAndPlayer();

    // The player walks to a corner of the first map.
    const moved = waitForMessage(gm, "token:moved");
    player.send(JSON.stringify({ type: "token:move", tokenId, x: 12, y: 88 }));
    await moved;

    // Away to another map...
    let switched = waitForMessage(gm, "map:switched");
    gm.send(JSON.stringify({ type: "map:switch", imageId: second.id }));
    await switched;
    const away = getTokensByAdventure(ts.db, adventureId).find((t) => t.id === tokenId)!;
    expect(away.x).not.toBe(12);

    // ...and back. The player should be where they left off, not at the start.
    switched = waitForMessage(gm, "map:switched");
    gm.send(JSON.stringify({ type: "map:switch", imageId }));
    await switched;

    const back = getTokensByAdventure(ts.db, adventureId).find((t) => t.id === tokenId)!;
    expect(back.x).toBe(12);
    expect(back.y).toBe(88);
  });

  it("Returning to a map that shrank keeps the remembered position in bounds", async () => {
    const small = createImageRecord(ts.db, {
      adventureId,
      filename: "tiny.png",
      originalName: "tiny.png",
      width: 30,
      height: 30,
    });
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [small.id, adventureId]);

    const { gm, tokenId } = await connectGmAndPlayer();
    // Remember an out-of-bounds position directly, as a larger map would have.
    ts.db.run(
      `INSERT OR REPLACE INTO token_positions (token_id, image_id, x, y) VALUES (?, ?, 900, 900)`,
      [tokenId, small.id]
    );
    ts.db.run(`UPDATE adventures SET active_image_id = NULL WHERE id = ?`, [adventureId]);

    const switched = waitForMessage(gm, "map:switched");
    gm.send(JSON.stringify({ type: "map:switch", imageId: small.id }));
    await switched;

    const token = getTokensByAdventure(ts.db, adventureId).find((t) => t.id === tokenId)!;
    expect(token.x).toBeLessThanOrEqual(30);
    expect(token.y).toBeLessThanOrEqual(30);
  });

  it("Re-activating the map already active leaves tokens where they are", async () => {
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);
    const { gm, tokenId } = await connectGmAndPlayer();

    ts.db.run(`UPDATE tokens SET x = 33, y = 44 WHERE id = ?`, [tokenId]);

    const switched = waitForMessage(gm, "map:switched");
    gm.send(JSON.stringify({ type: "map:switch", imageId }));
    await switched;

    const token = getTokensByAdventure(ts.db, adventureId).find((t) => t.id === tokenId)!;
    expect(token.x).toBe(33);
    expect(token.y).toBe(44);
  });

  it("Start point can be set on a map that is not active, and cleared", async () => {
    const other = createImageRecord(ts.db, {
      adventureId,
      filename: "other.png",
      originalName: "other.png",
      width: 200,
      height: 200,
    });
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const { gm, tokenId } = await connectGmAndPlayer();

    // Set on the inactive map — the active map must not change.
    let ack = waitForMessage(gm, "map:start_point:set");
    gm.send(JSON.stringify({ type: "map:start_point", imageId: other.id, x: 20, y: 30 }));
    await ack;
    expect(getAdventure(ts.db, adventureId)!.active_image_id).toBe(imageId);

    // Clearing restores the map-centre fallback.
    ack = waitForMessage(gm, "map:start_point:set");
    gm.send(JSON.stringify({ type: "map:start_point", imageId: other.id, x: null, y: null }));
    const cleared = await ack;
    expect(cleared.x).toBeNull();
    expect(cleared.y).toBeNull();

    const switched = waitForMessage(gm, "map:switched");
    gm.send(JSON.stringify({ type: "map:switch", imageId: other.id }));
    await switched;

    const token = getTokensByAdventure(ts.db, adventureId).find((t) => t.id === tokenId)!;
    expect(Math.hypot(token.x - 100, token.y - 100)).toBeLessThan(100);
  });

  it("A late joiner lands at the start point, not beside the party", async () => {
    ts.db.run(`UPDATE images SET start_x = 20, start_y = 20 WHERE id = ?`, [imageId]);
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const gm = await connectGm();

    // An established party, far from the entrance.
    const first = track(
      await connectWS(ts.wsUrl, {
        adventureId, role: "player", playerLink,
        playerName: "Darian", playerColor: "#ff0000",
      })
    );
    const firstJoined = await waitForMessage(first, "joined");
    const firstId = firstJoined.tokens.find((t: any) => t.name === "Darian").id;
    const moved = waitForMessage(gm, "token:moved");
    first.send(JSON.stringify({ type: "token:move", tokenId: firstId, x: 90, y: 90 }));
    await moved;

    // Latecomer arrives.
    const late = track(
      await connectWS(ts.wsUrl, {
        adventureId, role: "player", playerLink,
        playerName: "Icegrimm", playerColor: "#00ff00",
      })
    );
    const lateJoined = await waitForMessage(late, "joined");
    const lateId = lateJoined.tokens.find((t: any) => t.name === "Icegrimm").id;

    const token = getTokensByAdventure(ts.db, adventureId).find((t) => t.id === lateId)!;
    // Near the entrance, and nowhere near the party in the far corner.
    expect(Math.hypot(token.x - 20, token.y - 20)).toBeLessThan(60);
    expect(Math.hypot(token.x - 90, token.y - 90)).toBeGreaterThan(40);
  });

  // Inverts the assertion this test carried before #57. It used to expect the flag to override a
  // recorded position, which #39 added to compensate for #46 — arrival being recorded as a return.
  // With that defect gone, a recorded position means the player genuinely walked there, and the
  // documented promise applies: the flag governs first entry, walking governs return.
  it("Moving the start point does not forget where the party walked", async () => {
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);
    const { gm, player, tokenId } = await connectGmAndPlayer();

    const moved = waitForMessage(gm, "token:moved");
    player.send(JSON.stringify({ type: "token:move", tokenId, x: 95, y: 95 }));
    await moved;

    const ack = waitForMessage(gm, "map:start_point:set");
    gm.send(JSON.stringify({ type: "map:start_point", imageId, x: 15, y: 15 }));
    await ack;

    const other = createImageRecord(ts.db, {
      adventureId, filename: "o.png", originalName: "o.png", width: 100, height: 100,
    });
    let switched = waitForMessage(gm, "map:switched");
    gm.send(JSON.stringify({ type: "map:switch", imageId: other.id }));
    await switched;
    switched = waitForMessage(gm, "map:switched");
    gm.send(JSON.stringify({ type: "map:switch", imageId }));
    await switched;

    const token = getTokensByAdventure(ts.db, adventureId).find((t) => t.id === tokenId)!;
    expect(token.x).toBe(95);
    expect(token.y).toBe(95);
  });

  // #46: the GM prepares a map alone, then brings the party there in play.
  it("Opening a map alone during preparation does not consume its start point", async () => {
    const prepared = createImageRecord(ts.db, {
      adventureId, filename: "prep.png", originalName: "prep.png", width: 200, height: 200,
    });
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);
    const { gm, tokenId } = await connectGmAndPlayer();

    const ack = waitForMessage(gm, "map:start_point:set");
    gm.send(JSON.stringify({ type: "map:start_point", imageId: prepared.id, x: 150, y: 60 }));
    await ack;

    // The GM visits it alone to paint, then goes back to where the party is.
    let switched = waitForMessage(gm, "map:switched");
    gm.send(JSON.stringify({ type: "map:switch", imageId: prepared.id }));
    await switched;
    switched = waitForMessage(gm, "map:switched");
    gm.send(JSON.stringify({ type: "map:switch", imageId }));
    await switched;

    // Now the party arrives for real. Before #57 they landed wherever the GM's solo visit put them.
    switched = waitForMessage(gm, "map:switched");
    gm.send(JSON.stringify({ type: "map:switch", imageId: prepared.id }));
    await switched;

    const token = getTokensByAdventure(ts.db, adventureId).find((t) => t.id === tokenId)!;
    expect(Math.hypot(token.x - 150, token.y - 60)).toBeLessThan(60);
  });

  // Found while verifying #57: a spawn is an arrival, so remembering it made a player who joined
  // on a map return to their spawn on every later visit instead of arriving on its flag.
  it("A player who joins on a map still arrives on its flag when brought back", async () => {
    const other = createImageRecord(ts.db, {
      adventureId, filename: "other.png", originalName: "other.png", width: 200, height: 200,
    });
    ts.db.run(`UPDATE images SET start_x = 20, start_y = 20 WHERE id = ?`, [imageId]);
    ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);

    const { gm, tokenId } = await connectGmAndPlayer();

    // Away and back, with nobody walking anywhere.
    let switched = waitForMessage(gm, "map:switched");
    gm.send(JSON.stringify({ type: "map:switch", imageId: other.id }));
    await switched;
    switched = waitForMessage(gm, "map:switched");
    gm.send(JSON.stringify({ type: "map:switch", imageId }));
    await switched;

    const token = getTokensByAdventure(ts.db, adventureId).find((t) => t.id === tokenId)!;
    expect(Math.hypot(token.x - 20, token.y - 20)).toBeLessThan(60);
  });

  it("A locked start point cannot be moved", async () => {
    const { gm } = await connectGmAndPlayer();

    let ack = waitForMessage(gm, "map:start_point:set");
    gm.send(JSON.stringify({ type: "map:start_point", imageId, x: 30, y: 40 }));
    expect((await ack).locked).toBe(false);

    ack = waitForMessage(gm, "map:start_point:set");
    gm.send(JSON.stringify({ type: "map:start_point:lock", imageId, locked: true }));
    const locked = await ack;
    expect(locked.locked).toBe(true);
    // The lock carries the point with it, so one message is the whole state.
    expect(locked.x).toBe(30);
    expect(locked.y).toBe(40);

    const errPromise = waitForMessage(gm, "error");
    gm.send(JSON.stringify({ type: "map:start_point", imageId, x: 90, y: 90 }));
    expect((await errPromise).message).toContain("locked");

    const image = ts.db
      .query<{ start_x: number; start_y: number }, string>(
        `SELECT start_x, start_y FROM images WHERE id = ?`
      )
      .get(imageId)!;
    expect(image.start_x).toBe(30);
    expect(image.start_y).toBe(40);
  });

  it("Start point updates sync to every GM socket, and never to players", async () => {
    const firstGm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(firstGm, "joined");
    const secondGm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(secondGm, "joined");
    const player = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Bob",
        playerColor: "#00ff00",
      })
    );
    await waitForMessage(player, "joined");

    const firstMoved = waitForMessage(firstGm, "map:start_point:set");
    const secondMoved = waitForMessage(secondGm, "map:start_point:set");
    const playerSawMove = waitForMessage(player, "map:start_point:set", 150).then(
      () => true,
      () => false
    );
    firstGm.send(JSON.stringify({ type: "map:start_point", imageId, x: 30, y: 40 }));

    expect((await firstMoved).x).toBe(30);
    const movedOnSecondGm = await secondMoved;
    expect(movedOnSecondGm.x).toBe(30);
    expect(movedOnSecondGm.y).toBe(40);
    expect(await playerSawMove).toBe(false);

    const firstLocked = waitForMessage(firstGm, "map:start_point:set");
    const secondLocked = waitForMessage(secondGm, "map:start_point:set");
    const playerSawLock = waitForMessage(player, "map:start_point:set", 150).then(
      () => true,
      () => false
    );
    secondGm.send(JSON.stringify({ type: "map:start_point:lock", imageId, locked: true }));

    expect((await firstLocked).locked).toBe(true);
    const lockedOnSecondGm = await secondLocked;
    expect(lockedOnSecondGm.locked).toBe(true);
    expect(lockedOnSecondGm.x).toBe(30);
    expect(lockedOnSecondGm.y).toBe(40);
    expect(await playerSawLock).toBe(false);
  });

  it("Unlocking lets the start point move again", async () => {
    const { gm } = await connectGmAndPlayer();

    let ack = waitForMessage(gm, "map:start_point:set");
    gm.send(JSON.stringify({ type: "map:start_point:lock", imageId, locked: true }));
    await ack;

    ack = waitForMessage(gm, "map:start_point:set");
    gm.send(JSON.stringify({ type: "map:start_point:lock", imageId, locked: false }));
    expect((await ack).locked).toBe(false);

    ack = waitForMessage(gm, "map:start_point:set");
    gm.send(JSON.stringify({ type: "map:start_point", imageId, x: 55, y: 65 }));
    const moved = await ack;
    expect(moved.x).toBe(55);
    expect(moved.y).toBe(65);
  });

  it("Player cannot lock a start point", async () => {
    const player = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Bob",
        playerColor: "#00ff00",
      })
    );
    await waitForMessage(player, "joined");

    const errPromise = waitForMessage(player, "error");
    player.send(JSON.stringify({ type: "map:start_point:lock", imageId, locked: true }));
    expect((await errPromise).message).toContain("GM");
  });

  it("Player cannot set a start point", async () => {
    const player = track(
      await connectWS(ts.wsUrl, {
        adventureId,
        role: "player",
        playerLink,
        playerName: "Bob",
        playerColor: "#00ff00",
      })
    );
    await waitForMessage(player, "joined");

    const errPromise = waitForMessage(player, "error");
    player.send(JSON.stringify({ type: "map:start_point", imageId, x: 10, y: 10 }));
    const err = await errPromise;
    expect(err.message).toContain("GM");
  });

  // ---- Declaring an attack (#72) ----
  //
  // The first thing a *player* writes that is not their own token position, so every test here is
  // as much about who may write as about what is written. The attacker is never on the wire: the
  // server reads it off the connection, which is why "a player forging someone else's source" is
  // not a test — there is no field to put it in.

  describe("declarations", () => {
    let monsterId: string;
    let prepImageId: string;

    beforeEach(() => {
      ts.db.run(`UPDATE adventures SET active_image_id = ? WHERE id = ?`, [imageId, adventureId]);
      prepImageId = createImageRecord(ts.db, {
        adventureId,
        filename: "cellar.png",
        originalName: "cellar.png",
        width: 100,
        height: 100,
      }).id;
    });

    async function connectGm() {
      const gm = track(await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword }));
      await waitForMessage(gm, "joined");
      return gm;
    }

    async function connectPlayer(name: string) {
      const ws = track(
        await connectWS(ts.wsUrl, {
          adventureId,
          role: "player",
          playerLink,
          playerName: name,
          playerColor: "#ff0000",
        })
      );
      const joined = await waitForMessage(ws, "joined");
      return { ws, tokenId: joined.yourTokenId as string };
    }

    /** A monster on the presented page, which is what the party is allowed to attack. */
    async function placeMonster(gm: WebSocket, name = "Ork", page = imageId) {
      const added = waitForMessage(gm, "gm_token:added");
      gm.send(
        JSON.stringify({ type: "gm_token:place", imageId: page, name, tokenType: "monster", x: 40, y: 40 })
      );
      return (await added).token.id as string;
    }

    it("a player declares on a monster, and the whole table sees it", async () => {
      const gm = await connectGm();
      monsterId = await placeMonster(gm);
      const alice = await connectPlayer("Alice");

      const mine = waitForMessage(alice.ws, "declaration:opened");
      const theirs = waitForMessage(gm, "declaration:opened");
      alice.ws.send(JSON.stringify({ type: "declaration:open", targetId: monsterId }));

      const declaration = (await mine).declaration;
      expect(declaration.source_id).toBe(alice.tokenId);
      expect(declaration.target_id).toBe(monsterId);
      expect(declaration.state).toBe("open");
      expect(declaration.image_id).toBe(imageId);
      expect((await theirs).declaration.id).toBe(declaration.id);
    });

    it("the GM declares on a player token, and names no monster to do it", async () => {
      const gm = await connectGm();
      const alice = await connectPlayer("Alice");

      const seen = waitForMessage(alice.ws, "declaration:opened");
      gm.send(JSON.stringify({ type: "declaration:open", targetId: alice.tokenId }));

      const declaration = (await seen).declaration;
      // Sourceless is what makes it the GM's, and it is the only thing that says so.
      expect(declaration.source_id).toBeNull();
      expect(declaration.target_id).toBe(alice.tokenId);
    });

    it("a player cannot attack another player, and the GM cannot attack a monster", async () => {
      const gm = await connectGm();
      monsterId = await placeMonster(gm);
      const alice = await connectPlayer("Alice");
      const bob = await connectPlayer("Bob");

      const refused = waitForMessage(alice.ws, "error");
      alice.ws.send(JSON.stringify({ type: "declaration:open", targetId: bob.tokenId }));
      await refused;

      const refusedGm = waitForMessage(gm, "error");
      gm.send(JSON.stringify({ type: "declaration:open", targetId: monsterId }));
      await refusedGm;

      expect(getDeclarationsByImage(ts.db, imageId)).toEqual([]);
    });

    it("a second attack is a second attack, on another token or on the same one", async () => {
      const gm = await connectGm();
      const first = await placeMonster(gm, "Ork 1");
      const second = await placeMonster(gm, "Ork 2");
      const alice = await connectPlayer("Alice");

      for (const target of [first, second, first]) {
        const opened = waitForMessage(gm, "declaration:opened");
        alice.ws.send(JSON.stringify({ type: "declaration:open", targetId: target }));
        await opened;
      }
      // Nothing was replaced and nothing was refused: two weapons on one orc is two attacks, and
      // how many a round holds is the table's to count, not this tool's.
      const rows = getDeclarationsByImage(ts.db, imageId);
      expect(rows).toHaveLength(3);
      expect(rows.filter((d) => d.target_id === first)).toHaveLength(2);
    });

    it("two monsters attack one player, and both are answered", async () => {
      const gm = await connectGm();
      const alice = await connectPlayer("Alice");

      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const opened = waitForMessage(alice.ws, "declaration:opened");
        gm.send(JSON.stringify({ type: "declaration:open", targetId: alice.tokenId }));
        ids.push((await opened).declaration.id);
      }
      expect(getDeclarationsByImage(ts.db, imageId)).toHaveLength(2);

      // Answered one at a time and independently — one parried, one through.
      const parried = waitForMessage(gm, "declaration:updated");
      alice.ws.send(JSON.stringify({ type: "declaration:answer", declarationId: ids[0], parried: true }));
      await parried;
      const through = waitForMessage(gm, "declaration:updated");
      alice.ws.send(JSON.stringify({ type: "declaration:answer", declarationId: ids[1], parried: false }));
      await through;

      expect(getDeclaration(ts.db, ids[0]!)!.state).toBe("parried");
      expect(getDeclaration(ts.db, ids[1]!)!.state).toBe("not_parried");
    });

    it("only the one who declared can retract it", async () => {
      const gm = await connectGm();
      monsterId = await placeMonster(gm);
      const alice = await connectPlayer("Alice");
      const bob = await connectPlayer("Bob");

      const opened = waitForMessage(alice.ws, "declaration:opened");
      alice.ws.send(JSON.stringify({ type: "declaration:open", targetId: monsterId }));
      const declarationId = (await opened).declaration.id;

      const bobRefused = waitForMessage(bob.ws, "error");
      bob.ws.send(JSON.stringify({ type: "declaration:retract", declarationId }));
      await bobRefused;

      // Not even the GM: the GM's own are the sourceless ones.
      const gmRefused = waitForMessage(gm, "error");
      gm.send(JSON.stringify({ type: "declaration:retract", declarationId }));
      await gmRefused;
      expect(getDeclarationsByImage(ts.db, imageId)).toHaveLength(1);

      const gone = waitForMessage(gm, "declaration:retracted");
      alice.ws.send(JSON.stringify({ type: "declaration:retract", declarationId }));
      expect((await gone).declarationId).toBe(declarationId);
      expect(getDeclarationsByImage(ts.db, imageId)).toEqual([]);
    });

    it("a player cannot retract the GM's declaration on them", async () => {
      const gm = await connectGm();
      const alice = await connectPlayer("Alice");

      const opened = waitForMessage(alice.ws, "declaration:opened");
      gm.send(JSON.stringify({ type: "declaration:open", targetId: alice.tokenId }));
      const declarationId = (await opened).declaration.id;

      const refused = waitForMessage(alice.ws, "error");
      alice.ws.send(JSON.stringify({ type: "declaration:retract", declarationId }));
      await refused;
      expect(getDeclarationsByImage(ts.db, imageId)).toHaveLength(1);
    });

    it("a declaration is waiting after a reload", async () => {
      const gm = await connectGm();
      monsterId = await placeMonster(gm);
      const alice = await connectPlayer("Alice");

      const opened = waitForMessage(alice.ws, "declaration:opened");
      alice.ws.send(JSON.stringify({ type: "declaration:open", targetId: monsterId }));
      const declarationId = (await opened).declaration.id;

      // The reload: same player, same link, a new socket. What they are told on arrival is the
      // only thing that can put the fight back on their screen.
      await closeWs(alice.ws);
      const again = track(
        await connectWS(ts.wsUrl, {
          adventureId, role: "player", playerLink, playerName: "Alice", playerColor: "#ff0000",
        })
      );
      const joined = await waitForMessage(again, "joined");
      expect(joined.declarations.map((d: any) => d.id)).toEqual([declarationId]);
    });

    it("a page switch hides the fight, and coming back shows it again", async () => {
      const gm = await connectGm();
      monsterId = await placeMonster(gm);
      const alice = await connectPlayer("Alice");

      const opened = waitForMessage(alice.ws, "declaration:opened");
      alice.ws.send(JSON.stringify({ type: "declaration:open", targetId: monsterId }));
      const declarationId = (await opened).declaration.id;

      const away = waitForMessage(alice.ws, "map:switched");
      gm.send(JSON.stringify({ type: "map:switch", imageId: prepImageId }));
      expect((await away).declarations).toEqual([]);

      const back = waitForMessage(alice.ws, "map:switched");
      gm.send(JSON.stringify({ type: "map:switch", imageId }));
      expect((await back).declarations.map((d: any) => d.id)).toEqual([declarationId]);
    });

    it("nothing can be declared while nothing is on the table", async () => {
      const gm = await connectGm();
      monsterId = await placeMonster(gm);
      const alice = await connectPlayer("Alice");

      const cleared = waitForMessage(alice.ws, "map:unpresented");
      gm.send(JSON.stringify({ type: "map:unpresent" }));
      await cleared;

      const refused = waitForMessage(alice.ws, "error");
      alice.ws.send(JSON.stringify({ type: "declaration:open", targetId: monsterId }));
      await refused;
      expect(getDeclarationsByImage(ts.db, imageId)).toEqual([]);
    });

    it("the GM answers for the monster a player attacked, and the table sees it", async () => {
      const gm = await connectGm();
      monsterId = await placeMonster(gm);
      const alice = await connectPlayer("Alice");

      const opened = waitForMessage(gm, "declaration:opened");
      alice.ws.send(JSON.stringify({ type: "declaration:open", targetId: monsterId }));
      const declarationId = (await opened).declaration.id;

      const seen = waitForMessage(alice.ws, "declaration:updated");
      gm.send(JSON.stringify({ type: "declaration:answer", declarationId, parried: true }));
      expect((await seen).declaration.state).toBe("parried");
    });

    it("the player answers the attack aimed at their own token", async () => {
      const gm = await connectGm();
      const alice = await connectPlayer("Alice");

      const opened = waitForMessage(alice.ws, "declaration:opened");
      gm.send(JSON.stringify({ type: "declaration:open", targetId: alice.tokenId }));
      const declarationId = (await opened).declaration.id;

      const seen = waitForMessage(gm, "declaration:updated");
      alice.ws.send(JSON.stringify({ type: "declaration:answer", declarationId, parried: false }));
      expect((await seen).declaration.state).toBe("not_parried");
    });

    it("nobody answers an attack that is not aimed at them", async () => {
      const gm = await connectGm();
      monsterId = await placeMonster(gm);
      const alice = await connectPlayer("Alice");
      const bob = await connectPlayer("Bob");

      // Alice attacks the Ork. The Ork is the GM's to answer for — not Alice's, though she made it.
      const opened = waitForMessage(gm, "declaration:opened");
      alice.ws.send(JSON.stringify({ type: "declaration:open", targetId: monsterId }));
      const onMonster = (await opened).declaration.id;

      const refusedAlice = waitForMessage(alice.ws, "error");
      alice.ws.send(JSON.stringify({ type: "declaration:answer", declarationId: onMonster, parried: true }));
      await refusedAlice;

      // The GM attacks Alice. Bob may not answer for her.
      const second = waitForMessage(bob.ws, "declaration:opened");
      gm.send(JSON.stringify({ type: "declaration:open", targetId: alice.tokenId }));
      const onAlice = (await second).declaration.id;

      const refusedBob = waitForMessage(bob.ws, "error");
      bob.ws.send(JSON.stringify({ type: "declaration:answer", declarationId: onAlice, parried: true }));
      await refusedBob;

      expect(getDeclaration(ts.db, onMonster)!.state).toBe("open");
      expect(getDeclaration(ts.db, onAlice)!.state).toBe("open");
    });

    it("an answered declaration cannot be answered again", async () => {
      const gm = await connectGm();
      monsterId = await placeMonster(gm);
      const alice = await connectPlayer("Alice");

      const opened = waitForMessage(gm, "declaration:opened");
      alice.ws.send(JSON.stringify({ type: "declaration:open", targetId: monsterId }));
      const declarationId = (await opened).declaration.id;

      const answered = waitForMessage(gm, "declaration:updated");
      gm.send(JSON.stringify({ type: "declaration:answer", declarationId, parried: true }));
      await answered;

      const refused = waitForMessage(gm, "error");
      gm.send(JSON.stringify({ type: "declaration:answer", declarationId, parried: false }));
      await refused;
      expect(getDeclaration(ts.db, declarationId)!.state).toBe("parried");
    });

    it("the attacker sends the number they rolled, and only they can", async () => {
      const gm = await connectGm();
      monsterId = await placeMonster(gm);
      const alice = await connectPlayer("Alice");
      const bob = await connectPlayer("Bob");

      const opened = waitForMessage(gm, "declaration:opened");
      alice.ws.send(JSON.stringify({ type: "declaration:open", targetId: monsterId }));
      const declarationId = (await opened).declaration.id;

      // Nothing to send while it is still open.
      const tooEarly = waitForMessage(alice.ws, "error");
      alice.ws.send(JSON.stringify({ type: "declaration:damage", declarationId, damage: 7 }));
      await tooEarly;

      const answered = waitForMessage(alice.ws, "declaration:updated");
      gm.send(JSON.stringify({ type: "declaration:answer", declarationId, parried: false }));
      await answered;

      // Not Bob's attack, and not the GM's either — the GM owns the target, not the source.
      for (const other of [bob.ws, gm]) {
        const refused = waitForMessage(other, "error");
        other.send(JSON.stringify({ type: "declaration:damage", declarationId, damage: 7 }));
        await refused;
      }

      const sent = waitForMessage(gm, "declaration:updated");
      alice.ws.send(JSON.stringify({ type: "declaration:damage", declarationId, damage: 7 }));
      expect((await sent).declaration.damage).toBe(7);

      // Written once. The record does not move after it is made.
      const again = waitForMessage(alice.ws, "error");
      alice.ws.send(JSON.stringify({ type: "declaration:damage", declarationId, damage: 12 }));
      await again;
      expect(getDeclaration(ts.db, declarationId)!.damage).toBe(7);
    });

    it("the GM sends the number for their own attack, and the player it hit cannot", async () => {
      const gm = await connectGm();
      const alice = await connectPlayer("Alice");

      const opened = waitForMessage(alice.ws, "declaration:opened");
      gm.send(JSON.stringify({ type: "declaration:open", targetId: alice.tokenId }));
      const declarationId = (await opened).declaration.id;

      const answered = waitForMessage(gm, "declaration:updated");
      alice.ws.send(JSON.stringify({ type: "declaration:answer", declarationId, parried: false }));
      await answered;

      // Alice answers for her token and the GM sends the number: the two halves of one exchange,
      // and a sourceless declaration is the GM's half.
      const refused = waitForMessage(alice.ws, "error");
      alice.ws.send(JSON.stringify({ type: "declaration:damage", declarationId, damage: 5 }));
      await refused;

      const sent = waitForMessage(alice.ws, "declaration:updated");
      gm.send(JSON.stringify({ type: "declaration:damage", declarationId, damage: 12 }));
      expect((await sent).declaration.damage).toBe(12);
    });

    it("a parried attack carries no number, and a number outside the range is refused", async () => {
      const gm = await connectGm();
      const first = await placeMonster(gm, "Ork 1");
      const second = await placeMonster(gm, "Ork 2");
      const alice = await connectPlayer("Alice");

      const opened = waitForMessage(gm, "declaration:opened");
      alice.ws.send(JSON.stringify({ type: "declaration:open", targetId: first }));
      const parriedId = (await opened).declaration.id;
      const answered = waitForMessage(alice.ws, "declaration:updated");
      gm.send(JSON.stringify({ type: "declaration:answer", declarationId: parriedId, parried: true }));
      await answered;

      const refused = waitForMessage(alice.ws, "error");
      alice.ws.send(JSON.stringify({ type: "declaration:damage", declarationId: parriedId, damage: 7 }));
      await refused;

      // The answered one stays behind as the record while a new attack is declared.
      const reopened = waitForMessage(gm, "declaration:opened");
      alice.ws.send(JSON.stringify({ type: "declaration:open", targetId: second }));
      const openId = (await reopened).declaration.id;
      expect(getDeclarationsByImage(ts.db, imageId)).toHaveLength(2);

      const notParried = waitForMessage(alice.ws, "declaration:updated");
      gm.send(JSON.stringify({ type: "declaration:answer", declarationId: openId, parried: false }));
      await notParried;

      for (const damage of [-1, 1000, 3.5]) {
        const bad = waitForMessage(alice.ws, "error");
        alice.ws.send(JSON.stringify({ type: "declaration:damage", declarationId: openId, damage }));
        await bad;
      }
      expect(getDeclaration(ts.db, openId)!.damage).toBeNull();

      // Zero is a real answer: the armour took all of it, and the table said so.
      const zero = waitForMessage(gm, "declaration:updated");
      alice.ws.send(JSON.stringify({ type: "declaration:damage", declarationId: openId, damage: 0 }));
      expect((await zero).declaration.damage).toBe(0);
    });

    it("removing a token takes its declarations with it, as target and as source", async () => {
      const gm = await connectGm();
      monsterId = await placeMonster(gm);
      const alice = await connectPlayer("Alice");

      // Alice on the Ork, the GM on Alice: one declaration pointing each way.
      const first = waitForMessage(gm, "declaration:opened");
      alice.ws.send(JSON.stringify({ type: "declaration:open", targetId: monsterId }));
      await first;
      const second = waitForMessage(gm, "declaration:opened");
      gm.send(JSON.stringify({ type: "declaration:open", targetId: alice.tokenId }));
      await second;
      expect(getDeclarationsByImage(ts.db, imageId)).toHaveLength(2);

      // No handler code does this — the foreign keys cascade.
      const removed = waitForMessage(gm, "token:removed");
      gm.send(JSON.stringify({ type: "gm_token:remove", tokenId: monsterId }));
      await removed;
      expect(getDeclarationsByImage(ts.db, imageId)).toHaveLength(1);

      gm.send(JSON.stringify({ type: "player:remove", tokenId: alice.tokenId }));
      await new Promise((r) => setTimeout(r, 120));
      expect(getDeclarationsByImage(ts.db, imageId)).toEqual([]);
    });
  });

});
