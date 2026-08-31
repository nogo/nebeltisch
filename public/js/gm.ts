import { connectGM } from './websocket';
import { initCanvas } from './canvas';
import { initBoard } from './board';
import { initTokenLayer } from './tokens';
import type { TokenController } from './tokens';
import { initPingLayer } from './ping';
import { createViewport } from './viewport';
import { createAnchoredMenu } from './anchored-menu';
import { createTokenMenu } from './token-menu';
import { createDeclarations } from './declarations';
import type { MenuItem } from './anchored-menu';
import type { FogStroke } from './canvas';
import type { TokenState } from '../../src/types';
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

/**
 * `activeImageId` is what the players are looking at; `selectedImageId` is what the GM is working
 * on. They are deliberately separate — selecting a page on the board reaches nobody, and only
 * Present changes what the table sees (#50).
 */
let activeImageId: string | null = null;
let selectedImageId: string | null = null;
/** The page whose image and fog have finished loading into the shared canvas stack. */
let focusedImageId: string | null = null;
/** Invalidates asynchronous image/fog work from an older selection. */
let focusRequest = 0;

/**
 * On a board of pages, one finger drags a page and paints nothing until the fog tool is armed.
 * `docs/interface.md` records this as the one deliberate exception to "the gesture disambiguates":
 * a stray finger painting fog onto whichever page happened to be underneath is far worse than an
 * extra tap. Two fingers still pan and pinch whatever is armed.
 */
let brushArmed = false;

let imageList: api.ImageRecord[] = [];
let playerRoster: Array<{ tokenId: string; name: string; color: string; online: boolean }> = [];
let inviteUrl = '';

// --- DOM ---
// Topbar: the adventure and the people at it. The name opens the settings, the avatars open the
// roster — both are triggers, not labels.
const adventureNameEl = document.getElementById('adventure-name')!;
const settingsBtn = document.getElementById('settings-btn')!;
const connectionStatusEl = document.getElementById('connection-status')!;
const liveLamp = document.getElementById('live-lamp')!;
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
const presentBtn = document.getElementById('present-btn') as HTMLButtonElement;
const deleteBtn = document.getElementById('delete-btn') as HTMLButtonElement;
const fitBtn = document.getElementById('fit-btn')!;
const placeTokenBtn = document.getElementById('place-token-btn')!;
const flagIconTemplate = document.getElementById('flag-icon') as HTMLTemplateElement;
const trashIconTemplate = document.getElementById('trash-icon') as HTMLTemplateElement;
const pencilIconTemplate = document.getElementById('pencil-icon') as HTMLTemplateElement;

/**
 * The two states worth a button. Alive is the third, and it has none: it is both toggles unlit,
 * which is also how the token reads on the map, so the menu matches the canvas.
 *
 * Toggles rather than a cycle. A cycle would reach dead from alive through a press on
 * unconscious, and that press is a write the whole table sees — a state that never happened,
 * broadcast (principle 12). Here every press lands on the state the GM meant, from any state.
 */
const TOKEN_STATES: Array<{
  value: Exclude<TokenState, 'alive'>;
  label: string;
  icon: HTMLTemplateElement;
}> = [
  { value: 'unconscious', label: 'Unconscious', icon: document.getElementById('state-unconscious-icon') as HTMLTemplateElement },
  { value: 'dead', label: 'Dead', icon: document.getElementById('state-dead-icon') as HTMLTemplateElement },
];

// Token placement form
const tokenPlaceForm = document.getElementById('token-place-form')!;
const tpMonsterBtn = document.getElementById('tp-monster')!;
const tpNpcBtn = document.getElementById('tp-npc')!;
const tpNameInput = document.getElementById('tp-name') as HTMLInputElement;
const tpCancelBtn = document.getElementById('tp-cancel')!;
const tpConfirmBtn = document.getElementById('tp-confirm')!;

// Popovers
const brushPopup = document.getElementById('brush-popup')!;
const brushSizeSlider = document.getElementById('brush-size') as HTMLInputElement;
const settingsPopup = document.getElementById('settings-popup')!;
const tokenSizeLabel = document.getElementById('token-size-label')!;
const tokenSizeSlider = document.getElementById('token-size') as HTMLInputElement;
const playersPopup = document.getElementById('players-popup')!;
const playersList = document.getElementById('players-list')!;
const copyInviteBtn = document.getElementById('copy-invite-btn')!;
const uploadInput = document.getElementById('upload-input') as HTMLInputElement;

// Notice and empty state
const noticeEl = document.getElementById('notice')!;
const emptyState = document.getElementById('empty-state')!;
const emptyUploadBtn = document.getElementById('empty-upload-btn')!;

// --- Board ---
// The board is the world; the canvas stack sits on one page of it. Everything downstream still
// works in page coordinates, which is what `screenToPage` below preserves.
const board = initBoard(canvasArea);

// --- Canvas ---
const canvasCtrl = initCanvas(board.element);
const canvasWrapper = canvasCtrl.getWrapper();
canvasWrapper.style.position = 'absolute';
// The stack is created before any page and would otherwise be painted over by every one of them.
canvasWrapper.style.zIndex = '1';
canvasWrapper.hidden = true;

// --- Viewport ---
const viewport = createViewport();
// Unbounded: the board is a canvas the pages float on, not a page. What is on it never decides how
// far the GM can pull back, and panning is free — `fitBoard` is what brings them home.
viewport.attach(canvasArea, board.element, () => board.getWorldBounds(), { bounded: false });
viewport.onChange(() => {
  board.applyScale(viewport.scale);
  // The marker's menu counter-scales, so zooming has to re-apply it.
  if (startSelected) renderStartMarker();
  if (tokenMenu.selectedId !== null) tokenMenu.render();
});

/** Frames every page. On a canvas with no edges this is the only way back to the content. */
function fitBoard() {
  viewport.resetView();
}

