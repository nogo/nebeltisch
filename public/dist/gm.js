import {
  connectGM,
  createViewport,
  getAdventure,
  initCanvas,
  initPingLayer,
  initTokenLayer,
  listImages,
  uploadImage
} from "./gm-k76gdcdt.js";

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
var tokenRadius = 20;
var activeImageId = null;
var imageList = [];
var playerRoster = [];
var inviteUrl = "";
var presencePopover = null;
var adventureNameEl = document.getElementById("adventure-name");
var connectionStatusEl = document.getElementById("connection-status");
var playerPresenceEl = document.getElementById("player-presence");
var brushSizeSlider = document.getElementById("brush-size");
var brushSizeLabel = document.getElementById("brush-size-label");
var modeRevealBtn = document.getElementById("mode-reveal");
var modeFogBtn = document.getElementById("mode-fog");
var undoBtn = document.getElementById("undo-btn");
var redoBtn = document.getElementById("redo-btn");
var mapPanelToggleBtn = document.getElementById("map-panel-toggle");
var mapPanel = document.getElementById("map-panel");
var gallery = document.getElementById("gallery");
var uploadInput = document.getElementById("upload-input");
var statusBar = document.getElementById("status-bar");
var canvasArea = document.getElementById("canvas-area");
var modeToggle = document.getElementById("mode-toggle");
var canvasCtrl = initCanvas(canvasArea);
var viewport = createViewport();
viewport.attach(canvasArea, canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize());
var pingCtrl = initPingLayer(canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize(), () => viewport.scale);
function animatePings() {
  pingCtrl.tick();
  requestAnimationFrame(animatePings);
}
requestAnimationFrame(animatePings);
var tokenCtrl = initTokenLayer(canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize(), (x, y) => viewport.screenToImage(x, y), { interactive: true, getRadius: () => tokenRadius });
tokenCtrl.enableDragAll((tokenId, x, y) => {
  ws.send({ type: "token:move", tokenId, x, y });
});
var ws = connectGM(adventureId, password);
ws.on("connect", () => {
  connectionStatusEl.className = "status-dot connected";
  statusBar.textContent = "";
});
ws.on("disconnect", () => {
  connectionStatusEl.className = "status-dot disconnected";
  statusBar.textContent = "";
});
ws.on("error", (msg) => {
  console.error("WS error", msg);
});
ws.on("joined", async (msg) => {
  const adv = msg.adventure;
  adventureNameEl.textContent = adv.name;
  tokenRadius = adv.tokenSize ?? 20;
  updateTokenSizeLabel();
  try {
    const advData = await getAdventure(adventureId, password);
    inviteUrl = `${location.origin}/player#link=${encodeURIComponent(advData.player_link)}`;
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
  renderPresence(playerRoster);
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
ws.on("player:roster", (msg) => {
  playerRoster = msg.players;
  renderPresence(playerRoster);
});
ws.on("ping:map", (msg) => {
  pingCtrl.addPing(msg.x, msg.y, msg.color);
});
ws.on("settings:updated", (msg) => {
  tokenRadius = msg.tokenSize;
  tokenCtrl.render();
  updateTokenSizeLabel();
});
ws.on("map:switched", async (msg) => {
  activeImageId = msg.imageId;
  pingCtrl.clear();
  resetUndoHistory();
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
ws.on("fog:reset", (msg) => {
  if (msg.imageId === activeImageId && typeof msg.fogMask === "string") {
    canvasCtrl.applyFogMask(msg.fogMask);
  }
});
function renderPresence(roster) {
  const sorted = [...roster].sort((a, b) => {
    if (a.online === b.online)
      return 0;
    return a.online ? -1 : 1;
  });
  playerPresenceEl.replaceChildren();
  const MAX_VISIBLE = 4;
  const visible = sorted.length > MAX_VISIBLE ? sorted.slice(0, 3) : sorted;
  const overflowCount = sorted.length > MAX_VISIBLE ? sorted.length - 3 : 0;
  for (const player of visible) {
    const avatar = document.createElement("div");
    avatar.className = `presence-avatar ${player.online ? "online" : "offline"}`;
    avatar.style.background = player.color;
    avatar.textContent = player.name.charAt(0).toUpperCase();
    avatar.title = player.name;
    avatar.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePresencePopover(sorted);
    });
    playerPresenceEl.appendChild(avatar);
  }
  if (overflowCount > 0) {
    const overflowEl = document.createElement("div");
    overflowEl.className = "presence-avatar presence-overflow";
    overflowEl.textContent = `+${overflowCount}`;
    overflowEl.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePresencePopover(sorted);
    });
    playerPresenceEl.appendChild(overflowEl);
  }
}
function togglePresencePopover(roster) {
  if (presencePopover) {
    presencePopover.remove();
    presencePopover = null;
    return;
  }
  presencePopover = document.createElement("div");
  presencePopover.className = "presence-popover";
  for (const player of roster) {
    const row = document.createElement("div");
    row.className = "popover-player";
    const dot = document.createElement("span");
    dot.className = "popover-player-dot";
    dot.style.background = player.color;
    const name = document.createElement("span");
    name.className = "popover-player-name";
    name.textContent = player.name;
    const status = document.createElement("span");
    status.className = "popover-player-status";
    status.textContent = player.online ? "online" : "offline";
    const actions = document.createElement("div");
    actions.className = "popover-player-actions";
    const copyBtn = document.createElement("button");
    copyBtn.className = "popover-btn";
    copyBtn.textContent = "Copy link";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(inviteUrl).catch(() => {});
    });
    const removeBtn = document.createElement("button");
    removeBtn.className = "popover-btn danger";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove player";
    removeBtn.addEventListener("click", () => {
      ws.send({ type: "player:remove", tokenId: player.tokenId });
      presencePopover?.remove();
      presencePopover = null;
    });
    actions.appendChild(copyBtn);
    actions.appendChild(removeBtn);
    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(status);
    row.appendChild(actions);
    presencePopover.appendChild(row);
  }
  document.body.appendChild(presencePopover);
  setTimeout(() => {
    document.addEventListener("click", closePresencePopover, { once: true });
  }, 0);
}
function closePresencePopover() {
  presencePopover?.remove();
  presencePopover = null;
}
mapPanelToggleBtn.addEventListener("click", () => {
  const isOpen = mapPanel.hasAttribute("hidden");
  if (isOpen) {
    mapPanel.removeAttribute("hidden");
  } else {
    mapPanel.setAttribute("hidden", "");
  }
  mapPanelToggleBtn.classList.toggle("active", isOpen);
});
function renderGallery() {
  gallery.replaceChildren();
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
  brushSizeLabel.textContent = `${brushRadius}`;
});
function setMode(mode) {
  brushMode = mode;
  modeRevealBtn.classList.toggle("active", mode === "reveal");
  modeFogBtn.classList.toggle("active", mode === "fog");
}
modeRevealBtn.addEventListener("click", () => setMode("reveal"));
modeFogBtn.addEventListener("click", () => setMode("fog"));
var tokenSizeBtn = document.createElement("button");
tokenSizeBtn.id = "token-size-btn";
tokenSizeBtn.textContent = `● ${tokenRadius}`;
tokenSizeBtn.title = "Token size";
modeToggle.appendChild(tokenSizeBtn);
var tokenSizePopup = document.createElement("div");
tokenSizePopup.id = "token-size-popup";
tokenSizePopup.className = "floating-control";
tokenSizePopup.hidden = true;
var tokenSizeSlider = document.createElement("input");
tokenSizeSlider.type = "range";
tokenSizeSlider.min = "5";
tokenSizeSlider.max = "100";
tokenSizeSlider.value = String(tokenRadius);
tokenSizePopup.appendChild(tokenSizeSlider);
document.body.appendChild(tokenSizePopup);
function updateTokenSizeLabel() {
  tokenSizeBtn.textContent = `● ${tokenRadius}`;
  tokenSizeSlider.value = String(tokenRadius);
}
tokenSizeBtn.addEventListener("click", () => {
  tokenSizePopup.hidden = !tokenSizePopup.hidden;
  tokenSizeBtn.classList.toggle("active", !tokenSizePopup.hidden);
});
tokenSizeSlider.addEventListener("input", () => {
  tokenRadius = parseInt(tokenSizeSlider.value, 10);
  tokenCtrl.render();
  updateTokenSizeLabel();
  ws.send({ type: "settings:update", tokenSize: tokenRadius });
});
var MAX_HISTORY = 50;
var undoStack = [];
var redoStack = [];
var currentAction = [];
function updateUndoRedoButtons() {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
}
function sendUndo(strokes) {
  ws.send({ type: "fog:undo", strokes });
}
function performUndo() {
  if (undoStack.length === 0)
    return;
  const action = undoStack.pop();
  redoStack.push(action);
  sendUndo(undoStack.flat());
  updateUndoRedoButtons();
}
function performRedo() {
  if (redoStack.length === 0)
    return;
  const action = redoStack.pop();
  undoStack.push(action);
  sendUndo(undoStack.flat());
  updateUndoRedoButtons();
}
function resetUndoHistory() {
  undoStack = [];
  redoStack = [];
  currentAction = [];
  updateUndoRedoButtons();
}
undoBtn.addEventListener("click", performUndo);
redoBtn.addEventListener("click", performRedo);
document.addEventListener("keydown", (ev) => {
  const ctrl = ev.ctrlKey || ev.metaKey;
  if (!ctrl)
    return;
  if (ev.key === "z" || ev.key === "Z") {
    if (ev.shiftKey) {
      ev.preventDefault();
      performRedo();
    } else {
      ev.preventDefault();
      performUndo();
    }
  } else if (ev.key === "y" || ev.key === "Y") {
    ev.preventDefault();
    performRedo();
  }
});
var isDrawing = false;
var isPinging = false;
var pending = [];
var lastFlush = 0;
var FLUSH_INTERVAL = 1000 / 60;
var GM_PING_COLOR = "#4a4aff";
var LONG_PRESS_DELAY = 400;
var PING_RATE_LIMIT = 1000;
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
var isDraggingToken = false;
viewport.onInteractStart((ev) => {
  if (!activeImageId)
    return;
  tokenCtrl.handlePointerDown(ev);
  if (tokenCtrl.isDragging()) {
    isDraggingToken = true;
    return;
  }
  isDraggingToken = false;
  longPressStartPos = { x: ev.clientX, y: ev.clientY };
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    const now = Date.now();
    if (now - lastPingTime >= PING_RATE_LIMIT) {
      lastPingTime = now;
      isDrawing = false;
      currentAction = [];
      pending.length = 0;
      isPinging = true;
      const pos = viewport.screenToImage(longPressStartPos.x, longPressStartPos.y);
      ws.send({ type: "ping:map", x: pos.x, y: pos.y, color: GM_PING_COLOR });
    }
  }, LONG_PRESS_DELAY);
  isDrawing = true;
  currentAction = [];
  const stroke = makeStroke(ev.clientX, ev.clientY);
  canvasCtrl.applyStroke(stroke);
  pending.push(stroke);
  currentAction.push(stroke);
  if (Date.now() - lastFlush >= FLUSH_INTERVAL)
    flushPending();
});
viewport.onPointerMove((ev) => {
  if (isDraggingToken) {
    tokenCtrl.handlePointerMove(ev);
    return;
  }
  const pos = viewport.screenToImage(ev.clientX, ev.clientY);
  canvasCtrl.drawBrushPreview(pos.x, pos.y, brushRadius, viewport.scale);
  if (longPressTimer !== null && longPressStartPos !== null) {
    const dx = ev.clientX - longPressStartPos.x;
    const dy = ev.clientY - longPressStartPos.y;
    if (dx * dx + dy * dy > 25)
      cancelLongPress();
  }
  if (!isDrawing || isPinging)
    return;
  const stroke = makeStroke(ev.clientX, ev.clientY);
  canvasCtrl.applyStroke(stroke);
  pending.push(stroke);
  currentAction.push(stroke);
  if (Date.now() - lastFlush >= FLUSH_INTERVAL)
    flushPending();
});
function finishAction() {
  if (isDraggingToken) {
    tokenCtrl.handlePointerUp();
    isDraggingToken = false;
    return;
  }
  if (!isDrawing)
    return;
  isDrawing = false;
  flushPending();
  if (currentAction.length > 0) {
    undoStack.push(currentAction);
    if (undoStack.length > MAX_HISTORY)
      undoStack.shift();
    redoStack = [];
    currentAction = [];
    updateUndoRedoButtons();
  }
}
viewport.onInteractEnd(() => {
  cancelLongPress();
  isPinging = false;
  finishAction();
});
viewport.onPointerLeave(() => {
  canvasCtrl.clearBrushPreview();
  cancelLongPress();
  isPinging = false;
  finishAction();
});
