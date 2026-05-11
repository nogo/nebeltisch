import { connectPlayer } from './websocket';
import { initCanvas } from './canvas';
import { initTokenLayer } from './tokens';
import { initPingLayer } from './ping';
import { createViewport } from './viewport';
import * as api from './api';
import type { FogStroke } from './canvas';

// --- Resolve entry mode ---
const fragment = new URLSearchParams(location.hash.slice(1));
let adventureId = fragment.get('adventureId') ?? '';
let playerLink = fragment.get('link') ?? '';
let playerName = fragment.get('name') ?? '';
let playerColor = fragment.get('color') ?? '#e74c3c';

const joinMatch = location.pathname.match(/^\/join\/([^/]+)$/);
if (joinMatch && !playerLink) {
  playerLink = decodeURIComponent(joinMatch[1]);
}

if (adventureId && playerLink && playerName) {
  startPlayer(adventureId, playerLink, playerName, playerColor);
} else if (playerLink) {
  showJoinForm(playerLink);
} else {
  showError();
}

// --- Join form (Mode B: have link, need name + color) ---
async function showJoinForm(link: string) {
  let advName = '';
  let advId = '';

  try {
    const res = await fetch(`/api/adventures/join/${encodeURIComponent(link)}`);
    if (!res.ok) { showError('Invalid invite link.'); return; }
    const data = await res.json();
    advId = data.id;
    advName = data.name;
  } catch {
    showError('Could not connect to server.');
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'join-view';

  const inner = document.createElement('div');
  inner.className = 'join-inner';

  const h1 = document.createElement('h1');
  h1.textContent = advName;
  inner.appendChild(h1);

  const card = document.createElement('div');
  card.className = 'card';

  const h2 = document.createElement('h2');
  h2.textContent = 'Join Adventure';
  card.appendChild(h2);

  const form = document.createElement('form');

  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Your name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.required = true;
  nameInput.placeholder = 'Aria';
  nameInput.autocomplete = 'nickname';
  nameLabel.appendChild(nameInput);
  form.appendChild(nameLabel);

  const colorLabel = document.createElement('label');
  colorLabel.textContent = 'Color';
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = '#e74c3c';
  colorLabel.appendChild(colorInput);
  form.appendChild(colorLabel);

  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.textContent = 'Join';
  form.appendChild(btn);

  const errEl = document.createElement('p');
  errEl.className = 'error';
  form.appendChild(errEl);

  card.appendChild(form);
  inner.appendChild(card);
  overlay.appendChild(inner);
  document.body.appendChild(overlay);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    const color = colorInput.value;
    if (!name) return;
    overlay.remove();
    startPlayer(advId, link, name, color);
  });
}

function showError(msg = 'Invalid invite link.') {
  const p = document.createElement('p');
  p.style.cssText = 'padding:2rem';
  p.textContent = msg + ' ';
  const a = document.createElement('a');
  a.href = '/';
  a.textContent = 'Return home';
  p.appendChild(a);
  document.body.textContent = '';
  document.body.appendChild(p);
}

