import { connectPlayer } from './websocket';
import { initCanvas } from './canvas';
import { initTokenLayer } from './tokens';
import type { TokenData } from './tokens';
import { initPingLayer } from './ping';
import { createTokenMenu } from './token-menu';
import type { MenuGroup, MenuItem } from './anchored-menu';
import { createDeclarations } from './declarations';
import { createViewport } from './viewport';
import { initVeil } from './veil';
import * as api from './api';
import type { FogStroke } from './canvas';
import type { Declaration } from '../../src/types';

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
    // — invisible from the seat the slider lives on (#45). `getScale` feeds the finger-sized hit
    // floor: a monster cannot be dragged here, but it is tapped to open its menu (#72).
    {
      interactive: false,
      insertBefore: canvasCtrl.getFogCanvas(),
      getRadius: () => tokenRadius,
      getScale: () => viewport.scale,
      onTapToken: (tokenId) => tokenMenu.toggle(tokenId),
    }
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
    {
      interactive: true,
      getRadius: () => tokenRadius,
      getScale: () => viewport.scale,
      // An attack aimed at me is answered from my own token, so this layer opens a menu too. On a
      // friend's token it finds nothing to offer and opens nothing.
      onTapToken: (tokenId) => tokenMenu.toggle(tokenId),
    }
  );

  // --- Declarations and the token menu ---
  //
  // The same menu the GM opens, holding the one thing a player has to say: an attack on the
  // monster under their finger. A player owns one token, so the attacker is never chosen — tapping
  // the target is the whole gesture (#72).
  //
  // On the monsters only. The party's own layer passes no `onTapToken`, so tapping a friend opens
  // nothing: player against player is out of scope, and a menu offering nothing is not a menu.
  // Which token was hit is answered by the name already drawn under the circle.
  const declarations = createDeclarations([tokenCtrl, gmTokenCtrl]);

  /**
   * The exchange on this token that is waiting on this player, if there is one.
   *
   * One at a time, oldest first, and never more than one kind: an attack aimed at my token is mine
   * to answer, an attack I made is mine to put a number on, and the two halves of an exchange
   * belong to different people (#73).
   */
  function pendingRow(token: TokenData): MenuGroup | null {
    const here = declarations.on(token.id);

    if (token.id === ownTokenId) {
      const open = here.find((d) => d.state === 'open');
      if (!open) return null;
      // Nothing names the attacker. The GM's declarations carry no source, which is exactly what
      // keeps this safe: naming the monster would hand the party one that is still under fog.
      return {
        items: [
          { label: 'Parried', title: 'You parried this', onSelect: () => answer(open.id, true) },
          { label: 'Not parried', title: 'It got through', onSelect: () => answer(open.id, false) },
        ],
      };
    }

    const owed = here.find(
      (d) => d.source_id !== null && d.source_id === ownTokenId && d.state === 'not_parried' && d.damage === null
    );
    if (!owed) return null;
    return {
      items: [{ label: 'Damage', title: 'Send the damage you rolled', onSelect: () => showDamageInput(owed.id) }],
    };
  }

  function answer(declarationId: string, parried: boolean) {
    // No local redraw: the server's echo is what moves the row on to the next attack (principle 2).
    ws.send({ type: 'declaration:answer', declarationId, parried });
  }

  function showDamageInput(declarationId: string) {
    tokenMenu.showInput({
      value: '',
      placeholder: 'Damage',
      maxLength: 3,
      inputMode: 'numeric',
      onCommit: (value) => {
        const damage = Number(value);
        // The server checks this too, and its answer is what the table sees (principle 2).
        if (Number.isInteger(damage) && damage >= 0) {
          ws.send({ type: 'declaration:damage', declarationId, damage });
        }
        tokenMenu.render();
      },
      onCancel: () => tokenMenu.render(),
    });
  }

  const tokenMenu = createTokenMenu({
    parent: canvasCtrl.getWrapper(),
    layers: [gmTokenCtrl, tokenCtrl],
    getRadius: () => tokenRadius,
    getScale: () => viewport.scale,
    build: (token) => {
      const isGmToken = token.token_type === 'monster' || token.token_type === 'npc';
      const groups: MenuGroup[] = [];

      if (isGmToken && ownTokenId !== null) {
        const items: MenuItem[] = [
          {
            label: 'Attack',
            title: `Declare an attack on ${token.name}`,
            onSelect: () => ws.send({ type: 'declaration:open', targetId: token.id }),
          },
        ];
        // Declaring never replaces, so taking one back is its own control — and it takes back the
        // last one, because two attacks of mine on one orc are the same attack to everyone here.
        const mine = declarations
          .on(token.id)
          .filter((d) => d.source_id === ownTokenId && d.state === 'open');
        const last = mine[mine.length - 1];
        if (last) {
          items.push({
            label: 'Retract',
            title: 'Take back the last attack you declared here',
            onSelect: () => ws.send({ type: 'declaration:retract', declarationId: last.id }),
          });
        }
        groups.push({ items });
      }

      // A friend's token offers nothing and opens nothing: player against player is out of scope,
      // and their name is written under the circle already.
      const pending = pendingRow(token);
      if (pending) groups.push(pending);
      return groups;
    },
  });

  // The menu counter-scales, so zooming has to re-apply it.
  viewport.onChange(() => {
    if (tokenMenu.selectedId !== null) tokenMenu.render();
  });

  const LONG_PRESS_DELAY = 400;
  const PING_RATE_LIMIT = 1000;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressStartPos: { x: number; y: number } | null = null;
  let lastPingTime = 0;

  function cancelLongPress() {
    if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null; }
    longPressStartPos = null;
  }

  const ws = connectPlayer(adventureId, playerLink, playerName, playerColor);

  viewport.onInteractStart(ev => {
    // The party's layer first, then the monsters below it — the same precedence the GM's board
    // takes. A press either lands on a token or it does not, and the layers are what decide.
    tokenCtrl.handlePointerDown(ev);
    if (!tokenCtrl.isDragging()) gmTokenCtrl.handlePointerDown(ev);

    // A press that reached a token is that token's to answer — it opens, switches or closes the
    // menu on lifting. Only a press on the map dismisses it, and only that press can be a ping.
    if (!tokenCtrl.isDragging() && !gmTokenCtrl.isDragging()) {
      tokenMenu.select(null);
      // Asking the layers replaces the copy of the grab radius this used to keep: a token that was
      // picked up must never also drop a marker under the finger.
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
    gmTokenCtrl.handlePointerMove(ev);

    if (longPressTimer !== null && longPressStartPos !== null) {
      const dx = ev.clientX - longPressStartPos.x;
      const dy = ev.clientY - longPressStartPos.y;
      if (dx * dx + dy * dy > 25) cancelLongPress();
    }
  });

  viewport.onInteractEnd(() => {
    cancelLongPress();
    tokenCtrl.handlePointerUp();
    gmTokenCtrl.handlePointerUp();
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
      }
    }

    if (ownTokenId) {
      const tid = ownTokenId;
      tokenCtrl.enableDrag(tid, (x, y) => {
        ws.send({ type: 'token:move', tokenId: tid, x, y });
      });
    }

    tokenCtrl.render();
    // After the tokens: a pip is drawn in its attacker's colour, read off their token.
    declarations.replace(msg.declarations);
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
    // The id lives in exactly one controller; moveToken no-ops on the other.
    tokenCtrl.moveToken(tokenId, x, y);
    gmTokenCtrl.moveToken(tokenId, x, y);
    if (tokenMenu.selectedId === tokenId) tokenMenu.render();
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
    if (tokenMenu.selectedId === id) tokenMenu.select(null);
    tokenCtrl.removeToken(id);
    gmTokenCtrl.removeToken(id);
    // The server has already cascaded these away; this is the same removal on screen.
    declarations.dropToken(id);
  });

  // The party reads monster names off the map — three orcs are only distinguishable once the GM
  // has numbered them, so a rename has to land here too.
  ws.on('token:renamed', (msg) => {
    gmTokenCtrl.renameToken(msg.tokenId, msg.name);
    tokenCtrl.renameToken(msg.tokenId, msg.name);
    // The menu names the token it is open on, and the Attack label names it again.
    if (tokenMenu.selectedId === msg.tokenId) tokenMenu.render();
  });

  // A dead orc has to look dead here, or the party keeps planning around it. Player tokens too:
  // the state is the GM's to set, and this side only draws it.
  ws.on('token:state:set', (msg) => {
    gmTokenCtrl.setTokenState(msg.tokenId, msg.state);
    tokenCtrl.setTokenState(msg.tokenId, msg.state);
  });

  ws.on('declaration:opened', (msg) => {
    declarations.add(msg.declaration);
    // The menu carries the lit Attack toggle, so the server's echo is what lights it.
    if (tokenMenu.selectedId === msg.declaration.target_id) tokenMenu.render();
  });

  ws.on('declaration:updated', (msg) => {
    declarations.update(msg.declaration);
    if (tokenMenu.selectedId !== null) tokenMenu.render();
  });

  ws.on('declaration:retracted', (msg) => {
    declarations.remove(msg.declarationId);
    if (tokenMenu.selectedId !== null) tokenMenu.render();
  });

  // A refusal has to reach the player who caused it. Everything a player writes is checked on the
  // server, and until now a refused write was silent on this side: the button simply failed to
  // light, which is honest and says nothing.
  ws.on('error', (msg) => {
    showToast(msg.message);
  });

  ws.on('ping:map', (msg) => {
    pingCtrl.addPing(msg.x, msg.y, msg.color);
  });

  ws.on('settings:updated', (msg) => {
    tokenRadius = msg.tokenSize;
    tokenCtrl.render();
    // Both layers, or monsters keep the old size until the next map switch happens to repaint them.
    gmTokenCtrl.render();
    // The strip hangs clear of the circle, and the circle just changed size.
    if (tokenMenu.selectedId !== null) tokenMenu.render();
  });

  ws.on('map:switched', async (msg) => {
    activeImageId = msg.imageId;
    pingCtrl.clear();
    tokenMenu.select(null);
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
    }
    tokenCtrl.render();
    // Swap GM tokens for the new map
    gmTokenCtrl.clear();
    const newGmTokens = msg.gmTokens;
    for (const t of newGmTokens ?? []) gmTokenCtrl.addToken(t);
    // A fight belongs to the page it was declared on, so the new page brings its own or none.
    declarations.replace(msg.declarations);
  });

  ws.on('map:unpresented', () => {
    activeImageId = null;
    pingCtrl.clear();
    tokenMenu.select(null);
    declarations.replace([]);
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
