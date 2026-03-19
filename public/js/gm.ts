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
  document.body.innerHTML = '<p style="padding:2rem">Missing adventure ID or password. <a href="/">Return home</a></p>';
  throw new Error('Missing params');
}

// --- State ---
let brushRadius = 50;
let brushMode: 'reveal' | 'fog' = 'reveal';
let tokenRadius = 20;
let activeImageId: string | null = null;
let imageList: api.ImageRecord[] = [];
let playerRoster: Array<{ tokenId: string; name: string; color: string; online: boolean }> = [];
let inviteUrl = '';
let presencePopover: HTMLElement | null = null;

// --- DOM ---
const adventureNameEl = document.getElementById('adventure-name')!;
const connectionStatusEl = document.getElementById('connection-status')!;
const playerPresenceEl = document.getElementById('player-presence')!;
const brushSizeSlider = document.getElementById('brush-size') as HTMLInputElement;
const brushSizeLabel = document.getElementById('brush-size-label')!;
const modeRevealBtn = document.getElementById('mode-reveal')!;
const modeFogBtn = document.getElementById('mode-fog')!;
const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
const mapPanelToggleBtn = document.getElementById('map-panel-toggle')!;
const mapPanel = document.getElementById('map-panel')!;
const gallery = document.getElementById('gallery')!;
const uploadInput = document.getElementById('upload-input') as HTMLInputElement;
const statusBar = document.getElementById('status-bar')!;
const canvasArea = document.getElementById('canvas-area')!;
const modeToggle = document.getElementById('mode-toggle')!;

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

// --- Token layer (GM can move any token) ---
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

ws.on('connect', () => {
  connectionStatusEl.className = 'status-dot connected';
  statusBar.textContent = '';
});
ws.on('disconnect', () => {
  connectionStatusEl.className = 'status-dot disconnected';
  statusBar.textContent = '';
});
ws.on('error', (msg) => { console.error('WS error', msg); });

ws.on('joined', async (msg) => {
  const adv = msg.adventure as { id: string; name: string; activeImageId: string | null; tokenSize: number };
  adventureNameEl.textContent = adv.name;
  tokenRadius = adv.tokenSize ?? 20;
  updateTokenSizeLabel();

  try {
    const advData = await api.getAdventure(adventureId, password);
    inviteUrl = `${location.origin}/player#link=${encodeURIComponent(advData.player_link)}`;
  } catch {}

  activeImageId = adv.activeImageId;
  imageList = await api.listImages(adventureId, password);
  renderGallery();

  if (activeImageId) {
    const img = imageList.find(i => i.id === activeImageId);
    if (img) {
      await canvasCtrl.loadImage(`/uploads/${img.filename}`);
      viewport.resetView();
      if (typeof msg.fogMask === 'string') {
        await canvasCtrl.applyFogMask(msg.fogMask);
      }
    }
  }

  const tokens = msg.tokens as Array<{ id: string; name: string; color: string; x: number; y: number }>;
  for (const token of tokens) {
    tokenCtrl.addToken(token);
  }

  renderPresence(playerRoster);
});

ws.on('fog:stroke', (msg) => {
  if (msg.imageId === activeImageId) {
    canvasCtrl.applyStroke(msg.stroke as FogStroke);
  }
});

ws.on('fog:stroke:batch', (msg) => {
  if (msg.imageId === activeImageId) {
    for (const stroke of msg.strokes as FogStroke[]) {
      canvasCtrl.applyStroke(stroke);
    }
  }
});

ws.on('token:added', (msg) => {
  const token = msg.token as { id: string; name: string; color: string; x: number; y: number };
  tokenCtrl.addToken(token);
});

ws.on('token:moved', (msg) => {
  tokenCtrl.moveToken(msg.tokenId as string, msg.x as number, msg.y as number);
});

ws.on('token:removed', (msg) => {
  tokenCtrl.removeToken(msg.tokenId as string);
});

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
    if (typeof msg.fogMask === 'string') {
      await canvasCtrl.applyFogMask(msg.fogMask);
    }
  }
  renderGallery();
  tokenCtrl.render();
});

ws.on('fog:reset', (msg) => {
  if (msg.imageId === activeImageId && typeof msg.fogMask === 'string') {
    canvasCtrl.applyFogMask(msg.fogMask as string);
  }
});

// --- Player presence ---
function renderPresence(roster: Array<{ tokenId: string; name: string; color: string; online: boolean }>) {
  const sorted = [...roster].sort((a, b) => {
    if (a.online === b.online) return 0;
    return a.online ? -1 : 1;
  });

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
    avatar.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePresencePopover(sorted);
    });
    playerPresenceEl.appendChild(avatar);
  }

  if (overflowCount > 0) {
    const overflowEl = document.createElement('div');
    overflowEl.className = 'presence-avatar presence-overflow';
    overflowEl.textContent = `+${overflowCount}`;
    overflowEl.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePresencePopover(sorted);
    });
    playerPresenceEl.appendChild(overflowEl);
  }
}