/**
 * Frames one page. Presenting takes the GM to the page they just put on the table, rather than
 * leaving them wherever the board happened to be — but it only moves the view: the board stays
 * reachable, and preparing another page from here reaches nobody, exactly as before.
 */
function framePage(id: string | null) {
  if (!id) return;
  const rect = board.rectOf(id);
  if (!rect) return;
  // The same margin rule `getWorldBounds` uses, and for the same reason: the page's name and Live
  // badge hang above it and counter-scale, so a frame flush to the page cuts them off.
  const margin = Math.max(120, Math.round(Math.max(rect.width, rect.height) * 0.06));
  viewport.frame({
    x: rect.x - margin,
    y: rect.y - margin,
    w: rect.width + margin * 2,
    h: rect.height + margin * 2,
  });
}

fitBtn.addEventListener('click', fitBoard);

/**
 * Screen coordinates to coordinates *within the focused page*.
 *
 * The viewport's world is the board, so its own conversion returns board coordinates. Subtracting
 * the focused page's origin here is the single change that keeps every fog, token, ping and
 * start-marker path working in page coordinates exactly as before.
 */
function screenToPage(clientX: number, clientY: number): { x: number; y: number } {
  const world = viewport.screenToImage(clientX, clientY);
  const rect = selectedImageId ? board.rectOf(selectedImageId) : null;
  if (!rect) return world;
  return { x: world.x - rect.x, y: world.y - rect.y };
}

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
  (x, y) => screenToPage(x, y),
  {
    interactive: false,
    insertBefore: canvasCtrl.getFogCanvas(),
    getRadius: () => tokenRadius,
    getScale: () => viewport.scale,
    onTapToken: (tokenId) => tokenMenu.toggle(tokenId),
  }
);
gmTokenCtrl.enableDragAll((tokenId, x, y) => {
  // Only fires once the token has actually moved, so a tap leaves `token_positions` alone.
  if (tokenMenu.selectedId === tokenId) tokenMenu.select(null);
  ws.send({ type: 'token:move', tokenId, x, y });
});

// Double-tapping empty canvas fits the board. It used to fall through to the token layer and
// remove a monster outright — no confirmation, no undo, and synthesised from a double-tap on the
// tablet, so a fumble during a fight deleted one. Removal is a menu item now (#60).
canvasArea.addEventListener('dblclick', (ev) => {
  const world = viewport.screenToImage(ev.clientX, ev.clientY);
  if (board.pageAt(world.x, world.y) === null) fitBoard();
});

// --- Token layer ---
const tokenCtrl = initTokenLayer(
  canvasCtrl.getWrapper(),
  () => canvasCtrl.getImageSize(),
  (x, y) => screenToPage(x, y),
  {
    interactive: true,
    getRadius: () => tokenRadius,
    getScale: () => viewport.scale,
    onTapToken: (tokenId) => tokenMenu.toggle(tokenId),
  }
);
tokenCtrl.enableDragAll((tokenId, x, y) => {
  if (tokenMenu.selectedId === tokenId) tokenMenu.select(null);
  ws.send({ type: 'token:move', tokenId, x, y });
});

// --- Declarations ---
//
// The presented page's, whichever page the GM has selected: the pips are drawn on the tokens they
// point at, so a page the GM is only preparing has none of them in its layers and shows nothing.
const declarations = createDeclarations([gmTokenCtrl, tokenCtrl]);

// --- The token menu ---
//
// The menu itself is `token-menu.ts`, shared with the player client: which layer holds the token,
// what a tap means and where the strip hangs are one rule, and both clients obey it. What is here
// is what the *GM* offers on a token.
let removeArmed = false;

const tokenMenu = createTokenMenu({
  parent: canvasCtrl.getWrapper(),
  layers: [gmTokenCtrl, tokenCtrl],
  getRadius: () => tokenRadius,
  getScale: () => viewport.scale,
  onSelectionChange: (tokenId) => {
    // A half-armed Remove does not survive the GM moving to another token.
    removeArmed = false;
    // The marker's menu and this one both hang over the same page, and a token can sit under the
    // marker. `createAnchoredMenu` deliberately does not close siblings, so this is said here.
    if (tokenId !== null) selectStartMarker(false);
  },
  build: (token) => {
    const isGmToken = token.token_type === 'monster' || token.token_type === 'npc';
    // A player token offers the GM one thing, and the menu is that one button.
    //
    // No name: it is already written under the circle, and the menu repeating it says nothing the
    // GM cannot see. No states either — a player reports being down, and the GM adjudicating it
    // from here was a guess #61 made about a table that does not work that way.
    if (!isGmToken) {
      const open = declarations.openOn(token.id, null);
      return {
        items: [
          {
            label: 'Attack',
            // Lit while it stands, and the same press takes it back, so no press is ever a no-op
            // and taking one back needs no control of its own.
            current: open !== null,
            title: open ? 'Attacking — tap to take it back' : `Declare an attack on ${token.name}`,
            onSelect: () => {
              removeArmed = false;
              if (open) ws.send({ type: 'declaration:retract', declarationId: open.id });
              else ws.send({ type: 'declaration:open', targetId: token.id });
            },
          },
        ],
      };
    }

    const state = token.state;
    // Nothing here sets a state on its own — a press is the whole story.
    const items: MenuItem[] = TOKEN_STATES.map(({ value, label, icon }) => {
      const lit = value === state;
      return {
        label,
        icon,
        // The way back to alive is the lit toggle, so no press is ever a no-op.
        title: lit ? `${label} — tap to mark alive` : `Mark ${label.toLowerCase()}`,
        current: lit,
        onSelect: () => {
          removeArmed = false;
          ws.send({ type: 'gm_token:state', tokenId: token.id, state: lit ? 'alive' : value });
        },
      };
    });
    items.push(
      removeArmed
        ? {
            // Words, not the icon, for the press that actually destroys something: a second tap on
            // the same glyph would look like the first one failed.
            label: 'Remove?',
            armed: true,
            title: 'Tap again to remove this token',
            onSelect: () => {
              ws.send({ type: 'gm_token:remove', tokenId: token.id });
              tokenMenu.select(null);
            },
          }
        : {
            label: 'Remove',
            icon: trashIconTemplate,
            title: 'Remove this token',
            onSelect: () => {
              removeArmed = true;
              tokenMenu.render();
            },
          }
    );
    // A monster's name is also the control that renames it, so the edit happens on the name rather
    // than beside it. Numbering three orcs is what makes the party able to name one.
    return {
      items,
      label: {
        text: token.name,
        icon: pencilIconTemplate,
        title: 'Rename',
        onSelect: () => showTokenRename(token.id, token.name),
      },
    };
  },
});

