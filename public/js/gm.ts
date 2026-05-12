import { connectGM } from './websocket';
import { initCanvas } from './canvas';
import { initTokenLayer } from './tokens';
import { initPingLayer } from './ping';
import { createViewport } from './viewport';
import type { FogStroke } from './canvas';
import * as api from './api';

// --- URL params ---
const fragment = new URLSearchParams(location.hash.slice(1));
const adventureId = fragment.get('id') ?? '';
const password = fragment.get('password') ?? '';

if (!adventureId || !password) {
  const p = document.createElement('p');
  p.style.cssText = 'padding:2rem';
  p.textContent = 'Missing adventure ID or password. ';
  const a = document.createElement('a');
  a.href = '/';
  a.textContent = 'Return home';
  p.appendChild(a);
  document.body.textContent = '';
  document.body.appendChild(p);
  throw new Error('Missing params');
}

// Strip password from visible URL
history.replaceState(null, '', location.pathname);

// --- State ---
let brushRadius = 50;
let brushMode: 'reveal' | 'fog' = 'reveal';
let tokenRadius = 20;
let activeImageId: string | null = null;
let imageList: api.ImageRecord[] = [];
let playerRoster: Array<{ tokenId: string; name: string; color: string; online: boolean }> = [];
let inviteUrl = '';

// --- DOM ---
const adventureNameEl = document.getElementById('adventure-name')!;
const connectionStatusEl = document.getElementById('connection-status')!;
const playerPresenceEl = document.getElementById('player-presence')!;
const canvasArea = document.getElementById('canvas-area')!;

// Toolbox
const toolbox = document.getElementById('toolbox')!;
const tbHistory = document.getElementById('tb-history')!;
const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
const modeRevealBtn = document.getElementById('mode-reveal')!;
const modeFogBtn = document.getElementById('mode-fog')!;
const brushBtn = document.getElementById('brush-btn')!;
const brushSizeLabel = document.getElementById('brush-size-label')!;
const tokenBtn = document.getElementById('token-btn')!;
const tokenSizeLabel = document.getElementById('token-size-label')!;
const playersBt = document.getElementById('players-btn')!;
const playerCount = document.getElementById('player-count')!;
const mapsBtn = document.getElementById('maps-btn')!;

// Popups
const brushPopup = document.getElementById('brush-popup')!;
const brushSizeSlider = document.getElementById('brush-size') as HTMLInputElement;
const tokenPopup = document.getElementById('token-popup')!;
const tokenSizeSlider = document.getElementById('token-size') as HTMLInputElement;

// Sheets
const sheetBackdrop = document.getElementById('sheet-backdrop')!;
const playersSheet = document.getElementById('players-sheet')!;
const playersList = document.getElementById('players-list')!;
const copyInviteBtn = document.getElementById('copy-invite-btn')!;
const mapsSheet = document.getElementById('maps-sheet')!;
const gallery = document.getElementById('gallery')!;
const uploadInput = document.getElementById('upload-input') as HTMLInputElement;

// Share + empty state
const shareBtn = document.getElementById('share-btn')!;
const emptyState = document.getElementById('empty-state')!;
const emptyUploadBtn = document.getElementById('empty-upload-btn')!;

// --- Canvas ---
const canvasCtrl = initCanvas(canvasArea);

// --- Viewport ---
const viewport = createViewport();
viewport.attach(canvasArea, canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize());

// --- Ping layer ---
const pingCtrl = initPingLayer(
  canvasCtrl.getWrapper(),
  () => canvasCtrl.getImageSize(),
  () => viewport.scale
);

function animatePings() {
  pingCtrl.tick();
  requestAnimationFrame(animatePings);
}
requestAnimationFrame(animatePings);

// --- Token layer ---
const tokenCtrl = initTokenLayer(
  canvasCtrl.getWrapper(),
  () => canvasCtrl.getImageSize(),
  (x, y) => viewport.screenToImage(x, y),
  { interactive: true, getRadius: () => tokenRadius }
);
tokenCtrl.enableDragAll((tokenId, x, y) => {
  ws.send({ type: 'token:move', tokenId, x, y });
});

