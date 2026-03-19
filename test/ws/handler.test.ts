import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { startWsTestServer, type WsTestServer } from "../helpers";
import { createAdventure } from "../../src/db/adventures";
import { createImageRecord } from "../../src/db/images";
import { getTokensByAdventure } from "../../src/db/tokens";
import { flushAllFogCaches } from "../../src/ws/handler";
import { loadFogMask } from "../../src/fog/serialize";

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

  it("Player disconnects → other clients receive player:left and token:removed", async () => {
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

    // Wait for gm to receive player:joined before disconnecting
    await waitForMessage(gm, "player:joined");

    const leftPromise = waitForMessage(gm, "player:left");
    const removedPromise = waitForMessage(gm, "token:removed");

    await closeWs(player);

    const left = await leftPromise;
    expect(left.playerName).toBe("Alice");

    const removed = await removedPromise;
    expect(removed.tokenId).toBe(tokenId);

    // Token should be deleted from DB
    const tokens = getTokensByAdventure(ts.db, adventureId);
    expect(tokens.find((t) => t.id === tokenId)).toBeUndefined();
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

    await flushAllFogCaches(ts.db);

    const loaded = await loadFogMask(ts.db, imageId);
    expect(loaded).not.toBeNull();
    expect(loaded!.width).toBe(100);
    expect(loaded!.height).toBe(100);
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
});