function showTokenRename(tokenId: string, current: string) {
  // A half-armed Remove does not survive the GM going off to rename instead.
  removeArmed = false;
  tokenMenu.showInput({
    value: current,
    maxLength: 40,
    onCommit: (name) => {
      if (name !== current) ws.send({ type: 'gm_token:rename', tokenId, name });
      // Straight back to the menu, still on this token. The name shown is whatever the layer
      // holds, so it is the server's echo that changes it — a rename the server refuses leaves
      // the old name on screen rather than a hopeful one (principle 2).
      tokenMenu.render();
    },
    onCancel: () => tokenMenu.render(),
  });
}

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
  renderPages();

  // The board opens fitted to the whole adventure — the GM sees the story, not one room.
  fitBoard();
  await focusPage(activeImageId ?? imageList[0]?.id ?? null);

  // Only the party. Monsters and NPCs are per page and `focusPage` above has already loaded the
  // ones standing on the page the GM landed on.
  for (const token of msg.tokens) {
    if (token.token_type !== 'monster' && token.token_type !== 'npc') tokenCtrl.addToken(token);
  }
  // After the tokens: a pip is drawn in its attacker's colour, which is read off their token.
  declarations.replace(msg.declarations);

  syncStartPointFromImageList();
  renderPresence(playerRoster);
});

ws.on('fog:stroke', (msg) => {
  if (msg.imageId === selectedImageId) canvasCtrl.applyStroke(msg.stroke);
});

ws.on('fog:stroke:batch', (msg) => {
  if (msg.imageId === selectedImageId) {
    for (const stroke of msg.strokes) canvasCtrl.applyStroke(stroke);
  }
});

ws.on('token:added', (msg) => {
  tokenCtrl.addToken(msg.token);
});

ws.on('gm_token:added', (msg) => {
  // A monster belongs to one page, and the layer draws the selected one. This arrives for the
  // GM's own placement too, which is why it is filtered rather than trusted.
  if (msg.token.image_id === selectedImageId) gmTokenCtrl.addToken(msg.token);
});

ws.on('token:moved', (msg) => {
  // The id lives in exactly one controller; moveToken no-ops on the other.
  tokenCtrl.moveToken(msg.tokenId, msg.x, msg.y);
  gmTokenCtrl.moveToken(msg.tokenId, msg.x, msg.y);
  if (tokenMenu.selectedId === msg.tokenId) tokenMenu.render();
});

ws.on('token:removed', (msg) => {
  const id = msg.tokenId;
  if (tokenMenu.selectedId === id) tokenMenu.select(null);
  tokenCtrl.removeToken(id);
  gmTokenCtrl.removeToken(id);
  // The server has already cascaded these away. Without it a dead orc's pip stays on the player it
  // was attacking until the next page switch.
  declarations.dropToken(id);
});

ws.on('token:renamed', (msg) => {
  // The id lives in exactly one controller; the other no-ops.
  gmTokenCtrl.renameToken(msg.tokenId, msg.name);
  tokenCtrl.renameToken(msg.tokenId, msg.name);
  if (tokenMenu.selectedId === msg.tokenId) tokenMenu.render();
});

ws.on('token:state:set', (msg) => {
  // The id lives in exactly one controller; the other no-ops.
  gmTokenCtrl.setTokenState(msg.tokenId, msg.state);
  tokenCtrl.setTokenState(msg.tokenId, msg.state);
  // The menu marks the state the token is in, so the server's echo is what moves the mark.
  if (tokenMenu.selectedId === msg.tokenId) tokenMenu.render();
});

ws.on('declaration:opened', (msg) => {
  declarations.add(msg.declaration);
  // The menu carries the lit Attack toggle, so the server's echo is what lights it.
  if (tokenMenu.selectedId === msg.declaration.target_id) tokenMenu.render();
});

ws.on('declaration:retracted', (msg) => {
  declarations.remove(msg.declarationId);
  if (tokenMenu.selectedId !== null) tokenMenu.render();
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
  renderPages();

  // Focus follows the page to the table, unconditionally. On the device that presented it this
  // changes nothing — `map:switch` only ever carries `selectedImageId`, so the page is already
  // the selected one. A second GM device is pulled along with it; that is out of scope under
  // `No CRDT` (#51), not an oversight. `focusPage` owns the GM token layer, so the new page's
  // monsters come with it and `msg.gmTokens` is the player client's copy of the same thing.
  await focusPage(activeImageId);
  framePage(activeImageId);

  // The server moves the party onto the new map's start point.
  const movedPlayers = msg.playerTokens;
  for (const t of movedPlayers ?? []) tokenCtrl.moveToken(t.id, t.x, t.y);
  tokenCtrl.render();
  // A fight belongs to the page it was declared on, so the new page brings its own or none.
  declarations.replace(msg.declarations);
});

ws.on('map:unpresented', () => {
  activeImageId = null;
  pingCtrl.clear();
  declarations.replace([]);
  // The GM keeps the page they were working on and the view they were at. Only the table emptied,
  // and the badge, the lamp and the button are what say so.
  board.setLive(null);
  renderPageControls();
  updateToolAvailability();
});