// --- WebSocket ---
const ws = connectGM(adventureId, password);

ws.on('connect', () => { connectionStatusEl.className = 'status-dot connected'; });
ws.on('disconnect', () => { connectionStatusEl.className = 'status-dot disconnected'; });
ws.on('error', (msg) => { console.error('WS error', msg); });

ws.on('joined', async (msg) => {
  const adv = msg.adventure as { id: string; name: string; activeImageId: string | null; tokenSize: number };
  adventureNameEl.textContent = adv.name;
  tokenRadius = adv.tokenSize ?? 20;
  updateTokenSizeLabel();

  try {
    const advData = await api.getAdventure(adventureId, password);
    inviteUrl = `${location.origin}/join/${encodeURIComponent(advData.player_link)}`;
  } catch {}

  activeImageId = adv.activeImageId;
  imageList = await api.listImages(adventureId, password);
  renderGallery();
  updateEmptyState();

  if (activeImageId) {
    const img = imageList.find(i => i.id === activeImageId);
    if (img) {
      await canvasCtrl.loadImage(`/uploads/${img.filename}`);
      viewport.resetView();
      if (typeof msg.fogMask === 'string') await canvasCtrl.applyFogMask(msg.fogMask);
    }
  }

  const tokens = msg.tokens as Array<{ id: string; name: string; color: string; x: number; y: number }>;
  for (const token of tokens) tokenCtrl.addToken(token);

  renderPresence(playerRoster);
});

ws.on('fog:stroke', (msg) => {
  if (msg.imageId === activeImageId) canvasCtrl.applyStroke(msg.stroke as FogStroke);
});

ws.on('fog:stroke:batch', (msg) => {
  if (msg.imageId === activeImageId) {
    for (const stroke of msg.strokes as FogStroke[]) canvasCtrl.applyStroke(stroke);
  }
});

ws.on('token:added', (msg) => {
  tokenCtrl.addToken(msg.token as { id: string; name: string; color: string; x: number; y: number });
});

ws.on('token:moved', (msg) => {
  tokenCtrl.moveToken(msg.tokenId as string, msg.x as number, msg.y as number);
});

ws.on('token:removed', (msg) => { tokenCtrl.removeToken(msg.tokenId as string); });

ws.on('player:roster', (msg) => {
  playerRoster = msg.players as typeof playerRoster;
  renderPresence(playerRoster);
});

ws.on('ping:map', (msg) => {
  pingCtrl.addPing(msg.x as number, msg.y as number, msg.color as string);
});

ws.on('settings:updated', (msg) => {
  tokenRadius = msg.tokenSize as number;
  tokenCtrl.render();
  updateTokenSizeLabel();
});

ws.on('map:switched', async (msg) => {
  activeImageId = msg.imageId as string;
  pingCtrl.clear();
  resetUndoHistory();
  imageList = await api.listImages(adventureId, password);
  const img = imageList.find(i => i.id === activeImageId);
  if (img) {
    await canvasCtrl.loadImage(`/uploads/${img.filename}`);
    viewport.resetView();
    if (typeof msg.fogMask === 'string') await canvasCtrl.applyFogMask(msg.fogMask);
  }
  renderGallery();
  updateEmptyState();
  tokenCtrl.render();
});

ws.on('fog:reset', (msg) => {
  if (msg.imageId === activeImageId && typeof msg.fogMask === 'string') {
    canvasCtrl.applyFogMask(msg.fogMask as string);
  }
});

// --- Empty state ---
function updateEmptyState() {
  emptyState.hidden = imageList.length > 0;
}

emptyUploadBtn.addEventListener('click', () => openSheet(mapsSheet));

// --- Share ---
shareBtn.addEventListener('click', () => {
  if (!inviteUrl) return;
  navigator.clipboard.writeText(inviteUrl).catch(() => {});
  shareBtn.classList.add('active');
  setTimeout(() => shareBtn.classList.remove('active'), 1200);
});

