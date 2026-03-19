import {
  connectPlayer,
  createViewport,
  initCanvas,
  initTokenLayer,
  listImagesAsPlayer
} from "./gm-cbsvw20h.js";

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
var adventureNameEl = document.getElementById("adventure-name");
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
var imageList = [];
var canvasCtrl = initCanvas(canvasArea, { mode: "player" });
var viewport = createViewport();
viewport.attach(canvasArea, canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize());
var tokenCtrl = initTokenLayer(canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize(), (x, y) => viewport.screenToImage(x, y), { interactive: true });
viewport.onInteractStart((ev) => tokenCtrl.handlePointerDown(ev));
viewport.onPointerMove((ev) => tokenCtrl.handlePointerMove(ev));
viewport.onInteractEnd(() => tokenCtrl.handlePointerUp());
var ws = connectPlayer(adventureId, playerLink, playerName, playerColor);
ws.on("joined", async (msg) => {
  const adv = msg.adventure;
  adventureNameEl.textContent = adv.name;
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
  }
  if (ownTokenId) {
    const tid = ownTokenId;
    tokenCtrl.enableDrag(tid, (x, y) => {
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
  tokenCtrl.moveToken(msg.tokenId, msg.x, msg.y);
});
ws.on("token:added", (msg) => {
  const token = msg.token;
  tokenCtrl.addToken(token);
});
ws.on("token:removed", (msg) => {
  tokenCtrl.removeToken(msg.tokenId);
});
ws.on("map:switched", async (msg) => {
  activeImageId = msg.imageId;
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
  document.body.textContent = "";
  const p = document.createElement("p");
  p.style.cssText = "padding:2rem";
  p.textContent = "You have been removed from this session. ";
  const a = document.createElement("a");
  a.href = "/";
  a.textContent = "Return home";
  p.appendChild(a);
  document.body.appendChild(p);
});
function showToast(text) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}