ws.on('fog:reset', async (msg) => {
  const id = msg.imageId;
  if (id !== selectedImageId || typeof msg.fogMask !== 'string') return;
  // Decompression is asynchronous, so the page can change underneath it. Without this guard an
  // undo on one page repainted its mask — and resized the stack to its dimensions — onto whichever
  // page the GM tapped next (#65). Same predicate `focusPage` uses, for the same reason.
  const request = focusRequest;
  await canvasCtrl.applyFogMask(msg.fogMask, () => request === focusRequest && selectedImageId === id);
});

// --- The board ---
function renderPages() {
  board.setPages(imageList);
  board.setLive(activeImageId);
  board.setSelected(selectedImageId);
  board.setFocused(focusedImageId);
  board.applyScale(viewport.scale);
  updateEmptyState();
  renderPageControls();
}

/**
 * Puts the canvas stack on one page of the board, and loads everything the GM can work on there.
 *
 * Selection is local and reaches nobody — presenting is the only thing on the board that does
 * (#50). Fog for the presented page arrives over the WebSocket; any other page's is read from the
 * server, and so are its monsters and NPCs, because the wire only ever carries the presented
 * page's (#51).
 */
async function focusPage(id: string | null) {
  const request = ++focusRequest;
  selectedImageId = id;
  focusedImageId = null;
  board.setSelected(id);
  board.setFocused(null);
  canvasWrapper.hidden = true;
  // The layer holds one page's monsters at a time; the next page's arrive below.
  tokenMenu.select(null);
  gmTokenCtrl.clear();
  renderPageControls();
  updateToolAvailability();

  const record = id === null ? undefined : imageList.find(i => i.id === id);
  const rect = id === null ? null : board.rectOf(id);
  if (id === null || !record || !rect) {
    return;
  }

  const isCurrent = () => request === focusRequest && selectedImageId === id;

  // A page that cannot be drawn says so and stops here, rather than throwing out of `focusPage`
  // and taking its caller down with it (#67): `map:switched` would have skipped repositioning the
  // party, leaving the GM's copy of it on the previous page's coordinates while the table had
  // already moved. The two reads below have always been caught for the same reason.
  let loaded = false;
  try {
    loaded = await canvasCtrl.loadImage(`/uploads/${record.filename}`, isCurrent);
  } catch (e) {
    console.error('Could not load this page\'s image', e);
    if (isCurrent()) showNotice(`Could not load "${record.original_name}". Tap the page to try again.`);
    return;
  }
  if (!loaded) return;

  // Every page's fog comes over REST, the presented one included. Caching the mask the server
  // sent at present-time and reusing it here showed the GM their own reveals rolled back the
  // moment they left the page and came back (#64). The route reads through `deps.fog.peek`, so it
  // is a debounce ahead of the blob and correct for the live page too.
  let mask: string | null = null;
  try {
    mask = await api.getImageFog(adventureId, password, id);
  } catch (e) {
    console.error('Could not read this page\'s fog', e);
  }
  if (!isCurrent()) return;
  if (mask && !await canvasCtrl.applyFogMask(mask, isCurrent)) return;
  if (!isCurrent()) return;

  try {
    const gmTokens = await api.getImageGmTokens(adventureId, password, id);
    if (!isCurrent()) return;
    for (const token of gmTokens) gmTokenCtrl.addToken(token);
  } catch (e) {
    console.error('Could not read this page\'s tokens', e);
  }

  clearNotice();
  focusedImageId = id;
  canvasWrapper.style.left = `${rect.x}px`;
  canvasWrapper.style.top = `${rect.y}px`;
  board.setFocused(id);
  canvasWrapper.hidden = false;
  updateToolAvailability();
  syncStartPointFromImageList();
  // Undo history is per page and lives on the server, so the buttons ask what this one can do.
  ws.send({ type: 'fog:history:query', imageId: id });
}

/**
 * A page is ready to work on once its image, fog and tokens have loaded into the canvas stack.
 *
 * Fog, tokens and undo all name `selectedImageId` on the wire, and the server decides who hears
 * about it — preparing a page the party is not looking at is stored and silent (#51). So the tools
 * are gated on the page being *loaded*, not on it being the presented one.
 */
function isPageReady(): boolean {
  return selectedImageId !== null && focusedImageId === selectedImageId;
}

/** Whether the party is looking at the page the GM is working on. */
function isLivePageSelected(): boolean {
  return selectedImageId !== null && selectedImageId === activeImageId;
}

function updateToolAvailability() {
  const ready = isPageReady();
  toolbox.classList.toggle('no-page', !ready);
  // Monsters and NPCs belong to a page, so that layer follows the selection. Player tokens and
  // pings belong to the presented one: the party is not standing on a page in preparation, and a
  // ping is someone pointing at what is actually on the table.
  const live = isLivePageSelected();
  gmTokenCtrl.element.hidden = !ready;
  tokenCtrl.element.hidden = !live;
  pingCtrl.element.hidden = !live;
  if (!ready) {
    setArmed(false);
    deactivatePlaceMode();
  }
}

/**
 * The selected page's own menu, hanging above it on the board. A page's actions live on the page:
 * selecting it is the first step and pressing an item is the second, which is the same
 * select-then-press presenting has always taken — the press simply happens next to the thing it
 * acts on rather than in the toolbar (#32).
 */
/** Set while Delete is waiting for its second press. Cleared by anything else that happens. */
let deleteArmed = false;

/**
 * Present and Delete act on the selected page, and they live in the toolbar rather than on the
 * page itself.
 *
 * They were briefly a menu hanging over the page, which put each act next to the thing it acts on
 * — and broke the moment the GM zoomed in, because a page's edge is off screen exactly when the
 * page fills it. **A control needed regardless of where the GM is looking cannot be anchored to a
 * place in the world**, and anchoring it somewhere else only moves which zoom level hides it. The
 * start marker's menu is not the same case: it is reached by finding the marker, so it is already
 * where the eye is. Reverted 2026-08-10, after use.
 */
