import {
  connectGM,
  createViewport,
  getAdventure,
  initCanvas,
  initTokenLayer,
  listImages,
  uploadImage
} from "./gm-cbsvw20h.js";

// public/js/gm.ts
var fragment = new URLSearchParams(location.hash.slice(1));
var adventureId = fragment.get("id") ?? "";
var password = fragment.get("password") ?? "";
if (!adventureId || !password) {
  document.body.innerHTML = '<p style="padding:2rem">Missing adventure ID or password. <a href="/">Return home</a></p>';
  throw new Error("Missing params");
}
var brushRadius = 50;
var brushMode = "reveal";
var activeImageId = null;
var imageList = [];
var adventureNameEl = document.getElementById("adventure-name");
var inviteLinkEl = document.getElementById("invite-link");
var copyInviteBtn = document.getElementById("copy-invite");
var brushSizeSlider = document.getElementById("brush-size");
var brushSizeLabel = document.getElementById("brush-size-label");
var modeRevealBtn = document.getElementById("mode-reveal");
var modeFogBtn = document.getElementById("mode-fog");
var gallery = document.getElementById("gallery");
var uploadInput = document.getElementById("upload-input");
var statusBar = document.getElementById("status-bar");
var canvasArea = document.getElementById("canvas-area");
var canvasCtrl = initCanvas(canvasArea);
var viewport = createViewport();
viewport.attach(canvasArea, canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize());
var tokenCtrl = initTokenLayer(canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize(), (x, y) => viewport.screenToImage(x, y), { interactive: false });
var ws = connectGM(adventureId, password);
ws.on("connect", () => {
  statusBar.textContent = "";
});
ws.on("disconnect", () => {
  statusBar.textContent = "Reconnecting…";
});
ws.on("error", (msg) => {
  console.error("WS error", msg);
});
ws.on("joined", async (msg) => {
  const adv = msg.adventure;
  adventureNameEl.textContent = adv.name;
  try {
    const advData = await getAdventure(adventureId, password);
    const inviteUrl = `${location.origin}/player#link=${encodeURIComponent(advData.player_link)}`;
    inviteLinkEl.textContent = inviteUrl;
    copyInviteBtn.onclick = () => {
      navigator.clipboard.writeText(inviteUrl).catch(() => {});
    };
  } catch {}
  activeImageId = adv.activeImageId;
  imageList = await listImages(adventureId, password);
  renderGallery();
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
  const tokens = msg.tokens;
  for (const token of tokens) {
    tokenCtrl.addToken(token);
  }
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
ws.on("token:added", (msg) => {
  const token = msg.token;
  tokenCtrl.addToken(token);
});
ws.on("token:moved", (msg) => {
  tokenCtrl.moveToken(msg.tokenId, msg.x, msg.y);
});
ws.on("token:removed", (msg) => {
  tokenCtrl.removeToken(msg.tokenId);
});
ws.on("map:switched", async (msg) => {
  activeImageId = msg.imageId;
  imageList = await listImages(adventureId, password);
  const img = imageList.find((i) => i.id === activeImageId);
  if (img) {
    await canvasCtrl.loadImage(`/uploads/${img.filename}`);
    viewport.resetView();
    if (typeof msg.fogMask === "string") {
      await canvasCtrl.applyFogMask(msg.fogMask);
    }
  }
  renderGallery();
  tokenCtrl.render();
});
function renderGallery() {
  gallery.innerHTML = "";
  for (const img of imageList) {
    const item = document.createElement("div");
    item.className = "gallery-item" + (img.id === activeImageId ? " active" : "");
    const thumb = document.createElement("img");
    thumb.src = `/uploads/${img.filename}`;
    thumb.alt = img.original_name;
    thumb.title = img.original_name;
    item.appendChild(thumb);
    item.addEventListener("click", () => {
      ws.send({ type: "map:switch", imageId: img.id });
    });
    gallery.appendChild(item);
  }
}
uploadInput.addEventListener("change", async () => {
  const file = uploadInput.files?.[0];
  if (!file)
    return;
  try {
    await uploadImage(adventureId, password, file);
    imageList = await listImages(adventureId, password);
    renderGallery();
  } catch (e) {
    console.error("Upload failed", e);
  }
  uploadInput.value = "";
});
brushSizeSlider.addEventListener("input", () => {
  brushRadius = parseInt(brushSizeSlider.value, 10);
  brushSizeLabel.textContent = `${brushRadius}px`;
});
function setMode(mode) {
  brushMode = mode;
  modeRevealBtn.classList.toggle("active", mode === "reveal");
  modeFogBtn.classList.toggle("active", mode === "fog");
}
modeRevealBtn.addEventListener("click", () => setMode("reveal"));
modeFogBtn.addEventListener("click", () => setMode("fog"));
var isDrawing = false;
var pending = [];
var lastFlush = 0;
var FLUSH_INTERVAL = 1000 / 60;
function makeStroke(clientX, clientY) {
  const pos = viewport.screenToImage(clientX, clientY);
  return { x: pos.x, y: pos.y, radius: brushRadius, mode: brushMode };
}
function flushPending() {
  if (pending.length === 0)
    return;
  if (pending.length === 1) {
    ws.send({ type: "fog:stroke", stroke: pending[0] });
  } else {
    ws.send({ type: "fog:stroke:batch", strokes: pending.slice() });
  }
  pending.length = 0;
  lastFlush = Date.now();
}
viewport.onInteractStart((ev) => {
  if (!activeImageId)
    return;
  isDrawing = true;
  const stroke = makeStroke(ev.clientX, ev.clientY);
  canvasCtrl.applyStroke(stroke);
  pending.push(stroke);
  if (Date.now() - lastFlush >= FLUSH_INTERVAL)
    flushPending();
});
viewport.onPointerMove((ev) => {
  const pos = viewport.screenToImage(ev.clientX, ev.clientY);
  canvasCtrl.drawBrushPreview(pos.x, pos.y, brushRadius);
  if (!isDrawing)
    return;
  const stroke = makeStroke(ev.clientX, ev.clientY);
  canvasCtrl.applyStroke(stroke);
  pending.push(stroke);
  if (Date.now() - lastFlush >= FLUSH_INTERVAL)
    flushPending();
});
viewport.onInteractEnd(() => {
  if (!isDrawing)
    return;
  isDrawing = false;
  flushPending();
});
viewport.onPointerLeave(() => {
  canvasCtrl.clearBrushPreview();
  if (isDrawing) {
    isDrawing = false;
    flushPending();
  }
});
