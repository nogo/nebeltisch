import { connectPlayer } from './websocket';
import { initCanvas } from './canvas';
import { initTokenLayer } from './tokens';
import { initPingLayer } from './ping';
import { createViewport } from './viewport';
import { initVeil } from './veil';
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

  const invited = document.createElement('p');
  invited.className = 'tagline';
  invited.textContent = "You've been invited to";
  inner.appendChild(invited);

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
  nameInput.setAttribute('autocomplete', 'nickname');
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

  const waitingScreen = document.getElementById('waiting-screen')!;
  const waitingTitle = document.getElementById('waiting-title')!;
  const waitingContent = document.getElementById('waiting-content')!;
  const veil = initVeil(
    document.getElementById('waiting-veil') as HTMLCanvasElement,
    // The clearing follows the wordmark rather than the middle of the screen, so it still frames
    // the title on a tablet held either way round.
    () => {
      const box = waitingContent.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 1);
      return { x: (box.left + box.width / 2) * ratio, y: (box.top + box.height / 2) * ratio };
    }
  );

  /**
   * The two states a player can be in: waiting on the GM, or looking at a map. Nothing sets
   * `active_image_id` back to null on the server, so waiting is reached on joining and left on the
   * first `map:switched` — it is not a mode that comes and goes (#53).
   *
   * A presented page whose image could not be listed lands here too. It is the same "nothing to
   * show" state, and saying so beats the blank screen that used to stand in for both.
   */
  function showWaiting(waiting: boolean) {
    waitingScreen.hidden = !waiting;
    canvasArea.style.visibility = waiting ? 'hidden' : 'visible';
    // The frame loop only exists while the screen does. A veil left running behind a presented map
    // would cost a tablet exactly as much as one being looked at, for nothing (#20).
    if (waiting) veil.start(); else veil.stop();
  }

  let tokenRadius = 20;
  let activeImageId: string | null = null;
  let ownTokenId: string | null = null;
  let ownTokenPos: { x: number; y: number } | null = null;
  let imageList: api.ImageRecord[] = [];

  const canvasCtrl = initCanvas(canvasArea, { mode: 'player' });

  const viewport = createViewport();
  // Bounded, unlike the GM's board: a player has one page and nothing to find beyond it.
  viewport.attach(canvasArea, canvasCtrl.getWrapper(), () => {
    const { w, h } = canvasCtrl.getImageSize();
    return { x: 0, y: 0, w, h };
  });

  // GM token layer below fog — hidden unless fog is revealed above them
  const gmTokenCtrl = initTokenLayer(
    canvasCtrl.getWrapper(),
    () => canvasCtrl.getImageSize(),
    (x, y) => viewport.screenToImage(x, y),
    // One token size per adventure, so this layer reads the same `tokenRadius` the party's layer
    // does. Without it monsters drew at `DEFAULT_RADIUS` on players' screens for the whole session
    // — invisible from the seat the slider lives on (#45). No `getScale`: it feeds hit-testing and
    // the held halo, and this layer is neither interactive nor draggable.
    { interactive: false, insertBefore: canvasCtrl.getFogCanvas(), getRadius: () => tokenRadius }
  );

  const pingCtrl = initPingLayer(
    canvasCtrl.getWrapper(),
    () => canvasCtrl.getImageSize(),
    () => viewport.scale
  );

  const tokenCtrl = initTokenLayer(
    canvasCtrl.getWrapper(),
    () => canvasCtrl.getImageSize(),
    (x, y) => viewport.screenToImage(x, y),
    { interactive: true, getRadius: () => tokenRadius, getScale: () => viewport.scale }
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
    // Must match the grab radius in tokens.ts, or a tap can start a drag and a
    // ping at once: the token moves and a marker fires under the finger.
    const scale = viewport.scale;
    const r = Math.max(tokenRadius, 22 / (scale > 0 ? scale : 1));
    return dx * dx + dy * dy <= r * r;
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
    const adv = msg.adventure;
    document.title = `${adv.name} — Player`;
    activeImageId = adv.activeImageId;
    tokenRadius = adv.tokenSize ?? 20;
    ownTokenId = typeof msg.yourTokenId === 'string' ? msg.yourTokenId : null;

    try {
      imageList = await api.listImagesAsPlayer(adventureId, playerLink);
    } catch {
      imageList = [];
    }

    let mapLoaded = false;
    if (activeImageId) {
      const img = imageList.find(i => i.id === activeImageId);
      if (img) {
        await canvasCtrl.loadImage(`/uploads/${img.filename}`);
        viewport.resetView();
        if (typeof msg.fogMask === 'string') {
          await canvasCtrl.applyFogMask(msg.fogMask);
        }
        mapLoaded = true;
      }
    }

    // The name alone. A player checks this screen to know they joined the right table, and a
    // greeting above it only competes with the one word that answers that.
    waitingTitle.textContent = adv.name;
    showWaiting(!mapLoaded);

    const tokens = msg.tokens;
    for (const token of tokens) {
      if (token.token_type === 'monster' || token.token_type === 'npc') {
        gmTokenCtrl.addToken(token);
      } else {
        tokenCtrl.addToken(token);
        if (token.id === ownTokenId) ownTokenPos = { x: token.x, y: token.y };
      }
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
      canvasCtrl.applyStroke(msg.stroke);
    }
  });

  ws.on('fog:stroke:batch', (msg) => {
    if (msg.imageId === activeImageId) {
      for (const stroke of msg.strokes) {
        canvasCtrl.applyStroke(stroke);
      }
    }
  });

  ws.on('fog:reset', (msg) => {
    if (msg.imageId === activeImageId && typeof msg.fogMask === 'string') {
      canvasCtrl.applyFogMask(msg.fogMask);
    }
  });

  ws.on('token:moved', (msg) => {
    const tokenId = msg.tokenId;
    const x = msg.x;
    const y = msg.y;
    if (tokenId === ownTokenId) ownTokenPos = { x, y };
    // The id lives in exactly one controller; moveToken no-ops on the other.
    tokenCtrl.moveToken(tokenId, x, y);
    gmTokenCtrl.moveToken(tokenId, x, y);
  });

  ws.on('token:added', (msg) => {
    const token = msg.token;
    tokenCtrl.addToken(token);
  });

  ws.on('gm_token:added', (msg) => {
    gmTokenCtrl.addToken(msg.token);
  });

  ws.on('token:removed', (msg) => {
    const id = msg.tokenId;
    tokenCtrl.removeToken(id);
    gmTokenCtrl.removeToken(id);
  });

  ws.on('ping:map', (msg) => {
    pingCtrl.addPing(msg.x, msg.y, msg.color);
  });

  ws.on('settings:updated', (msg) => {
    tokenRadius = msg.tokenSize;
    tokenCtrl.render();
    // Both layers, or monsters keep the old size until the next map switch happens to repaint them.
    gmTokenCtrl.render();
  });

  ws.on('map:switched', async (msg) => {
    activeImageId = msg.imageId;
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
      // Ordered after the image and its fog, so the map is never revealed half-drawn.
      showWaiting(false);
    }
    // The server moves the party onto the new map's start point.
    const movedPlayers = msg.playerTokens;
    for (const t of movedPlayers ?? []) {
      tokenCtrl.moveToken(t.id, t.x, t.y);
      if (t.id === ownTokenId) ownTokenPos = { x: t.x, y: t.y };
    }
    tokenCtrl.render();
    // Swap GM tokens for the new map
    gmTokenCtrl.clear();
    const newGmTokens = msg.gmTokens;
    for (const t of newGmTokens ?? []) gmTokenCtrl.addToken(t);
  });

  ws.on('map:unpresented', () => {
    activeImageId = null;
    pingCtrl.clear();
    // Monsters belong to the page that just left. Player tokens stay in the layer: the party did
    // not move, and the next page presented decides where they stand.
    gmTokenCtrl.clear();
    showWaiting(true);
  });

  ws.on('player:joined', (msg) => {
    showToast(`${msg.playerName} joined`);
  });

  ws.on('player:left', (msg) => {
    showToast(`${msg.playerName} left`);
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
