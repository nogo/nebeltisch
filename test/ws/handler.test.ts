import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { startWsTestServer, type WsTestServer } from "../helpers";
import { createAdventure, getAdventure } from "../../src/db/adventures";
import { createImageRecord } from "../../src/db/images";
import { getTokensByAdventure } from "../../src/db/tokens";
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
      stroke: { x: 10, y: 10, radius: 5, mode: "reveal" },
    }));
    expect((await err).message).toContain("dimensions");

    const batchErr = waitForMessage(gm, "error");
    gm.send(JSON.stringify({
      type: "fog:stroke:batch",
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
      stroke: { x: 50, y: 50, radius: 20, mode: "reveal" },
    }));

    const gm = track(
      await connectWS(ts.wsUrl, { adventureId, role: "gm", password: gmPassword })
    );
    await waitForMessage(gm, "joined");
    gm.send(JSON.stringify({
      type: "fog:stroke",
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

  async function paint(gm: WebSocket, x: number, y: number, radius = 8) {
    const historyPromise = waitForMessage(gm, "fog:history");
    gm.send(JSON.stringify({ type: "fog:stroke", stroke: { x, y, radius, mode: "reveal" } }));
    gm.send(JSON.stringify({ type: "fog:action:end" }));
    return historyPromise;
  }

  async function currentMask() {
    await ts.fog.flushAll();
    return (await loadFogMask(ts.db, imageId))!;
  }

  /** Registers both listeners before sending, so neither can catch a stale message. */
  async function undoOrRedo(gm: WebSocket, type: "fog:undo" | "fog:redo") {
    const reset = waitForMessage(gm, "fog:reset");
    const history = waitForMessage(gm, "fog:history");
    gm.send(JSON.stringify({ type }));
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
    second.send(JSON.stringify({ type: "fog:undo" }));
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
    gm.send(JSON.stringify({ type: "fog:undo" }));
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
    player.send(JSON.stringify({ type: "fog:undo" }));
    const err = await errPromise;
    expect(err.message).toContain("GM");
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
});