function renderPageControls() {
  // The lamp answers "is anything on the table", which is about the table and not about whichever
  // page is selected — it stays lit while the GM prepares a page the party cannot see.
  const onAir = activeImageId !== null;
  liveLamp.classList.toggle('on', onAir);
  liveLamp.title = onAir
    ? 'A page is on the table'
    : 'Nothing is on the table — select a page and press Present';

  const live = selectedImageId !== null && selectedImageId === activeImageId;
  presentBtn.disabled = selectedImageId === null;
  presentBtn.textContent = live ? 'Unpresent' : 'Present';
  presentBtn.title = live
    ? 'Take this page off the table'
    : 'Show the selected page to the table';

  // A page on the table comes off it first. The server refuses this too — the button only says so
  // early, and a second GM tab with a stale board cannot get around it.
  deleteBtn.disabled = selectedImageId === null || live;
  deleteBtn.textContent = deleteArmed ? 'Delete page?' : 'Delete';
  deleteBtn.classList.toggle('armed', deleteArmed);
  deleteBtn.title = live
    ? 'Take it off the table first'
    : 'Remove this page and everything on it';
}

// Presenting is deliberate, never a single tap: selecting a page arms this button, and pressing it
// is the second, explicit action (#50).
presentBtn.addEventListener('click', () => {
  if (!selectedImageId) return;
  ws.send(
    selectedImageId === activeImageId
      ? { type: 'map:unpresent' }
      : { type: 'map:switch', imageId: selectedImageId }
  );
});

// Two presses, because a page and its fog, its start point and its monsters do not come back.
deleteBtn.addEventListener('click', (ev) => {
  // The document-level click that dismisses popups also disarms this one, and without stopping
  // here it would see this very press as "the GM did something else" and undo the arming.
  ev.stopPropagation();
  if (!selectedImageId) return;
  if (!deleteArmed) {
    deleteArmed = true;
    renderPageControls();
    return;
  }
  void confirmDelete();
});

async function confirmDelete() {
  const id = selectedImageId;
  if (!id) return;
  deleteArmed = false;
  try {
    await api.deleteImage(adventureId, password, id);
  } catch (e) {
    console.error('Could not delete this page', e);
    renderPageControls();
    return;
  }
  imageList = imageList.filter((i) => i.id !== id);
  // The canvas stack is drawn on the page that just left, so the selection has to go with it.
  await focusPage(null);
  renderPages();
  if (imageList.length > 0) fitBoard();
}

// --- Empty state ---
function updateEmptyState() {
  emptyState.hidden = imageList.length > 0;
}

/**
 * Says that something the GM asked for did not happen. It clears itself, and any successful page
 * load clears it too — the message is about the last attempt, not a state to dismiss.
 */
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
function showNotice(text: string) {
  noticeEl.textContent = text;
  noticeEl.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(clearNotice, 6000);
}
function clearNotice() {
  if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
  noticeEl.hidden = true;
  noticeEl.textContent = '';
}

emptyUploadBtn.addEventListener('click', () => uploadInput.click());

// --- The invite link ---
// One path to it, in the players popover, because "who is at this table" is the question it
// answers and the avatars are already where that is asked.
copyInviteBtn.addEventListener('click', () => {
  if (!inviteUrl) return;
  navigator.clipboard.writeText(inviteUrl).catch(() => {});
  copyInviteBtn.textContent = 'Copied!';
  setTimeout(() => { copyInviteBtn.textContent = 'Copy invite link'; }, 1500);
});

// --- The start point ---
// Where the party lands when this map is presented. GM-only: the marker is never sent to players,
// so they cannot see where they will appear.
//
// Every map has one. A null `start_x` means "never moved", not "none" — the server already lands
// the party at the map centre in that case, so the marker is drawn there rather than hidden. There
// is nothing to create and nothing to clear (#57).
let startPoint: { x: number; y: number } | null = null;
let startLocked = false;
let startSelected = false;
/**
 * Set the moment a gesture lands on the marker, not once it passes the drag threshold: what the
 * GM needs to know is *what they picked up*, and by the time the thing has moved they know already.
 * A locked marker shows it too — it says the grab registered and the lock is why nothing follows.
 */
let startHeld = false;

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

// Selecting the marker reveals its menu — the same component the page menu uses, so the two cannot
// be open at once and neither can forget the viewport opt-out that makes its buttons clickable.
const startMenu = createAnchoredMenu(canvasCtrl.getWrapper(), 'start-menu');

/** Mirrors gatherRingRadius on the server so the ring shows the real landing area. */
function gatherRingRadius(count: number): number {
  return tokenRadius * Math.max(2.2, Math.max(count, 1) * 0.45);
}

/** The grabbable part is the flag glyph, not the landing ring, which overlaps the party. */
function startGlyphRadius(): number {
  return Math.max(16, tokenRadius * 1.6) / 2;
}

/**
 * Grab radius in image pixels, floored at a finger-sized target on screen — the same reasoning as
 * `hitRadius` in tokens.ts, since a marker drawn in image space is a few pixels wide when zoomed out.
 */
const MIN_TOUCH_PX = 22;
function startHitRadius(): number {
  const scale = viewport.scale > 0 ? viewport.scale : 1;
  return Math.max(startGlyphRadius(), MIN_TOUCH_PX / scale);
}

function isOnStartMarker(pageX: number, pageY: number): boolean {
  if (!startPoint || startMarker.hidden) return false;
  const dx = pageX - startPoint.x;
  const dy = pageY - startPoint.y;
  return Math.sqrt(dx * dx + dy * dy) <= startHitRadius();
}