copyInviteBtn.addEventListener('click', () => {
  if (!inviteUrl) return;
  navigator.clipboard.writeText(inviteUrl).catch(() => {});
  copyInviteBtn.textContent = 'Copied!';
  setTimeout(() => { copyInviteBtn.textContent = 'Copy invite link'; }, 1500);
});

// --- Player presence ---
function renderPresence(roster: Array<{ tokenId: string; name: string; color: string; online: boolean }>) {
  const sorted = [...roster].sort((a, b) => (a.online === b.online ? 0 : a.online ? -1 : 1));

  playerPresenceEl.replaceChildren();
  const MAX_VISIBLE = 4;
  const visible = sorted.length > MAX_VISIBLE ? sorted.slice(0, 3) : sorted;
  const overflowCount = sorted.length > MAX_VISIBLE ? sorted.length - 3 : 0;

  for (const player of visible) {
    const avatar = document.createElement('div');
    avatar.className = `presence-avatar ${player.online ? 'online' : 'offline'}`;
    avatar.style.background = player.color;
    avatar.textContent = player.name.charAt(0).toUpperCase();
    avatar.title = player.name;
    playerPresenceEl.appendChild(avatar);
  }

  if (overflowCount > 0) {
    const overflow = document.createElement('div');
    overflow.className = 'presence-avatar presence-overflow';
    overflow.textContent = `+${overflowCount}`;
    playerPresenceEl.appendChild(overflow);
  }

  const online = roster.filter(p => p.online).length;
  playerCount.textContent = roster.length > 0 ? String(online) : '';

  renderPlayersList(sorted);
}

function renderPlayersList(roster: Array<{ tokenId: string; name: string; color: string; online: boolean }>) {
  playersList.replaceChildren();
  for (const player of roster) {
    const row = document.createElement('div');
    row.className = 'player-row';

    const dot = document.createElement('span');
    dot.className = 'player-row-dot';
    dot.style.background = player.color;

    const name = document.createElement('span');
    name.className = 'player-row-name';
    name.textContent = player.name;

    const status = document.createElement('span');
    status.className = `player-row-status${player.online ? ' online' : ''}`;
    status.textContent = player.online ? 'online' : 'offline';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'player-row-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      ws.send({ type: 'player:remove', tokenId: player.tokenId });
    });

    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(status);
    row.appendChild(removeBtn);
    playersList.appendChild(row);
  }
}

// --- Sheet management ---
function openSheet(sheet: HTMLElement) {
  closeAllPopups();
  sheetBackdrop.removeAttribute('hidden');
  sheet.removeAttribute('hidden');
}

function closeSheet(sheet: HTMLElement) {
  sheet.setAttribute('hidden', '');
  if (playersSheet.hasAttribute('hidden') && mapsSheet.hasAttribute('hidden')) {
    sheetBackdrop.setAttribute('hidden', '');
  }
}

sheetBackdrop.addEventListener('click', () => {
  closeSheet(playersSheet);
  closeSheet(mapsSheet);
  sheetBackdrop.setAttribute('hidden', '');
});

document.getElementById('players-close')!.addEventListener('click', () => closeSheet(playersSheet));
document.getElementById('maps-close')!.addEventListener('click', () => closeSheet(mapsSheet));

playersBt.addEventListener('click', () => openSheet(playersSheet));
mapsBtn.addEventListener('click', () => openSheet(mapsSheet));

// --- Gallery ---
function renderGallery() {
  gallery.replaceChildren();
  for (const img of imageList) {
    const item = document.createElement('div');
    item.className = 'gallery-item' + (img.id === activeImageId ? ' active' : '');

    const thumb = document.createElement('img');
    thumb.src = `/uploads/${img.filename}`;
    thumb.alt = img.original_name;
    thumb.title = img.original_name;
    item.appendChild(thumb);

    item.addEventListener('click', () => {
      ws.send({ type: 'map:switch', imageId: img.id });
      closeSheet(mapsSheet);
    });
    gallery.appendChild(item);
  }
}

