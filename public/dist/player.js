import {
  connectPlayer,
  createViewport,
  initCanvas,
  initPingLayer,
  initTokenLayer,
  listImagesAsPlayer
} from "./gm-bxt9t766.js";

// public/js/player.ts
var fragment = new URLSearchParams(location.hash.slice(1));
var adventureId = fragment.get("adventureId") ?? "";
var playerLink = fragment.get("link") ?? "";
var playerName = fragment.get("name") ?? "Player";
var playerColor = fragment.get("color") ?? "#e74c3c";
if (!adventureId || !playerLink) {
  const p = document.createElement("p");
  p.style.cssText = "padding:2rem";
  p.textContent = "Invalid invite link. ";
  const a = document.createElement("a");
  a.href = "/";
  a.textContent = "Return home";
  p.appendChild(a);
  document.body.textContent = "";
  document.body.appendChild(p);
  throw new Error("Missing params");
}
var playerInfoEl = document.getElementById("player-info");
var canvasArea = document.getElementById("canvas-area");
var dot = document.createElement("span");
dot.className = "player-dot";
dot.style.background = playerColor;
playerInfoEl.appendChild(dot);
playerInfoEl.appendChild(document.createTextNode(playerName));
canvasArea.style.visibility = "hidden";
var activeImageId = null;
var ownTokenId = null;
var ownTokenPos = null;
var imageList = [];
var canvasCtrl = initCanvas(canvasArea, { mode: "player" });
var viewport = createViewport();
viewport.attach(canvasArea, canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize());
var pingCtrl = initPingLayer(canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize(), () => viewport.scale);
function animatePings() {
  pingCtrl.tick();
  requestAnimationFrame(animatePings);
}
requestAnimationFrame(animatePings);
var tokenCtrl = initTokenLayer(canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize(), (x, y) => viewport.screenToImage(x, y), { interactive: true });
var LONG_PRESS_DELAY = 400;
var PING_RATE_LIMIT = 1000;
var TOKEN_RADIUS = 20;
var longPressTimer = null;
var longPressStartPos = null;
var lastPingTime = 0;
function cancelLongPress() {
  if (longPressTimer !== null) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  longPressStartPos = null;
}
function isOnOwnToken(clientX, clientY) {
  if (!ownTokenId || !ownTokenPos)
    return false;
  const pos = viewport.screenToImage(clientX, clientY);
  const dx = pos.x - ownTokenPos.x;
  const dy = pos.y - ownTokenPos.y;
  return dx * dx + dy * dy <= TOKEN_RADIUS * TOKEN_RADIUS;
}
viewport.onInteractStart((ev) => {
  tokenCtrl.handlePointerDown(ev);
  if (!isOnOwnToken(ev.clientX, ev.clientY)) {
    longPressStartPos = { x: ev.clientX, y: ev.clientY };
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      const now = Date.now();
      if (now - lastPingTime >= PING_RATE_LIMIT) {
        lastPingTime = now;
        const pos = viewport.screenToImage(longPressStartPos.x, longPressStartPos.y);
        ws.send({ type: "ping:map", x: pos.x, y: pos.y, color: playerColor });
      }
    }, LONG_PRESS_DELAY);
  }
});
viewport.onPointerMove((ev) => {
  tokenCtrl.handlePointerMove(ev);
  if (longPressTimer !== null && longPressStartPos !== null) {
    const dx = ev.clientX - longPressStartPos.x;
    const dy = ev.clientY - longPressStartPos.y;
    if (dx * dx + dy * dy > 25)
      cancelLongPress();
  }
});
viewport.onInteractEnd(() => {
  cancelLongPress();
  tokenCtrl.handlePointerUp();
});
var ws = connectPlayer(adventureId, playerLink, playerName, playerColor);
ws.on("joined", async (msg) => {
  const adv = msg.adventure;
  document.title = `${adv.name} — Player`;
  activeImageId = adv.activeImageId;
  ownTokenId = typeof msg.yourTokenId === "string" ? msg.yourTokenId : null;
  try {
    imageList = await listImagesAsPlayer(adventureId, playerLink);
  } catch {
    imageList = [];
  }
  if (activeImageId) {
    const img = imageList.find((i) => i.id === activeImageId);
    if (img) {
      await canvasCtrl.loadImage(`/uploads/${img.filename}`);
      viewport.resetView();
      if (typeof msg.fogMask === "string") {
        await canvasCtrl.applyFogMask(msg.fogMask);
      }
    }
  }
  canvasArea.style.visibility = "visible";
  const tokens = msg.tokens;
  for (const token of tokens) {
    tokenCtrl.addToken(token);
    if (token.id === ownTokenId)
      ownTokenPos = { x: token.x, y: token.y };
  }
  if (ownTokenId) {
    const tid = ownTokenId;
    tokenCtrl.enableDrag(tid, (x, y) => {
      ownTokenPos = { x, y };
      ws.send({ type: "token:move", tokenId: tid, x, y });
    });
  }
  tokenCtrl.render();
});
ws.on("fog:stroke", (msg) => {
  if (msg.imageId === activeImageId) {
    canvasCtrl.applyStroke(msg.stroke);
  }
});
ws.on("fog:stroke:batch", (msg) => {
  if (msg.imageId === activeImageId) {
    for (const stroke of msg.strokes) {
      canvasCtrl.applyStroke(stroke);
    }
  }
});
ws.on("fog:reset", (msg) => {
  if (msg.imageId === activeImageId && typeof msg.fogMask === "string") {
    canvasCtrl.applyFogMask(msg.fogMask);
  }
});
ws.on("token:moved", (msg) => {
  const tokenId = msg.tokenId;
  const x = msg.x;
  const y = msg.y;
  if (tokenId === ownTokenId)
    ownTokenPos = { x, y };
  tokenCtrl.moveToken(tokenId, x, y);
});
ws.on("token:added", (msg) => {
  const token = msg.token;
  tokenCtrl.addToken(token);
});
ws.on("token:removed", (msg) => {
  tokenCtrl.removeToken(msg.tokenId);
});
ws.on("ping:map", (msg) => {
  pingCtrl.addPing(msg.x, msg.y, msg.color);
});
ws.on("map:switched", async (msg) => {
  activeImageId = msg.imageId;
  pingCtrl.clear();
  try {
    imageList = await listImagesAsPlayer(adventureId, playerLink);
  } catch {}
  const img = imageList.find((i) => i.id === activeImageId);
  if (img) {
    await canvasCtrl.loadImage(`/uploads/${img.filename}`);
    viewport.resetView();
    if (typeof msg.fogMask === "string") {
      await canvasCtrl.applyFogMask(msg.fogMask);
    }
  }
  tokenCtrl.render();
});
ws.on("player:joined", (msg) => {
  showToast(`${msg.playerName} joined`);
});
ws.on("player:left", (msg) => {
  showToast(`${msg.playerName} left`);
});
ws.on("player:removed", () => {
  ws.close();
  const overlay = document.createElement("div");
  overlay.className = "removal-overlay";
  const msg = document.createElement("p");
  msg.textContent = "You have been removed from this session.";
  const link = document.createElement("a");
  link.href = "/";
  link.textContent = "Return home";
  overlay.appendChild(msg);
  overlay.appendChild(link);
  document.body.appendChild(overlay);
});
function showToast(text) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}
