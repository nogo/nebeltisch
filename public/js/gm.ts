import { connectGM } from './websocket';
import { initCanvas } from './canvas';
import { initTokenLayer } from './tokens';
import type { TokenController } from './tokens';
import { initPingLayer } from './ping';
import { createViewport } from './viewport';
import type { FogStroke } from './canvas';
import * as api from './api';

// --- URL params ---
// The hash is never transmitted to the server (HTTP spec), so keeping the
// password here is safe. We leave it in place so refresh and cross-browser
// copy-paste both work without any extra storage.
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
const placeTokenBtn = document.getElementById('place-token-btn')!;
const startPointBtn = document.getElementById('start-point-btn')!;
const flagIconTemplate = document.getElementById('flag-icon') as HTMLTemplateElement;

// Token placement form
const tokenPlaceForm = document.getElementById('token-place-form')!;
const tpMonsterBtn = document.getElementById('tp-monster')!;
const tpNpcBtn = document.getElementById('tp-npc')!;
const tpNameInput = document.getElementById('tp-name') as HTMLInputElement;
const tpCancelBtn = document.getElementById('tp-cancel')!;
const tpConfirmBtn = document.getElementById('tp-confirm')!;

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

// --- GM token layer (below fog — monsters/NPCs hidden by fog) ---
const gmTokenCtrl = initTokenLayer(
  canvasCtrl.getWrapper(),
  () => canvasCtrl.getImageSize(),
  (x, y) => viewport.screenToImage(x, y),
  {
    interactive: false,
    insertBefore: canvasCtrl.getFogCanvas(),
    getRadius: () => tokenRadius,
    getScale: () => viewport.scale,
    onDoubleClickToken: (tokenId) => {
      ws.send({ type: 'gm_token:remove', tokenId });
    },
  }
);
gmTokenCtrl.enableDragAll((tokenId, x, y) => {
  ws.send({ type: 'token:move', tokenId, x, y });
});

// dblclick on canvasArea routes to gmTokenCtrl (its canvas has pointer-events:none, can't listen directly)
canvasArea.addEventListener('dblclick', (ev) => {
  gmTokenCtrl.handleDoubleClick(ev);
});

// --- Token layer ---
const tokenCtrl = initTokenLayer(
  canvasCtrl.getWrapper(),
  () => canvasCtrl.getImageSize(),
  (x, y) => viewport.screenToImage(x, y),
  { interactive: true, getRadius: () => tokenRadius, getScale: () => viewport.scale }
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
  const adv = msg.adventure;
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

  const tokens = msg.tokens;
  for (const token of tokens) {
    if (token.token_type === 'monster' || token.token_type === 'npc') {
      gmTokenCtrl.addToken(token);
    } else {
      tokenCtrl.addToken(token);
    }
  }

  syncStartPointFromImageList();
  renderPresence(playerRoster);
});

ws.on('fog:stroke', (msg) => {
  if (msg.imageId === activeImageId) canvasCtrl.applyStroke(msg.stroke);
});

ws.on('fog:stroke:batch', (msg) => {
  if (msg.imageId === activeImageId) {
    for (const stroke of msg.strokes) canvasCtrl.applyStroke(stroke);
  }
});

ws.on('token:added', (msg) => {
  tokenCtrl.addToken(msg.token);
});

ws.on('gm_token:added', (msg) => {
  gmTokenCtrl.addToken(msg.token);
});

ws.on('token:moved', (msg) => {
  // The id lives in exactly one controller; moveToken no-ops on the other.
  tokenCtrl.moveToken(msg.tokenId, msg.x, msg.y);
  gmTokenCtrl.moveToken(msg.tokenId, msg.x, msg.y);
});

ws.on('token:removed', (msg) => {
  const id = msg.tokenId;
  tokenCtrl.removeToken(id);
  gmTokenCtrl.removeToken(id);
});

ws.on('player:roster', (msg) => {
  playerRoster = msg.players;
  renderPresence(playerRoster);
  renderStartMarker(); // ring size tracks the party size
});

ws.on('ping:map', (msg) => {
  pingCtrl.addPing(msg.x, msg.y, msg.color);
});

ws.on('settings:updated', (msg) => {
  tokenRadius = msg.tokenSize;
  tokenCtrl.render();
  gmTokenCtrl.render();
  renderStartMarker();
  updateTokenSizeLabel();
});

function deactivatePlaceMode() {
  placeModeActive = false;
  placeTokenBtn.classList.remove('active');
  document.body.classList.remove('placing');
  hidePlaceForm();
}