// --- Player session ---
function startPlayer(adventureId: string, playerLink: string, playerName: string, playerColor: string) {
  const playerInfoEl = document.getElementById('player-info')!;
  const canvasArea = document.getElementById('canvas-area')!;

  const dot = document.createElement('span');
  dot.className = 'player-dot';
  dot.style.background = playerColor;
  playerInfoEl.appendChild(dot);
  playerInfoEl.appendChild(document.createTextNode(playerName));

  canvasArea.style.visibility = 'hidden';

  let tokenRadius = 20;
  let activeImageId: string | null = null;
  let ownTokenId: string | null = null;
  let ownTokenPos: { x: number; y: number } | null = null;
  let imageList: api.ImageRecord[] = [];

  const canvasCtrl = initCanvas(canvasArea, { mode: 'player' });

  const viewport = createViewport();
  viewport.attach(canvasArea, canvasCtrl.getWrapper(), () => canvasCtrl.getImageSize());

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

  const tokenCtrl = initTokenLayer(
    canvasCtrl.getWrapper(),
    () => canvasCtrl.getImageSize(),
    (x, y) => viewport.screenToImage(x, y),
    { interactive: true, getRadius: () => tokenRadius }
  );

  const LONG_PRESS_DELAY = 400;
  const PING_RATE_LIMIT = 1000;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressStartPos: { x: number; y: number } | null = null;
  let lastPingTime = 0;

  function cancelLongPress() {
    if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null; }
    longPressStartPos = null;
  }

  function isOnOwnToken(clientX: number, clientY: number): boolean {
    if (!ownTokenId || !ownTokenPos) return false;
    const pos = viewport.screenToImage(clientX, clientY);
    const dx = pos.x - ownTokenPos.x;
    const dy = pos.y - ownTokenPos.y;
    return dx * dx + dy * dy <= tokenRadius * tokenRadius;
  }

  const ws = connectPlayer(adventureId, playerLink, playerName, playerColor);

  viewport.onInteractStart(ev => {
    tokenCtrl.handlePointerDown(ev);

    if (!isOnOwnToken(ev.clientX, ev.clientY)) {
      longPressStartPos = { x: ev.clientX, y: ev.clientY };
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        const now = Date.now();
        if (now - lastPingTime >= PING_RATE_LIMIT) {
          lastPingTime = now;
          const pos = viewport.screenToImage(longPressStartPos!.x, longPressStartPos!.y);
          ws.send({ type: 'ping:map', x: pos.x, y: pos.y, color: playerColor });
        }
      }, LONG_PRESS_DELAY);
    }
  });

  viewport.onPointerMove(ev => {
    tokenCtrl.handlePointerMove(ev);

    if (longPressTimer !== null && longPressStartPos !== null) {
      const dx = ev.clientX - longPressStartPos.x;
      const dy = ev.clientY - longPressStartPos.y;
      if (dx * dx + dy * dy > 25) cancelLongPress();
    }
  });

  viewport.onInteractEnd(() => {
    cancelLongPress();
    tokenCtrl.handlePointerUp();
  });

  ws.on('joined', async (msg) => {
    const adv = msg.adventure as { id: string; name: string; activeImageId: string | null; tokenSize: number };
    document.title = `${adv.name} — Player`;
    activeImageId = adv.activeImageId;
    tokenRadius = adv.tokenSize ?? 20;
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

    canvasArea.style.visibility = 'visible';

    const tokens = msg.tokens as Array<{ id: string; name: string; color: string; x: number; y: number }>;
    for (const token of tokens) {
      tokenCtrl.addToken(token);
      if (token.id === ownTokenId) ownTokenPos = { x: token.x, y: token.y };
    }

    if (ownTokenId) {
      const tid = ownTokenId;
      tokenCtrl.enableDrag(tid, (x, y) => {
        ownTokenPos = { x, y };
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
    const tokenId = msg.tokenId as string;
    const x = msg.x as number;
    const y = msg.y as number;
    if (tokenId === ownTokenId) ownTokenPos = { x, y };
    tokenCtrl.moveToken(tokenId, x, y);
  });

  ws.on('token:added', (msg) => {
    const token = msg.token as { id: string; name: string; color: string; x: number; y: number };
    tokenCtrl.addToken(token);
  });

  ws.on('token:removed', (msg) => {
    tokenCtrl.removeToken(msg.tokenId as string);
  });

  ws.on('ping:map', (msg) => {
    pingCtrl.addPing(msg.x as number, msg.y as number, msg.color as string);
  });

  ws.on('settings:updated', (msg) => {
    tokenRadius = msg.tokenSize as number;
    tokenCtrl.render();
  });

  ws.on('map:switched', async (msg) => {
    activeImageId = msg.imageId as string;
    pingCtrl.clear();
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
    const overlay = document.createElement('div');
    overlay.className = 'removal-overlay';
    const msg = document.createElement('p');
    msg.textContent = 'You have been removed from this session.';
    const link = document.createElement('a');
    link.href = '/';
    link.textContent = 'Return home';
    overlay.appendChild(msg);
    overlay.appendChild(link);
    document.body.appendChild(overlay);
  });

  function showToast(text: string) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }
}