function togglePresencePopover(roster: Array<{ tokenId: string; name: string; color: string; online: boolean }>) {
  if (presencePopover) {
    presencePopover.remove();
    presencePopover = null;
    return;
  }

  presencePopover = document.createElement('div');
  presencePopover.className = 'presence-popover';

  for (const player of roster) {
    const row = document.createElement('div');
    row.className = 'popover-player';

    const dot = document.createElement('span');
    dot.className = 'popover-player-dot';
    dot.style.background = player.color;

    const name = document.createElement('span');
    name.className = 'popover-player-name';
    name.textContent = player.name;

    const status = document.createElement('span');
    status.className = 'popover-player-status';
    status.textContent = player.online ? 'online' : 'offline';

    const actions = document.createElement('div');
    actions.className = 'popover-player-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'popover-btn';
    copyBtn.textContent = 'Copy link';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(inviteUrl).catch(() => {});
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'popover-btn danger';
    removeBtn.textContent = '\u2715';
    removeBtn.title = 'Remove player';
    removeBtn.addEventListener('click', () => {
      ws.send({ type: 'player:remove', tokenId: player.tokenId });
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
    document.addEventListener('click', closePresencePopover, { once: true });
  }, 0);
}

function closePresencePopover() {
  presencePopover?.remove();
  presencePopover = null;
}

// --- Map panel toggle ---
mapPanelToggleBtn.addEventListener('click', () => {
  const isOpen = mapPanel.hasAttribute('hidden');
  if (isOpen) {
    mapPanel.removeAttribute('hidden');
  } else {
    mapPanel.setAttribute('hidden', '');
  }
  mapPanelToggleBtn.classList.toggle('active', isOpen);
});

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
  } catch (e) {
    console.error('Upload failed', e);
  }
  uploadInput.value = '';
});

// --- Brush controls ---
brushSizeSlider.addEventListener('input', () => {
  brushRadius = parseInt(brushSizeSlider.value, 10);
  brushSizeLabel.textContent = `${brushRadius}`;
});

function setMode(mode: 'reveal' | 'fog') {
  brushMode = mode;
  modeRevealBtn.classList.toggle('active', mode === 'reveal');
  modeFogBtn.classList.toggle('active', mode === 'fog');
}

modeRevealBtn.addEventListener('click', () => setMode('reveal'));
modeFogBtn.addEventListener('click', () => setMode('fog'));

// --- Token size control ---
const tokenSizeBtn = document.createElement('button');
tokenSizeBtn.id = 'token-size-btn';
tokenSizeBtn.textContent = `\u25CF ${tokenRadius}`;
tokenSizeBtn.title = 'Token size';
modeToggle.appendChild(tokenSizeBtn);

const tokenSizePopup = document.createElement('div');
tokenSizePopup.id = 'token-size-popup';
tokenSizePopup.className = 'floating-control';
tokenSizePopup.hidden = true;

const tokenSizeSlider = document.createElement('input');
tokenSizeSlider.type = 'range';
tokenSizeSlider.min = '5';
tokenSizeSlider.max = '100';
tokenSizeSlider.value = String(tokenRadius);
tokenSizePopup.appendChild(tokenSizeSlider);
document.body.appendChild(tokenSizePopup);

function updateTokenSizeLabel() {
  tokenSizeBtn.textContent = `\u25CF ${tokenRadius}`;
  tokenSizeSlider.value = String(tokenRadius);
}

tokenSizeBtn.addEventListener('click', () => {
  tokenSizePopup.hidden = !tokenSizePopup.hidden;
  tokenSizeBtn.classList.toggle('active', !tokenSizePopup.hidden);
});

tokenSizeSlider.addEventListener('input', () => {
  tokenRadius = parseInt(tokenSizeSlider.value, 10);
  tokenCtrl.render();
  updateTokenSizeLabel();
  ws.send({ type: 'settings:update', tokenSize: tokenRadius });
});

// --- Undo/redo history ---
const MAX_HISTORY = 50;
let undoStack: FogStroke[][] = [];
let redoStack: FogStroke[][] = [];
let currentAction: FogStroke[] = [];

function updateUndoRedoButtons() {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
}

function sendUndo(strokes: FogStroke[]) {
  ws.send({ type: 'fog:undo', strokes });
}

function performUndo() {
  if (undoStack.length === 0) return;
  const action = undoStack.pop()!;
  redoStack.push(action);
  sendUndo(undoStack.flat());
  updateUndoRedoButtons();
}

function performRedo() {
  if (redoStack.length === 0) return;
  const action = redoStack.pop()!;
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

undoBtn.addEventListener('click', performUndo);
redoBtn.addEventListener('click', performRedo);

document.addEventListener('keydown', (ev) => {
  const ctrl = ev.ctrlKey || ev.metaKey;
  if (!ctrl) return;
  if (ev.key === 'z' || ev.key === 'Z') {
    if (ev.shiftKey) {
      ev.preventDefault();
      performRedo();
    } else {
      ev.preventDefault();
      performUndo();
    }
  } else if (ev.key === 'y' || ev.key === 'Y') {
    ev.preventDefault();
    performRedo();
  }
});

// --- Brush interaction ---
let isDrawing = false;
let isPinging = false;
const pending: FogStroke[] = [];
let lastFlush = 0;
const FLUSH_INTERVAL = 1000 / 60;

// Long-press detection (500ms total: 100ms grace already elapsed, 400ms more)
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
  if (pending.length === 0) return;
  if (pending.length === 1) {
    ws.send({ type: 'fog:stroke', stroke: pending[0] });
  } else {
    ws.send({ type: 'fog:stroke:batch', strokes: pending.slice() });
  }
  pending.length = 0;
  lastFlush = Date.now();
}

let isDraggingToken = false;

viewport.onInteractStart((ev: PointerEvent) => {
  if (!activeImageId) return;

  // Check if clicking on a token — drag instead of paint
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
  if (isDraggingToken) {
    tokenCtrl.handlePointerMove(ev);
    return;
  }

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
  if (isDraggingToken) {
    tokenCtrl.handlePointerUp();
    isDraggingToken = false;
    return;
  }
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