// --- Upload ---
uploadInput.addEventListener('change', async () => {
  const file = uploadInput.files?.[0];
  if (!file) return;
  try {
    await api.uploadImage(adventureId, password, file);
    imageList = await api.listImages(adventureId, password);
    renderGallery();
    updateEmptyState();
  } catch (e) {
    console.error('Upload failed', e);
  }
  uploadInput.value = '';
});

// --- Mode ---
function setMode(mode: 'reveal' | 'fog') {
  brushMode = mode;
  modeRevealBtn.classList.toggle('active', mode === 'reveal');
  modeFogBtn.classList.toggle('active', mode === 'fog');
}

modeRevealBtn.addEventListener('click', () => setMode('reveal'));
modeFogBtn.addEventListener('click', () => setMode('fog'));

// --- Brush size ---
function updateBrushLabel() {
  brushSizeLabel.textContent = String(brushRadius);
  brushSizeSlider.value = String(brushRadius);
}

brushSizeSlider.addEventListener('input', () => {
  brushRadius = parseInt(brushSizeSlider.value, 10);
  brushSizeLabel.textContent = String(brushRadius);
});

// Shift+scroll to resize brush (capture phase before viewport zoom handler)
canvasArea.addEventListener('wheel', (ev) => {
  if (!ev.shiftKey) return;
  ev.preventDefault();
  ev.stopPropagation();
  const delta = ev.deltaY > 0 ? -5 : 5;
  brushRadius = Math.max(10, Math.min(200, brushRadius + delta));
  updateBrushLabel();
}, { passive: false, capture: true });

// --- Token size ---
function updateTokenSizeLabel() {
  tokenSizeLabel.textContent = String(tokenRadius);
  tokenSizeSlider.value = String(tokenRadius);
}

tokenSizeSlider.addEventListener('input', () => {
  tokenRadius = parseInt(tokenSizeSlider.value, 10);
  tokenCtrl.render();
  updateTokenSizeLabel();
  ws.send({ type: 'settings:update', tokenSize: tokenRadius });
});

// --- Popup management ---
function closeAllPopups() {
  brushPopup.setAttribute('hidden', '');
  brushBtn.classList.remove('active');
  tokenPopup.setAttribute('hidden', '');
  tokenBtn.classList.remove('active');
}

function togglePopup(popup: HTMLElement, anchorBtn: HTMLElement) {
  const isOpen = !popup.hasAttribute('hidden');
  closeAllPopups();
  if (isOpen) return;

  const rect = anchorBtn.getBoundingClientRect();
  const popupWidth = 200;
  let left = rect.left + rect.width / 2 - popupWidth / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - popupWidth - 8));
  popup.style.left = `${left}px`;
  popup.style.bottom = `${window.innerHeight - rect.top + 8}px`;

  popup.removeAttribute('hidden');
  anchorBtn.classList.add('active');
}

brushBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePopup(brushPopup, brushBtn); });
tokenBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePopup(tokenPopup, tokenBtn); });

document.addEventListener('click', () => closeAllPopups());
brushPopup.addEventListener('click', (e) => e.stopPropagation());
tokenPopup.addEventListener('click', (e) => e.stopPropagation());

// --- Undo/redo ---
const MAX_HISTORY = 50;
let undoStack: FogStroke[][] = [];
let redoStack: FogStroke[][] = [];
let currentAction: FogStroke[] = [];

function updateUndoRedoButtons() {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
  tbHistory.hidden = undoStack.length === 0 && redoStack.length === 0;
}

function sendUndo(strokes: FogStroke[]) { ws.send({ type: 'fog:undo', strokes }); }

function performUndo() {
  if (!undoStack.length) return;
  redoStack.push(undoStack.pop()!);
  sendUndo(undoStack.flat());
  updateUndoRedoButtons();
}

function performRedo() {
  if (!redoStack.length) return;
  undoStack.push(redoStack.pop()!);
  sendUndo(undoStack.flat());
  updateUndoRedoButtons();
}

function resetUndoHistory() {
  undoStack = [];
  redoStack = [];
  currentAction = [];
  updateUndoRedoButtons();
}

