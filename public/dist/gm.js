import {
  connectGM,
  createViewport,
  getAdventure,
  initCanvas,
  initPingLayer,
  initTokenLayer,
  listImages,
  uploadImage
} from "./gm-f64vamqp.js";

// public/js/gm.ts
var fragment = new URLSearchParams(location.hash.slice(1));
var adventureId = fragment.get("id") ?? "";
var passwordFromUrl = fragment.get("password") ?? "";
var password = passwordFromUrl || sessionStorage.getItem(`gm_pw_${adventureId}`) || "";
if (!adventureId || !password) {
  const p = document.createElement("p");
  p.style.cssText = "padding:2rem";
  p.textContent = "Missing adventure ID or password. ";
  const a = document.createElement("a");
  a.href = "/";
  a.textContent = "Return home";
  p.appendChild(a);
  document.body.textContent = "";
  document.body.appendChild(p);
  throw new Error("Missing params");
}
if (passwordFromUrl) {
  sessionStorage.setItem(`gm_pw_${adventureId}`, password);
}
history.replaceState(null, "", `${location.pathname}#id=${encodeURIComponent(adventureId)}`);
var brushRadius = 50;
var brushMode = "reveal";
var tokenRadius = 20;
var activeImageId = null;
var imageList = [];
var playerRoster = [];
var inviteUrl = "";
var adventureNameEl = document.getElementById("adventure-name");
var connectionStatusEl = document.getElementById("connection-status");
var playerPresenceEl = document.getElementById("player-presence");
var canvasArea = document.getElementById("canvas-area");
var toolbox = document.getElementById("toolbox");
var tbHistory = document.getElementById("tb-history");
var undoBtn = document.getElementById("undo-btn");
var redoBtn = document.getElementById("redo-btn");
var modeRevealBtn = document.getElementById("mode-reveal");
var modeFogBtn = document.getElementById("mode-fog");
var brushBtn = document.getElementById("brush-btn");
var brushSizeLabel = document.getElementById("brush-size-label");
var tokenBtn = document.getElementById("token-btn");
var tokenSizeLabel = document.getElementById("token-size-label");
var playersBt = document.getElementById("players-btn");
var playerCount = document.getElementById("player-count");
var mapsBtn = document.getElementById("maps-btn");
var placeTokenBtn = document.getElementById("place-token-btn");
var tokenPlaceForm = document.getElementById("token-place-form");
var tpMonsterBtn = document.getElementById("tp-monster");
var tpNpcBtn = document.getElementById("tp-npc");
var tpNameInput = document.getElementById("tp-name");
var tpCancelBtn = document.getElementById("tp-cancel");
var tpConfirmBtn = document.getElementById("tp-confirm");
var brushPopup = document.getElementById("brush-popup");
var brushSizeSlider = document.getElementById("brush-size");
var tokenPopup = document.getElementById("token-popup");
var tokenSizeSlider = document.getElementById("token-size");
var sheetBackdrop = document.getElementById("sheet-backdrop");
var playersSheet = document.getElementById("players-sheet");
var playersList = document.getElementById("players-list");
var copyInviteBtn = document.getElementById("copy-invite-btn");
var mapsSheet = document.getElementById("maps-sheet");
var gallery = document.getElementById("gallery");
var uploadInput = document.getElementById("upload-input");
var shareBtn = document.getElementById("share-btn");
var emptyState = document.getElementById("empty-state");
var emptyUploadBtn = document.getElementById("empty-upload-btn");
var canvasCtrl = initCanvas(canvasArea);
var viewport = createViewport();
viewport.attach(canvasArea, canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize());
var pingCtrl = initPingLayer(canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize(), () => viewport.scale);
function animatePings() {
  pingCtrl.tick();
  requestAnimationFrame(animatePings);
}
requestAnimationFrame(animatePings);
var gmTokenCtrl = initTokenLayer(canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize(), (x, y) => viewport.screenToImage(x, y), {
  interactive: false,
  insertBefore: canvasCtrl.getFogCanvas(),
  onDoubleClickToken: (tokenId) => {
    ws.send({ type: "gm_token:remove", tokenId });
  }
});
gmTokenCtrl.enableDragAll((tokenId, x, y) => {
  ws.send({ type: "token:move", tokenId, x, y });
});
canvasArea.addEventListener("dblclick", (ev) => {
  gmTokenCtrl.handleDoubleClick(ev);
});
var tokenCtrl = initTokenLayer(canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize(), (x, y) => viewport.screenToImage(x, y), { interactive: true, getRadius: () => tokenRadius });
tokenCtrl.enableDragAll((tokenId, x, y) => {
  ws.send({ type: "token:move", tokenId, x, y });
});
var ws = connectGM(adventureId, password);
ws.on("connect", () => {
  connectionStatusEl.className = "status-dot connected";
});
ws.on("disconnect", () => {
  connectionStatusEl.className = "status-dot disconnected";
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
    inviteUrl = `${location.origin}/join/${encodeURIComponent(advData.player_link)}`;
  } catch {}
  activeImageId = adv.activeImageId;
  imageList = await listImages(adventureId, password);
  renderGallery();
  updateEmptyState();
  if (activeImageId) {
    const img = imageList.find((i) => i.id === activeImageId);
    if (img) {
      await canvasCtrl.loadImage(`/uploads/${img.filename}`);
      viewport.resetView();
      if (typeof msg.fogMask === "string")
        await canvasCtrl.applyFogMask(msg.fogMask);
    }
  }
  const tokens = msg.tokens;
  for (const token of tokens) {
    if (token.token_type === "monster" || token.token_type === "npc") {
      gmTokenCtrl.addToken(token);
    } else {
      tokenCtrl.addToken(token);
    }
  }
  renderPresence(playerRoster);
});
ws.on("fog:stroke", (msg) => {
  if (msg.imageId === activeImageId)
    canvasCtrl.applyStroke(msg.stroke);
});
ws.on("fog:stroke:batch", (msg) => {
  if (msg.imageId === activeImageId) {
    for (const stroke of msg.strokes)
      canvasCtrl.applyStroke(stroke);
  }
});
ws.on("token:added", (msg) => {
  tokenCtrl.addToken(msg.token);
});
ws.on("gm_token:added", (msg) => {
  gmTokenCtrl.addToken(msg.token);
});
ws.on("token:moved", (msg) => {
  tokenCtrl.moveToken(msg.tokenId, msg.x, msg.y);
});
ws.on("token:removed", (msg) => {
  const id = msg.tokenId;
  tokenCtrl.removeToken(id);
  gmTokenCtrl.removeToken(id);
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
function deactivatePlaceMode() {
  placeModeActive = false;
  placeTokenBtn.classList.remove("active");
  document.body.classList.remove("placing");
  hidePlaceForm();
}
ws.on("map:switched", async (msg) => {
  activeImageId = msg.imageId;
  pingCtrl.clear();
  resetUndoHistory();
  imageList = await listImages(adventureId, password);
  const img = imageList.find((i) => i.id === activeImageId);
  if (img) {
    await canvasCtrl.loadImage(`/uploads/${img.filename}`);
    viewport.resetView();
    if (typeof msg.fogMask === "string")
      await canvasCtrl.applyFogMask(msg.fogMask);
  }
  renderGallery();
  updateEmptyState();
  tokenCtrl.render();
  gmTokenCtrl.clear();
  const newGmTokens = msg.gmTokens;
  for (const t of newGmTokens ?? [])
    gmTokenCtrl.addToken(t);
});
ws.on("fog:reset", (msg) => {
  if (msg.imageId === activeImageId && typeof msg.fogMask === "string") {
    canvasCtrl.applyFogMask(msg.fogMask);
  }
});
function updateEmptyState() {
  emptyState.hidden = imageList.length > 0;
}
emptyUploadBtn.addEventListener("click", () => openSheet(mapsSheet));
shareBtn.addEventListener("click", () => {
  if (!inviteUrl)
    return;
  navigator.clipboard.writeText(inviteUrl).catch(() => {});
  shareBtn.classList.add("active");
  setTimeout(() => shareBtn.classList.remove("active"), 1200);
});
copyInviteBtn.addEventListener("click", () => {
  if (!inviteUrl)
    return;
  navigator.clipboard.writeText(inviteUrl).catch(() => {});
  copyInviteBtn.textContent = "Copied!";
  setTimeout(() => {
    copyInviteBtn.textContent = "Copy invite link";
  }, 1500);
});
var placeModeActive = false;
var pendingPlacePos = null;
var pendingTokenType = "monster";
placeTokenBtn.addEventListener("click", () => {
  placeModeActive = !placeModeActive;
  placeTokenBtn.classList.toggle("active", placeModeActive);
  document.body.classList.toggle("placing", placeModeActive);
  if (!placeModeActive)
    hidePlaceForm();
});
tpMonsterBtn.addEventListener("click", () => {
  pendingTokenType = "monster";
  tpMonsterBtn.classList.add("active");
  tpNpcBtn.classList.remove("active");
});
tpNpcBtn.addEventListener("click", () => {
  pendingTokenType = "npc";
  tpNpcBtn.classList.add("active");
  tpMonsterBtn.classList.remove("active");
});
tpCancelBtn.addEventListener("click", hidePlaceForm);
tpConfirmBtn.addEventListener("click", () => {
  const name = tpNameInput.value.trim();
  if (!name || !pendingPlacePos)
    return;
  ws.send({ type: "gm_token:place", name, tokenType: pendingTokenType, x: pendingPlacePos.x, y: pendingPlacePos.y });
  hidePlaceForm();
});
tpNameInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter")
    tpConfirmBtn.click();
  if (ev.key === "Escape")
    hidePlaceForm();
});
function showPlaceForm(screenX, screenY, imageX, imageY) {
  pendingPlacePos = { x: imageX, y: imageY };
  tpNameInput.value = "";
  const formW = 180;
  const formH = 130;
  let left = screenX + 12;
  let top = screenY - formH / 2;
  if (left + formW > window.innerWidth - 8)
    left = screenX - formW - 12;
  if (top < 8)
    top = 8;
  if (top + formH > window.innerHeight - 8)
    top = window.innerHeight - formH - 8;
  tokenPlaceForm.style.left = `${left}px`;
  tokenPlaceForm.style.top = `${top}px`;
  tokenPlaceForm.removeAttribute("hidden");
  tpNameInput.focus();
}
function hidePlaceForm() {
  tokenPlaceForm.setAttribute("hidden", "");
  pendingPlacePos = null;
}
function renderPresence(roster) {
  const sorted = [...roster].sort((a, b) => a.online === b.online ? 0 : a.online ? -1 : 1);
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
    playerPresenceEl.appendChild(avatar);
  }
  if (overflowCount > 0) {
    const overflow = document.createElement("div");
    overflow.className = "presence-avatar presence-overflow";
    overflow.textContent = `+${overflowCount}`;
    playerPresenceEl.appendChild(overflow);
  }
  const online = roster.filter((p) => p.online).length;
  playerCount.textContent = roster.length > 0 ? String(online) : "";
  renderPlayersList(sorted);
}
function renderPlayersList(roster) {
  playersList.replaceChildren();
  for (const player of roster) {
    const row = document.createElement("div");
    row.className = "player-row";
    const dot = document.createElement("span");
    dot.className = "player-row-dot";
    dot.style.background = player.color;
    const name = document.createElement("span");
    name.className = "player-row-name";
    name.textContent = player.name;
    const status = document.createElement("span");
    status.className = `player-row-status${player.online ? " online" : ""}`;
    status.textContent = player.online ? "online" : "offline";
    const removeBtn = document.createElement("button");
    removeBtn.className = "player-row-remove";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      ws.send({ type: "player:remove", tokenId: player.tokenId });
    });
    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(status);
    row.appendChild(removeBtn);
    playersList.appendChild(row);
  }
}
function openSheet(sheet) {
  closeAllPopups();
  sheetBackdrop.removeAttribute("hidden");
  sheet.removeAttribute("hidden");
}
function closeSheet(sheet) {
  sheet.setAttribute("hidden", "");
  if (playersSheet.hasAttribute("hidden") && mapsSheet.hasAttribute("hidden")) {
    sheetBackdrop.setAttribute("hidden", "");
  }
}
sheetBackdrop.addEventListener("click", () => {
  closeSheet(playersSheet);
  closeSheet(mapsSheet);
  sheetBackdrop.setAttribute("hidden", "");
});
document.getElementById("players-close").addEventListener("click", () => closeSheet(playersSheet));
document.getElementById("maps-close").addEventListener("click", () => closeSheet(mapsSheet));
playersBt.addEventListener("click", () => openSheet(playersSheet));
mapsBtn.addEventListener("click", () => openSheet(mapsSheet));
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
      closeSheet(mapsSheet);
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
    updateEmptyState();
  } catch (e) {
    console.error("Upload failed", e);
  }
  uploadInput.value = "";
});
function setMode(mode) {
  brushMode = mode;
  modeRevealBtn.classList.toggle("active", mode === "reveal");
  modeFogBtn.classList.toggle("active", mode === "fog");
}
modeRevealBtn.addEventListener("click", () => setMode("reveal"));
modeFogBtn.addEventListener("click", () => setMode("fog"));
function updateBrushLabel() {
  brushSizeLabel.textContent = String(brushRadius);
  brushSizeSlider.value = String(brushRadius);
}
brushSizeSlider.addEventListener("input", () => {
  brushRadius = parseInt(brushSizeSlider.value, 10);
  brushSizeLabel.textContent = String(brushRadius);
});
canvasArea.addEventListener("wheel", (ev) => {
  if (!ev.shiftKey)
    return;
  ev.preventDefault();
  ev.stopPropagation();
  const delta = ev.deltaY > 0 ? -5 : 5;
  brushRadius = Math.max(10, Math.min(200, brushRadius + delta));
  updateBrushLabel();
}, { passive: false, capture: true });
function updateTokenSizeLabel() {
  tokenSizeLabel.textContent = String(tokenRadius);
  tokenSizeSlider.value = String(tokenRadius);
}
tokenSizeSlider.addEventListener("input", () => {
  tokenRadius = parseInt(tokenSizeSlider.value, 10);
  tokenCtrl.render();
  updateTokenSizeLabel();
  ws.send({ type: "settings:update", tokenSize: tokenRadius });
});
function closeAllPopups() {
  brushPopup.setAttribute("hidden", "");
  brushBtn.classList.remove("active");
  tokenPopup.setAttribute("hidden", "");
  tokenBtn.classList.remove("active");
}
function togglePopup(popup, anchorBtn) {
  const isOpen = !popup.hasAttribute("hidden");
  closeAllPopups();
  if (isOpen)
    return;
  const rect = anchorBtn.getBoundingClientRect();
  const popupWidth = 200;
  let left = rect.left + rect.width / 2 - popupWidth / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - popupWidth - 8));
  popup.style.left = `${left}px`;
  popup.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  popup.removeAttribute("hidden");
  anchorBtn.classList.add("active");
}
brushBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  togglePopup(brushPopup, brushBtn);
});
tokenBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  togglePopup(tokenPopup, tokenBtn);
});
document.addEventListener("click", () => closeAllPopups());
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && placeModeActive)
    deactivatePlaceMode();
});
brushPopup.addEventListener("click", (e) => e.stopPropagation());
tokenPopup.addEventListener("click", (e) => e.stopPropagation());
var MAX_HISTORY = 50;
var undoStack = [];
var redoStack = [];
var currentAction = [];
function updateUndoRedoButtons() {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
  tbHistory.hidden = undoStack.length === 0 && redoStack.length === 0;
}
function sendUndo(strokes) {
  ws.send({ type: "fog:undo", strokes });
}
function performUndo() {
  if (!undoStack.length)
    return;
  redoStack.push(undoStack.pop());
  sendUndo(undoStack.flat());
  updateUndoRedoButtons();
}
function performRedo() {
  if (!redoStack.length)
    return;
  undoStack.push(redoStack.pop());
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
    ev.preventDefault();
    ev.shiftKey ? performRedo() : performUndo();
  } else if (ev.key === "y" || ev.key === "Y") {
    ev.preventDefault();
    performRedo();
  }
});
var isDrawing = false;
var isPinging = false;
var activeDragCtrl = null;
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
  if (!pending.length)
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
  closeAllPopups();
  if (placeModeActive) {
    const pos = viewport.screenToImage(ev.clientX, ev.clientY);
    showPlaceForm(ev.clientX, ev.clientY, pos.x, pos.y);
    return;
  }
  tokenCtrl.handlePointerDown(ev);
  if (tokenCtrl.isDragging()) {
    activeDragCtrl = tokenCtrl;
    return;
  }
  gmTokenCtrl.handlePointerDown(ev);
  if (gmTokenCtrl.isDragging()) {
    activeDragCtrl = gmTokenCtrl;
    return;
  }
  activeDragCtrl = null;
  toolbox.classList.add("painting");
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
  if (activeDragCtrl) {
    activeDragCtrl.handlePointerMove(ev);
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
  toolbox.classList.remove("painting");
  if (activeDragCtrl) {
    activeDragCtrl.handlePointerUp();
    activeDragCtrl = null;
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