ws.on('map:switched', async (msg) => {
  activeImageId = msg.imageId;
  pingCtrl.clear();

  imageList = await api.listImages(adventureId, password);
  const img = imageList.find(i => i.id === activeImageId);
  if (img) {
    await canvasCtrl.loadImage(`/uploads/${img.filename}`);
    viewport.resetView();
    if (typeof msg.fogMask === 'string') await canvasCtrl.applyFogMask(msg.fogMask);
  }
  renderGallery();
  updateEmptyState();
  // The server moves the party onto the new map's start point.
  const movedPlayers = msg.playerTokens;
  for (const t of movedPlayers ?? []) tokenCtrl.moveToken(t.id, t.x, t.y);
  tokenCtrl.render();
  syncStartPointFromImageList();
  // Swap GM tokens for the new map
  gmTokenCtrl.clear();
  const newGmTokens = msg.gmTokens;
  for (const t of newGmTokens ?? []) gmTokenCtrl.addToken(t);
});

ws.on('fog:reset', (msg) => {
  if (msg.imageId === activeImageId && typeof msg.fogMask === 'string') {
    canvasCtrl.applyFogMask(msg.fogMask);
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

// --- Start point mode ---
// Where the party lands when this map is activated. GM-only: the marker is never
// sent to players, so they cannot see where they will appear.
let startPointModeActive = false;
let startPoint: { x: number; y: number } | null = null;

// A plain circle reads as just another token next to prepared monsters and
// NPCs. The marker is a flag on a pole with a labelled ring showing where the
// party will actually land — a different shape, not just a different colour.
const startMarker = document.createElement('div');
startMarker.id = 'start-marker';
startMarker.hidden = true;
const startMarkerFlag = document.createElement('div');
startMarkerFlag.id = 'start-marker-flag';
startMarkerFlag.appendChild(flagIconTemplate.content.cloneNode(true));
const startMarkerLabel = document.createElement('span');
startMarkerLabel.id = 'start-marker-label';
startMarkerLabel.textContent = 'Start';
startMarker.append(startMarkerFlag, startMarkerLabel);
canvasCtrl.getWrapper().appendChild(startMarker);

/** Mirrors gatherRingRadius on the server so the ring shows the real landing area. */
function gatherRingRadius(count: number): number {
  return tokenRadius * Math.max(2.2, Math.max(count, 1) * 0.45);
}

function renderStartMarker() {
  if (!startPoint) {
    startMarker.hidden = true;
    return;
  }
  const size = gatherRingRadius(playerRoster.length) * 2;
  startMarker.style.width = `${size}px`;
  startMarker.style.height = `${size}px`;
  startMarker.style.left = `${startPoint.x}px`;
  startMarker.style.top = `${startPoint.y}px`;
  const glyph = Math.max(16, tokenRadius * 1.6);
  startMarkerFlag.style.width = `${glyph}px`;
  startMarkerFlag.style.height = `${glyph}px`;
  startMarkerLabel.style.fontSize = `${Math.max(9, tokenRadius * 0.6)}px`;
  startMarker.hidden = false;
}

function deactivateStartPointMode() {
  startPointModeActive = false;
  startPointBtn.classList.remove('active');
  document.body.classList.remove('setting-start');
}

startPointBtn.addEventListener('click', () => {
  if (!activeImageId) return;
  startPointModeActive = !startPointModeActive;
  startPointBtn.classList.toggle('active', startPointModeActive);
  document.body.classList.toggle('setting-start', startPointModeActive);
  if (startPointModeActive) deactivatePlaceMode();
});

ws.on('map:start_point:set', (msg) => {
  const id = msg.imageId;
  const x = msg.x;
  const y = msg.y;

  const img = imageList.find(i => i.id === id);
  if (img) { img.start_x = x; img.start_y = y; }

  if (id === activeImageId) {
    startPoint = x != null && y != null ? { x, y } : null;
    renderStartMarker();
  }
  if (id === pickerImageId) positionPickerDot();
  renderGallery();
});

// --- Start point picker ---
// Lets the GM set a start point on any map without activating it, which would
// otherwise show that map to players and teleport the party onto it.
const startPicker = document.getElementById('start-picker')!;
const startPickerImg = document.getElementById('start-picker-img') as HTMLImageElement;
const startPickerDot = document.getElementById('start-picker-dot')!;
const startPickerTitle = document.getElementById('start-picker-title')!;
const startPickerClose = document.getElementById('start-picker-close')!;
const startPickerClear = document.getElementById('start-picker-clear')!;
let pickerImageId: string | null = null;

function positionPickerDot() {
  const rec = imageList.find(i => i.id === pickerImageId);
  const w = startPickerImg.naturalWidth;
  const h = startPickerImg.naturalHeight;
  if (!rec || rec.start_x == null || rec.start_y == null || !w || !h) {
    startPickerDot.setAttribute('hidden', '');
    return;
  }
  const rect = startPickerImg.getBoundingClientRect();
  const stage = startPickerImg.parentElement!.getBoundingClientRect();
  startPickerDot.style.left = `${(rec.start_x / w) * rect.width + (rect.left - stage.left)}px`;
  startPickerDot.style.top = `${(rec.start_y / h) * rect.height + (rect.top - stage.top)}px`;
  startPickerDot.removeAttribute('hidden');
}

function openStartPicker(img: api.ImageRecord) {
  pickerImageId = img.id;
  startPickerTitle.textContent = img.original_name;
  startPickerDot.setAttribute('hidden', '');
  startPickerImg.onload = positionPickerDot;
  startPickerImg.src = `/uploads/${img.filename}`;
  startPicker.removeAttribute('hidden');
  if (startPickerImg.complete) positionPickerDot();
}

function closeStartPicker() {
  startPicker.setAttribute('hidden', '');
  pickerImageId = null;
}

startPickerImg.addEventListener('click', (ev) => {
  const w = startPickerImg.naturalWidth;
  const h = startPickerImg.naturalHeight;
  if (!pickerImageId || !w || !h) return;
  const rect = startPickerImg.getBoundingClientRect();
  const x = Math.round(((ev.clientX - rect.left) / rect.width) * w);
  const y = Math.round(((ev.clientY - rect.top) / rect.height) * h);
  ws.send({ type: 'map:start_point', imageId: pickerImageId, x, y });
});

startPickerClear.addEventListener('click', () => {
  if (!pickerImageId) return;
  ws.send({ type: 'map:start_point', imageId: pickerImageId, x: null, y: null });
});

startPickerClose.addEventListener('click', closeStartPicker);
startPicker.addEventListener('click', (ev) => {
  if (ev.target === startPicker) closeStartPicker();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !startPicker.hasAttribute('hidden')) closeStartPicker();
});

/** Restores the marker for whichever map is active. */
function syncStartPointFromImageList() {
  const img = imageList.find(i => i.id === activeImageId);
  startPoint = img && img.start_x != null && img.start_y != null
    ? { x: img.start_x, y: img.start_y }
    : null;
  renderStartMarker();
}

// --- Place token mode ---
let placeModeActive = false;
let pendingPlacePos: { x: number; y: number } | null = null;
let pendingTokenType: 'monster' | 'npc' = 'monster';

placeTokenBtn.addEventListener('click', () => {
  placeModeActive = !placeModeActive;
  placeTokenBtn.classList.toggle('active', placeModeActive);
  document.body.classList.toggle('placing', placeModeActive);
  if (!placeModeActive) hidePlaceForm();
});

tpMonsterBtn.addEventListener('click', () => {
  pendingTokenType = 'monster';
  tpMonsterBtn.classList.add('active');
  tpNpcBtn.classList.remove('active');
});

tpNpcBtn.addEventListener('click', () => {
  pendingTokenType = 'npc';
  tpNpcBtn.classList.add('active');
  tpMonsterBtn.classList.remove('active');
});

tpCancelBtn.addEventListener('click', hidePlaceForm);

tpConfirmBtn.addEventListener('click', () => {
  const name = tpNameInput.value.trim();
  if (!name || !pendingPlacePos) return;
  ws.send({ type: 'gm_token:place', name, tokenType: pendingTokenType, x: pendingPlacePos.x, y: pendingPlacePos.y });
  hidePlaceForm();
});

tpNameInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') tpConfirmBtn.click();
  if (ev.key === 'Escape') hidePlaceForm();
});