function renderStartMarker() {
  if (!startPoint) {
    startMarker.hidden = true;
    startMenu.close();
    return;
  }
  const size = gatherRingRadius(playerRoster.length) * 2;
  startMarker.style.width = `${size}px`;
  startMarker.style.height = `${size}px`;
  startMarker.style.left = `${startPoint.x}px`;
  startMarker.style.top = `${startPoint.y}px`;
  const glyph = startGlyphRadius() * 2;
  startMarkerFlag.style.width = `${glyph}px`;
  startMarkerFlag.style.height = `${glyph}px`;
  startMarkerLabel.style.fontSize = `${Math.max(9, tokenRadius * 0.6)}px`;
  startMarker.classList.toggle('locked', startLocked);
  startMarker.classList.toggle('selected', startSelected);
  startMarker.classList.toggle('held', startHeld);
  startMarker.hidden = false;

  if (startSelected) {
    // A locked marker still selects — otherwise there would be no way to unlock it.
    startMenu.setItems([
      {
        label: startLocked ? 'Unlock' : 'Lock',
        onSelect: () => {
          if (!selectedImageId) return;
          ws.send({ type: 'map:start_point:lock', imageId: selectedImageId, locked: !startLocked });
        },
      },
    ]);
    startMenu.anchorAt(startPoint.x, startPoint.y - size / 2);
    startMenu.applyScale(viewport.scale);
    startMenu.open();
  } else {
    startMenu.close();
  }
}

function selectStartMarker(selected: boolean) {
  if (startSelected === selected) return;
  startSelected = selected;
  renderStartMarker();
}


ws.on('map:start_point:set', (msg) => {
  const img = imageList.find(i => i.id === msg.imageId);
  if (img) {
    img.start_x = msg.x;
    img.start_y = msg.y;
    img.start_locked = msg.locked ? 1 : 0;
  }
  if (msg.imageId === selectedImageId) syncStartPointFromImageList();
});

/** Restores the marker for whichever page the GM is on, at the centre when it was never moved. */
function syncStartPointFromImageList() {
  const img = imageList.find(i => i.id === selectedImageId);
  if (!img) {
    startPoint = null;
    startLocked = false;
    renderStartMarker();
    return;
  }
  // The same fallback the server uses to place the party, made visible.
  startPoint = {
    x: img.start_x ?? img.width / 2,
    y: img.start_y ?? img.height / 2,
  };
  startLocked = img.start_locked === 1;
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
  if (!name || !pendingPlacePos || !selectedImageId) return;
  ws.send({
    type: 'gm_token:place',
    imageId: selectedImageId,
    name,
    tokenType: pendingTokenType,
    x: pendingPlacePos.x,
    y: pendingPlacePos.y,
  });
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

  // Nobody has joined, and the invite link lives behind these avatars — an empty strip would leave
  // the GM nothing to press at exactly the moment they want it.
  if (sorted.length === 0) {
    const ghost = document.createElement('div');
    ghost.className = 'presence-avatar presence-empty';
    ghost.textContent = '+';
    playerPresenceEl.appendChild(ghost);
  }

  renderPlayersList(sorted);
}

function renderPlayersList(roster: Array<{ tokenId: string; name: string; color: string; online: boolean }>) {
  playersList.replaceChildren();

  if (roster.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'popover-empty';
    empty.textContent = 'No players yet';
    playersList.appendChild(empty);
    return;
  }

  for (const player of roster) {
    const row = document.createElement('div');
    row.className = `player-row ${player.online ? 'online' : 'offline'}`;

    // Online is the dot's ring, the way it is on the avatars above. A word would not fit and would
    // say it in a second place.
    const dot = document.createElement('span');
    dot.className = 'player-row-dot';
    dot.style.background = player.color;
    dot.title = player.online ? 'online' : 'offline';

    const name = document.createElement('span');
    name.className = 'player-row-name';
    name.textContent = player.name;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'player-row-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      ws.send({ type: 'player:remove', tokenId: player.tokenId });
    });

    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(removeBtn);
    playersList.appendChild(row);
  }
}

// --- Upload ---
// The server puts a new page on a free spot, so it never lands on top of one already there.
uploadInput.addEventListener('change', async () => {
  const file = uploadInput.files?.[0];
  if (!file) return;
  try {
    const uploaded = await api.uploadImage(adventureId, password, file);
    imageList = await api.listImages(adventureId, password);
    renderPages();
    // A board that had nothing on it now has something to work on.
    if (!selectedImageId) await focusPage(uploaded.id);
  } catch (e) {
    console.error('Upload failed', e);
  }
  uploadInput.value = '';
});

// --- Mode, and arming the brush ---
// Picking Reveal or Re-fog arms the brush; tapping the armed segment disarms it. The board needs
// the distinction because one finger has two jobs: dragging pages, and painting.
function setMode(mode: 'reveal' | 'fog') {
  brushMode = mode;
  modeRevealBtn.classList.toggle('active', brushArmed && mode === 'reveal');
  modeFogBtn.classList.toggle('active', brushArmed && mode === 'fog');
  document.body.classList.toggle('painting-armed', brushArmed);
}

function setArmed(armed: boolean) {
  brushArmed = armed && isPageReady();
  setMode(brushMode);
}

function toggleBrush(mode: 'reveal' | 'fog') {
  if (!isPageReady()) return;
  if (brushArmed && brushMode === mode) {
    setArmed(false);
    return;
  }
  brushMode = mode;
  deactivatePlaceMode();
  selectStartMarker(false);
  setArmed(true);
}

modeRevealBtn.addEventListener('click', () => toggleBrush('reveal'));
modeFogBtn.addEventListener('click', () => toggleBrush('fog'));

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

// --- Popover management ---
// A popover hangs off the control that opened it. Toolbar popovers open upwards and topbar ones
// downwards, which is the only thing that differs between them — registering a popover here is
// what wires up dismissal, so adding one cannot forget to.
const popovers: Array<{ popup: HTMLElement; anchor: HTMLElement; place: 'above' | 'below' }> = [];

function registerPopover(popup: HTMLElement, anchor: HTMLElement, place: 'above' | 'below') {
  popovers.push({ popup, anchor, place });
  anchor.addEventListener('click', (e) => { e.stopPropagation(); togglePopup(popup); });
  // Working inside a popover is not clicking outside it.
  popup.addEventListener('click', (e) => e.stopPropagation());
}

