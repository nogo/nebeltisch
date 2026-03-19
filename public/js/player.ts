import { connectPlayer } from './websocket';
import { initCanvas } from './canvas';
import { initTokenLayer } from './tokens';
import { createViewport } from './viewport';
import * as api from './api';
import type { FogStroke } from './canvas';

// --- URL params ---
const fragment = new URLSearchParams(location.hash.slice(1));
const adventureId = fragment.get('adventureId') ?? '';
const playerLink = fragment.get('link') ?? '';
const playerName = fragment.get('name') ?? 'Player';
const playerColor = fragment.get('color') ?? '#e74c3c';

if (!adventureId || !playerLink) {
  const p = document.createElement('p');
  p.style.cssText = 'padding:2rem';
  p.textContent = 'Invalid invite link. ';
  const a = document.createElement('a');
  a.href = '/';
  a.textContent = 'Return home';
  p.appendChild(a);
  document.body.textContent = '';
  document.body.appendChild(p);
  throw new Error('Missing params');
}

// --- DOM ---
const adventureNameEl = document.getElementById('adventure-name')!;
const playerInfoEl = document.getElementById('player-info')!;
const canvasArea = document.getElementById('canvas-area')!;

// Player color dot + name
const dot = document.createElement('span');
dot.className = 'player-dot';
dot.style.background = playerColor;
playerInfoEl.appendChild(dot);
playerInfoEl.appendChild(document.createTextNode(playerName));

// Hide canvas until fog is applied to prevent flash
canvasArea.style.visibility = 'hidden';

// --- State ---
let activeImageId: string | null = null;
let ownTokenId: string | null = null;
let imageList: api.ImageRecord[] = [];

// --- Canvas (opaque fog) ---
const canvasCtrl = initCanvas(canvasArea, { mode: 'player' });

// --- Viewport ---
const viewport = createViewport();
viewport.attach(canvasArea, canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize());

// --- Token layer ---
const tokenCtrl = initTokenLayer(
  canvasCtrl.getWrapper(),
  () => canvasCtrl.getImageSize(),
  (x, y) => viewport.screenToImage(x, y),
  { interactive: true }
);

// Wire token drag through viewport gesture system
viewport.onInteractStart(ev => tokenCtrl.handlePointerDown(ev));
viewport.onPointerMove(ev => tokenCtrl.handlePointerMove(ev));
viewport.onInteractEnd(() => tokenCtrl.handlePointerUp());

// --- WebSocket ---
const ws = connectPlayer(adventureId, playerLink, playerName, playerColor);

ws.on('joined', async (msg) => {
  const adv = msg.adventure as { id: string; name: string; activeImageId: string | null };
  adventureNameEl.textContent = adv.name;
  document.title = `${adv.name} — Player`;
  activeImageId = adv.activeImageId;
  ownTokenId = typeof msg.yourTokenId === 'string' ? msg.yourTokenId : null;

  try {
    imageList = await api.listImagesAsPlayer(adventureId, playerLink);
  } catch {
    imageList = [];
  }

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

  // Reveal canvas only after fog is applied
  canvasArea.style.visibility = 'visible';

  // Render existing tokens
  const tokens = msg.tokens as Array<{ id: string; name: string; color: string; x: number; y: number }>;
  for (const token of tokens) {
    tokenCtrl.addToken(token);
  }

  // Enable drag on own token
  if (ownTokenId) {
    const tid = ownTokenId;
    tokenCtrl.enableDrag(tid, (x, y) => {
      ws.send({ type: 'token:move', tokenId: tid, x, y });
    });
  }

  tokenCtrl.render();
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

ws.on('fog:reset', (msg) => {
  if (msg.imageId === activeImageId && typeof msg.fogMask === 'string') {
    canvasCtrl.applyFogMask(msg.fogMask as string);
  }
});

ws.on('token:moved', (msg) => {
  tokenCtrl.moveToken(msg.tokenId as string, msg.x as number, msg.y as number);
});

ws.on('token:added', (msg) => {
  const token = msg.token as { id: string; name: string; color: string; x: number; y: number };
  tokenCtrl.addToken(token);
});

ws.on('token:removed', (msg) => {
  tokenCtrl.removeToken(msg.tokenId as string);
});

ws.on('map:switched', async (msg) => {
  activeImageId = msg.imageId as string;
  try {
    imageList = await api.listImagesAsPlayer(adventureId, playerLink);
  } catch {}
  const img = imageList.find(i => i.id === activeImageId);
  if (img) {
    await canvasCtrl.loadImage(`/uploads/${img.filename}`);
    viewport.resetView();
    if (typeof msg.fogMask === 'string') {
      await canvasCtrl.applyFogMask(msg.fogMask);
    }
  }
  tokenCtrl.render();
});

ws.on('player:joined', (msg) => {
  showToast(`${msg.playerName as string} joined`);
});

ws.on('player:left', (msg) => {
  showToast(`${msg.playerName as string} left`);
});

ws.on('player:removed', () => {
  ws.close();
  document.body.textContent = '';
  const p = document.createElement('p');
  p.style.cssText = 'padding:2rem';
  p.textContent = 'You have been removed from this session. ';
  const a = document.createElement('a');
  a.href = '/';
  a.textContent = 'Return home';
  p.appendChild(a);
  document.body.appendChild(p);
});

function showToast(text: string) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}