function showPlaceForm(screenX: number, screenY: number, imageX: number, imageY: number) {
  pendingPlacePos = { x: imageX, y: imageY };
  tpNameInput.value = '';

  const formW = 180;
  const formH = 130;
  let left = screenX + 12;
  let top = screenY - formH / 2;
  if (left + formW > window.innerWidth - 8) left = screenX - formW - 12;
  if (top < 8) top = 8;
  if (top + formH > window.innerHeight - 8) top = window.innerHeight - formH - 8;

  tokenPlaceForm.style.left = `${left}px`;
  tokenPlaceForm.style.top = `${top}px`;
  tokenPlaceForm.removeAttribute('hidden');
  tpNameInput.focus();
}

function hidePlaceForm() {
  tokenPlaceForm.setAttribute('hidden', '');
  pendingPlacePos = null;
}

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

    const startBtn = document.createElement('button');
    startBtn.className = 'gallery-start-btn' + (img.start_x != null ? ' has-point' : '');
    startBtn.title = img.start_x != null ? 'Change party start point' : 'Set party start point';
    startBtn.appendChild(flagIconTemplate.content.cloneNode(true));
    // Must not fall through to the item handler, which would activate the map.
    startBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openStartPicker(img);
    });
    item.appendChild(startBtn);

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
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && placeModeActive) deactivatePlaceMode();
});
brushPopup.addEventListener('click', (e) => e.stopPropagation());
tokenPopup.addEventListener('click', (e) => e.stopPropagation());