undoBtn.addEventListener('click', performUndo);
redoBtn.addEventListener('click', performRedo);

document.addEventListener('keydown', (ev) => {
  const ctrl = ev.ctrlKey || ev.metaKey;
  if (!ctrl) return;
  if (ev.key === 'z' || ev.key === 'Z') {
    ev.preventDefault();
    ev.shiftKey ? performRedo() : performUndo();
  } else if (ev.key === 'y' || ev.key === 'Y') {
    ev.preventDefault();
    performRedo();
  }
});

// --- Brush painting ---
let isDrawing = false;
let isPinging = false;
let isDraggingToken = false;
const pending: FogStroke[] = [];
let lastFlush = 0;
const FLUSH_INTERVAL = 1000 / 60;

const GM_PING_COLOR = '#4a4aff';
const LONG_PRESS_DELAY = 400;
const PING_RATE_LIMIT = 1000;
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressStartPos: { x: number; y: number } | null = null;
let lastPingTime = 0;

function cancelLongPress() {
  if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null; }
  longPressStartPos = null;
}

function makeStroke(clientX: number, clientY: number): FogStroke {
  const pos = viewport.screenToImage(clientX, clientY);
  return { x: pos.x, y: pos.y, radius: brushRadius, mode: brushMode };
}

function flushPending() {
  if (!pending.length) return;
  if (pending.length === 1) {
    ws.send({ type: 'fog:stroke', stroke: pending[0] });
  } else {
    ws.send({ type: 'fog:stroke:batch', strokes: pending.slice() });
  }
  pending.length = 0;
  lastFlush = Date.now();
}

viewport.onInteractStart((ev: PointerEvent) => {
  if (!activeImageId) return;
  closeAllPopups();

  tokenCtrl.handlePointerDown(ev);
  if (tokenCtrl.isDragging()) { isDraggingToken = true; return; }
  isDraggingToken = false;

  toolbox.classList.add('painting');

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
      const pos = viewport.screenToImage(longPressStartPos!.x, longPressStartPos!.y);
      ws.send({ type: 'ping:map', x: pos.x, y: pos.y, color: GM_PING_COLOR });
    }
  }, LONG_PRESS_DELAY);

  isDrawing = true;
  currentAction = [];
  const stroke = makeStroke(ev.clientX, ev.clientY);
  canvasCtrl.applyStroke(stroke);
  pending.push(stroke);
  currentAction.push(stroke);
  if (Date.now() - lastFlush >= FLUSH_INTERVAL) flushPending();
});

viewport.onPointerMove((ev: PointerEvent) => {
  if (isDraggingToken) { tokenCtrl.handlePointerMove(ev); return; }

  const pos = viewport.screenToImage(ev.clientX, ev.clientY);
  canvasCtrl.drawBrushPreview(pos.x, pos.y, brushRadius, viewport.scale);

  if (longPressTimer !== null && longPressStartPos !== null) {
    const dx = ev.clientX - longPressStartPos.x;
    const dy = ev.clientY - longPressStartPos.y;
    if (dx * dx + dy * dy > 25) cancelLongPress();
  }

  if (!isDrawing || isPinging) return;
  const stroke = makeStroke(ev.clientX, ev.clientY);
  canvasCtrl.applyStroke(stroke);
  pending.push(stroke);
  currentAction.push(stroke);
  if (Date.now() - lastFlush >= FLUSH_INTERVAL) flushPending();
});

function finishAction() {
  toolbox.classList.remove('painting');
  if (isDraggingToken) { tokenCtrl.handlePointerUp(); isDraggingToken = false; return; }
  if (!isDrawing) return;
  isDrawing = false;
  flushPending();
  if (currentAction.length > 0) {
    undoStack.push(currentAction);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];
    currentAction = [];
    updateUndoRedoButtons();
  }
}

viewport.onInteractEnd(() => { cancelLongPress(); isPinging = false; finishAction(); });
viewport.onPointerLeave(() => {
  canvasCtrl.clearBrushPreview();
  cancelLongPress();
  isPinging = false;
  finishAction();
});