function closeAllPopups() {
  for (const { popup, anchor } of popovers) {
    popup.setAttribute('hidden', '');
    anchor.classList.remove('active');
    if (anchor.hasAttribute('aria-expanded')) anchor.setAttribute('aria-expanded', 'false');
  }
  // A half-pressed Delete does not survive the GM doing something else — the confirm means "yes,
  // this page, now", and it should not still be waiting several gestures later.
  if (deleteArmed) {
    deleteArmed = false;
    renderPageControls();
  }
}

function togglePopup(popup: HTMLElement) {
  const entry = popovers.find(p => p.popup === popup);
  if (!entry) return;
  const isOpen = !popup.hasAttribute('hidden');
  closeAllPopups();
  if (isOpen) return;

  // Unhide first: a panel's width is its content's, so it cannot be measured while hidden.
  popup.removeAttribute('hidden');
  const rect = entry.anchor.getBoundingClientRect();
  const popupWidth = popup.getBoundingClientRect().width;
  let left = rect.left + rect.width / 2 - popupWidth / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - popupWidth - 8));
  popup.style.left = `${left}px`;
  if (entry.place === 'below') {
    popup.style.top = `${rect.bottom + 8}px`;
    popup.style.bottom = '';
  } else {
    popup.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    popup.style.top = '';
  }

  entry.anchor.classList.add('active');
  if (entry.anchor.hasAttribute('aria-expanded')) entry.anchor.setAttribute('aria-expanded', 'true');
}

registerPopover(brushPopup, brushBtn, 'above');
registerPopover(settingsPopup, settingsBtn, 'below');
registerPopover(playersPopup, playerPresenceEl, 'below');

document.addEventListener('click', () => closeAllPopups());
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && placeModeActive) deactivatePlaceMode();
});

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

// Undo steps the page the GM is working on, which is not always the page on the table. Each page
// has its own stack on the server, so the two never interfere (#51).
function performUndo() {
  if (selectedImageId) ws.send({ type: 'fog:undo', imageId: selectedImageId });
}
function performRedo() {
  if (selectedImageId) ws.send({ type: 'fog:redo', imageId: selectedImageId });
}

ws.on('fog:history', (msg) => {
  if (msg.imageId !== selectedImageId) return;
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
/**
 * The page the stroke in progress belongs to, captured when it began.
 *
 * Read at send time instead, a selection that changed mid-gesture would land the tail of a stroke
 * on another page — and with preparation that could be the page on the table.
 */
let drawingImageId: string | null = null;
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
  const pos = screenToPage(clientX, clientY);
  return { x: pos.x, y: pos.y, radius: brushRadius, mode: brushMode };
}

function flushPending() {
  if (!pending.length) return;
  if (!drawingImageId) {
    pending.length = 0;
    return;
  }
  if (pending.length === 1) {
    ws.send({ type: 'fog:stroke', imageId: drawingImageId, stroke: pending[0] });
  } else {
    ws.send({ type: 'fog:stroke:batch', imageId: drawingImageId, strokes: pending.slice() });
  }
  pending.length = 0;
  lastFlush = Date.now();
}

/**
 * Picks up a token under the pointer, if one is there. Tokens outrank the page they stand on —
 * the same precedence the start marker takes — so a monster can be dragged whether or not a tool
 * is armed. Without this the board's page drag swallowed every attempt to move one (#51).
 *
 * The party stands on the presented page, so they are only grabbable there. Monsters belong to
 * whichever page is selected and are draggable while it is prepared.
 */
function beginTokenDrag(ev: PointerEvent): boolean {
  activeDragCtrl = null;
  if (!isPageReady()) return false;
  if (isLivePageSelected()) {
    tokenCtrl.handlePointerDown(ev);
    if (tokenCtrl.isDragging()) { activeDragCtrl = tokenCtrl; return true; }
  }
  gmTokenCtrl.handlePointerDown(ev);
  if (gmTokenCtrl.isDragging()) { activeDragCtrl = gmTokenCtrl; return true; }
  return false;
}

viewport.onInteractStart((ev: PointerEvent) => {
  if (imageList.length === 0) return;
  closeAllPopups();

  // Place token mode — show form on click, skip painting.
  //
  // A monster belongs to the selected page, and the token layer is sized to that page: one placed
  // outside it is drawn nowhere, and double-clicking it is the only way to remove it, so it cannot
  // be reached again (#66). The board made every coordinate off the page tappable — on one map
  // there was nothing else to hit. The tap is ignored and the tool stays armed, so the GM's next
  // tap on the page still works. Same trap #17 fixed for the party.
  if (placeModeActive) {
    const pos = screenToPage(ev.clientX, ev.clientY);
    const { w, h } = canvasCtrl.getImageSize();
    if (pos.x < 0 || pos.y < 0 || pos.x > w || pos.y > h) return;
    showPlaceForm(ev.clientX, ev.clientY, pos.x, pos.y);
    return;
  }

  // Nothing armed: one finger works the board. A tap selects the page under it, a drag moves it,
  // and neither reaches the players (#49, #50). With the brush armed, pages hold still instead.
  if (!brushArmed) {
    // The marker takes precedence over the page beneath it, the same order the token layers take.
    // A tap selects it, revealing its menu; a drag moves it, unless it is locked.
    const page = screenToPage(ev.clientX, ev.clientY);
    if (isOnStartMarker(page.x, page.y)) {
      startPointerStart = { x: ev.clientX, y: ev.clientY };
      startDragging = false;
      startHeld = true;
      renderStartMarker();
      return;
    }
    selectStartMarker(false);

    // Evaluated after the token hit test, not before it: the press that becomes a tap on the
    // selected token has to survive long enough for `onTapToken` to toggle it closed.
    if (beginTokenDrag(ev)) return;
    tokenMenu.select(null);

    const world = viewport.screenToImage(ev.clientX, ev.clientY);
    const hit = board.pageAt(world.x, world.y);
    if (hit) board.beginDrag(hit, world.x, world.y);
    boardPointerTarget = hit;
    boardPointerStart = { x: ev.clientX, y: ev.clientY };
    boardDragStarted = false;
    return;
  }

  if (!isPageReady()) return;

  if (beginTokenDrag(ev)) return;
  tokenMenu.select(null);

  toolbox.classList.add('painting');

  // A ping is "look here", so it only means anything on the page the table is looking at. It
  // carries no page of its own and stores nothing, so there is nothing for the server to file a
  // ping on a page in preparation under — the gesture simply is not offered there.
  if (isLivePageSelected()) {
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
        const pos = screenToPage(longPressStartPos!.x, longPressStartPos!.y);
        ws.send({ type: 'ping:map', x: pos.x, y: pos.y, color: GM_PING_COLOR });
      }
    }, LONG_PRESS_DELAY);
  }

  isDrawing = true;
  drawingImageId = selectedImageId;
  const stroke = makeStroke(ev.clientX, ev.clientY);
  canvasCtrl.applyStroke(stroke);
  pending.push(stroke);
  actionHasStrokes = true;
  if (Date.now() - lastFlush >= FLUSH_INTERVAL) flushPending();
});

