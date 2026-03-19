import { connectGM } from './websocket';
import { initCanvas } from './canvas';
import { initTokenLayer } from './tokens';
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
let activeImageId: string | null = null;
let imageList: api.ImageRecord[] = [];
let playerRoster: Array<{ tokenId: string; name: string; color: string; online: boolean }> = [];

// --- DOM ---
const adventureNameEl = document.getElementById('adventure-name')!;
const inviteLinkEl = document.getElementById('invite-link')!;
const copyInviteBtn = document.getElementById('copy-invite')!;
const brushSizeSlider = document.getElementById('brush-size') as HTMLInputElement;
const brushSizeLabel = document.getElementById('brush-size-label')!;
const modeRevealBtn = document.getElementById('mode-reveal')!;
const modeFogBtn = document.getElementById('mode-fog')!;
const gallery = document.getElementById('gallery')!;
const uploadInput = document.getElementById('upload-input') as HTMLInputElement;
const statusBar = document.getElementById('status-bar')!;
const canvasArea = document.getElementById('canvas-area')!;

// --- Canvas ---
const canvasCtrl = initCanvas(canvasArea);

// --- Viewport ---
const viewport = createViewport();
viewport.attach(canvasArea, canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize());

// --- Token layer (non-interactive for GM) ---
const tokenCtrl = initTokenLayer(
  canvasCtrl.getWrapper(),
  () => canvasCtrl.getImageSize(),
  (x, y) => viewport.screenToImage(x, y),
  { interactive: false }
);

// --- WebSocket ---
const ws = connectGM(adventureId, password);

ws.on('connect', () => { statusBar.textContent = ''; });
ws.on('disconnect', () => { statusBar.textContent = 'Reconnecting\u2026'; });
ws.on('error', (msg) => { console.error('WS error', msg); });

ws.on('joined', async (msg) => {
  const adv = msg.adventure as { id: string; name: string; activeImageId: string | null };
  adventureNameEl.textContent = adv.name;

  try {
    const advData = await api.getAdventure(adventureId, password);
    const inviteUrl = `${location.origin}/player#link=${encodeURIComponent(advData.player_link)}`;
    inviteLinkEl.textContent = inviteUrl;
    copyInviteBtn.onclick = () => {
      navigator.clipboard.writeText(inviteUrl).catch(() => {});
    };
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
});

ws.on('map:switched', async (msg) => {
  activeImageId = msg.imageId as string;
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

// --- Gallery ---
function renderGallery() {
  gallery.innerHTML = '';
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
  brushSizeLabel.textContent = `${brushRadius}px`;
});

function setMode(mode: 'reveal' | 'fog') {
  brushMode = mode;
  modeRevealBtn.classList.toggle('active', mode === 'reveal');
  modeFogBtn.classList.toggle('active', mode === 'fog');
}

modeRevealBtn.addEventListener('click', () => setMode('reveal'));
modeFogBtn.addEventListener('click', () => setMode('fog'));

// --- Brush interaction ---
let isDrawing = false;
const pending: FogStroke[] = [];
let lastFlush = 0;
const FLUSH_INTERVAL = 1000 / 60;

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

viewport.onInteractStart((ev: PointerEvent) => {
  if (!activeImageId) return;
  isDrawing = true;
  const stroke = makeStroke(ev.clientX, ev.clientY);
  canvasCtrl.applyStroke(stroke);
  pending.push(stroke);
  if (Date.now() - lastFlush >= FLUSH_INTERVAL) flushPending();
});

viewport.onPointerMove((ev: PointerEvent) => {
  const pos = viewport.screenToImage(ev.clientX, ev.clientY);
  canvasCtrl.drawBrushPreview(pos.x, pos.y, brushRadius);
  if (!isDrawing) return;
  const stroke = makeStroke(ev.clientX, ev.clientY);
  canvasCtrl.applyStroke(stroke);
  pending.push(stroke);
  if (Date.now() - lastFlush >= FLUSH_INTERVAL) flushPending();
});

viewport.onInteractEnd(() => {
  if (!isDrawing) return;
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