// --- Undo/redo ---
// Fog history lives on the server. A stack held here is empty after every page
// reload, so undoing from it would rebuild the mask from nothing and wipe the
// map. The client only tracks whether the current action has sent any strokes.
let actionHasStrokes = false;

function updateUndoRedoButtons(canUndo: boolean, canRedo: boolean) {
  undoBtn.disabled = !canUndo;
  redoBtn.disabled = !canRedo;
  tbHistory.hidden = !canUndo && !canRedo;
}

function performUndo() { ws.send({ type: 'fog:undo' }); }
function performRedo() { ws.send({ type: 'fog:redo' }); }

ws.on('fog:history', (msg) => {
  if (msg.imageId !== activeImageId) return;
  updateUndoRedoButtons(msg.canUndo, msg.canRedo);
});

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
let activeDragCtrl: TokenController | null = null;
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

  // Start point mode — one click sets it, then exits
  if (startPointModeActive) {
    const pos = viewport.screenToImage(ev.clientX, ev.clientY);
    ws.send({ type: 'map:start_point', imageId: activeImageId, x: pos.x, y: pos.y });
    deactivateStartPointMode();
    return;
  }

  // Place token mode — show form on click, skip painting
  if (placeModeActive) {
    const pos = viewport.screenToImage(ev.clientX, ev.clientY);
    showPlaceForm(ev.clientX, ev.clientY, pos.x, pos.y);
    return;
  }

  // Check player tokens first, then GM tokens
  tokenCtrl.handlePointerDown(ev);
  if (tokenCtrl.isDragging()) { activeDragCtrl = tokenCtrl; return; }
  gmTokenCtrl.handlePointerDown(ev);
  if (gmTokenCtrl.isDragging()) { activeDragCtrl = gmTokenCtrl; return; }
  activeDragCtrl = null;

  toolbox.classList.add('painting');

  longPressStartPos = { x: ev.clientX, y: ev.clientY };
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    const now = Date.now();
    if (now - lastPingTime >= PING_RATE_LIMIT) {
      lastPingTime = now;
      isDrawing = false;
      actionHasStrokes = false;
      pending.length = 0;
      isPinging = true;
      const pos = viewport.screenToImage(longPressStartPos!.x, longPressStartPos!.y);
      ws.send({ type: 'ping:map', x: pos.x, y: pos.y, color: GM_PING_COLOR });
    }
  }, LONG_PRESS_DELAY);

  isDrawing = true;
  const stroke = makeStroke(ev.clientX, ev.clientY);
  canvasCtrl.applyStroke(stroke);
  pending.push(stroke);
  actionHasStrokes = true;
  if (Date.now() - lastFlush >= FLUSH_INTERVAL) flushPending();
});

viewport.onPointerMove((ev: PointerEvent) => {
  if (activeDragCtrl) { activeDragCtrl.handlePointerMove(ev); return; }

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
  actionHasStrokes = true;
  if (Date.now() - lastFlush >= FLUSH_INTERVAL) flushPending();
});

function finishAction() {
  toolbox.classList.remove('painting');
  if (activeDragCtrl) { activeDragCtrl.handlePointerUp(); activeDragCtrl = null; return; }
  if (!isDrawing) return;
  isDrawing = false;
  flushPending();
  if (actionHasStrokes) {
    actionHasStrokes = false;
    // Ordered after flushPending, so the server snapshots the completed action.
    ws.send({ type: 'fog:action:end' });
  }
}

viewport.onInteractEnd(() => { cancelLongPress(); isPinging = false; finishAction(); });
viewport.onPointerLeave(() => {
  canvasCtrl.clearBrushPreview();
  cancelLongPress();
  isPinging = false;
  finishAction();
});