viewport.onPointerMove((ev: PointerEvent) => {
  if (startPointerStart) {
    if (!startDragging) {
      const dx = ev.clientX - startPointerStart.x;
      const dy = ev.clientY - startPointerStart.y;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      // A locked marker absorbs the gesture rather than falling through to the page: dragging the
      // board out from under a flag the GM just tried to move would read as the lock misfiring.
      if (startLocked) return;
      startDragging = true;
    }
    const page = screenToPage(ev.clientX, ev.clientY);
    startPoint = { x: page.x, y: page.y };
    renderStartMarker();
    return;
  }

  if (board.isDragging()) {
    // A finger never lands perfectly still. Without a threshold every tap would count as a drag
    // and nothing on the board could be selected by touch.
    if (!boardDragStarted && boardPointerStart) {
      const dx = ev.clientX - boardPointerStart.x;
      const dy = ev.clientY - boardPointerStart.y;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      boardDragStarted = true;
    }
    const world = viewport.screenToImage(ev.clientX, ev.clientY);
    board.dragTo(world.x, world.y);
    // The canvas stack rides along with the page it is drawn on.
    if (boardPointerTarget === selectedImageId) syncCanvasToSelectedPage();
    return;
  }
  if (activeDragCtrl) { activeDragCtrl.handlePointerMove(ev); return; }

  if (!brushArmed) return;

  const pos = screenToPage(ev.clientX, ev.clientY);
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

/** Set while a gesture began on the start marker, so a tap can be told from a drag. */
let startPointerStart: { x: number; y: number } | null = null;
let startDragging = false;

/** The page a board gesture started on, so a tap that never moved can be read as a selection. */
let boardPointerTarget: string | null = null;
let boardPointerStart: { x: number; y: number } | null = null;
let boardDragStarted = false;
/** Screen pixels a pointer must travel before a tap becomes a drag. */
const DRAG_THRESHOLD_PX = 5;

function syncCanvasToSelectedPage() {
  if (!selectedImageId) return;
  const rect = board.rectOf(selectedImageId);
  if (!rect) return;
  canvasWrapper.style.left = `${rect.x}px`;
  canvasWrapper.style.top = `${rect.y}px`;
}

function finishBoardGesture() {
  const dragged = boardDragStarted;
  const dropped = board.endDrag();
  const tapped = boardPointerTarget;
  boardPointerTarget = null;
  boardPointerStart = null;
  boardDragStarted = false;

  if (dragged && dropped) {
    // One write per drag, on release. The arrangement is the GM's alone and never goes on the wire.
    api.setBoardPosition(adventureId, password, dropped.id, dropped.x, dropped.y)
      .catch((e) => console.error('Could not save the page position', e));
    const record = imageList.find(i => i.id === dropped.id);
    if (record) { record.board_x = dropped.x; record.board_y = dropped.y; }
    return;
  }

  // A tap that moved nothing selects. Selection is local: the players see no change (#50).
  //
  // Tapping the page that is already selected normally does nothing — but a page whose image
  // failed to load is selected without ever having focused, and the notice tells the GM to tap it
  // again (#67). That retry is the one case where re-selecting is not a no-op.
  if (tapped && (tapped !== selectedImageId || focusedImageId !== tapped)) void focusPage(tapped);
}

function finishStartGesture() {
  const dragged = startDragging;
  startPointerStart = null;
  startDragging = false;
  startHeld = false;
  renderStartMarker();

  if (dragged && startPoint && selectedImageId) {
    // One message on release, like a page position — not one per pointer move.
    ws.send({
      type: 'map:start_point',
      imageId: selectedImageId,
      x: Math.round(startPoint.x),
      y: Math.round(startPoint.y),
    });
    return;
  }
  // A tap that moved nothing selects the marker and shows its menu.
  selectStartMarker(!startSelected);
}

function finishAction() {
  if (startPointerStart !== null) { finishStartGesture(); return; }
  if (boardPointerTarget !== null || board.isDragging()) { finishBoardGesture(); return; }
  toolbox.classList.remove('painting');
  if (activeDragCtrl) { activeDragCtrl.handlePointerUp(); activeDragCtrl = null; return; }
  if (!isDrawing) return;
  isDrawing = false;
  const painted = drawingImageId;
  flushPending();
  drawingImageId = null;
  if (actionHasStrokes) {
    actionHasStrokes = false;
    // Ordered after flushPending, so the server snapshots the completed action — on the page the
    // stroke started on, which is the one whose undo stack it belongs to.
    if (painted) ws.send({ type: 'fog:action:end', imageId: painted });
  }
}

viewport.onInteractEnd(() => { cancelLongPress(); isPinging = false; finishAction(); });
viewport.onPointerLeave(() => {
  canvasCtrl.clearBrushPreview();
  cancelLongPress();
  isPinging = false;
  finishAction();
});
