import type { Token } from '../../src/types';
import { hasDragged } from './gesture';

/**
 * What the token layer needs to draw one. Derived from the server's `Token` so the field
 * names and the token_type union cannot drift; the layer has no use for the rest of the row.
 */
export type TokenData = Pick<Token, 'id' | 'name' | 'color' | 'x' | 'y' | 'state'> & {
  token_type?: Token['token_type'];
};

export interface TokenController {
  /** The layer's own canvas, so a caller can hide it without clearing the tokens it holds. */
  element: HTMLCanvasElement;
  addToken(token: TokenData): void;
  removeToken(tokenId: string): void;
  renameToken(tokenId: string, name: string): void;
  /** Standing, down or gone. Only the GM's message ever changes it (#61). */
  setTokenState(tokenId: string, state: Token['state']): void;
  moveToken(tokenId: string, x: number, y: number): void;
  enableDrag(tokenId: string, onMove: (x: number, y: number) => void): void;
  enableDragAll(onMove: (tokenId: string, x: number, y: number) => void): void;
  isDragging(): boolean;
  /** The token this layer holds under that id, or null when it belongs to the other layer. */
  getToken(tokenId: string): TokenData | null;
  /** Rings the token whose menu is open. Pass null to clear; a foreign id is a no-op. */
  setSelected(tokenId: string | null): void;
  /**
   * The declarations pointing at each token, as the colours to draw their pips in, in arrival
   * order (#72). Keyed by target; ids this layer does not hold are ignored, so both layers can be
   * handed the same map.
   *
   * The layer knows nothing about who is attacking whom — only that a ring can carry marks. The
   * caller resolves each colour, because it is the one that knows what a sourceless declaration
   * means.
   */
  setDeclarations(byTarget: Map<string, string[]>): void;
  render(): void;
  handlePointerDown(ev: PointerEvent): void;
  handlePointerMove(ev: PointerEvent): void;
  handlePointerUp(): void;
  clear(): void;
}

const DEFAULT_RADIUS = 20;
const FONT_SIZE = 12;
/** Apple HIG asks for 44pt; half of that is the radius a fingertip can reliably land. */
const MIN_TOUCH_PX = 22;
/**
 * How far outside the token the "held" halo sits, in *screen* pixels. A fingertip covers the token
 * it just grabbed, so feedback drawn under it says nothing; the halo has to clear the finger. It is
 * a ring rather than a larger token because the drawn radius is the party's footprint and must not
 * appear to change while being moved.
 */
const HELD_HALO_PX = 14;
/**
 * A pip is smaller than the token it sits on, so it needs the screen-space floor harder than the
 * token does: drawn in image pixels alone it is a smudge at the zoom a fight is played at.
 */
const PIP_MIN_PX = 7;

/**
 * The shape half of a state: a bar through an unconscious token, a cross through a dead one.
 *
 * Outlined the way the name label is, so it holds on a light map and a dark one alike, and sized
 * off the radius so it survives the adventure's token size being anything.
 */
function drawStateGlyph(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  state: 'unconscious' | 'dead'
): void {
  const reach = r * 0.55;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (state === 'dead') {
    ctx.moveTo(x - reach, y - reach);
    ctx.lineTo(x + reach, y + reach);
    ctx.moveTo(x + reach, y - reach);
    ctx.lineTo(x - reach, y + reach);
  } else {
    ctx.moveTo(x - reach, y);
    ctx.lineTo(x + reach, y);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = Math.max(4, r * 0.34);
  ctx.stroke();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(2, r * 0.18);
  ctx.stroke();
  ctx.restore();
}

/**
 * The declarations aimed at a token, as coloured pips around the upper right of its ring (#72).
 *
 * Colour is the entire message: every token carries one, monsters included, so three pips on one
 * orc read as three named people with no lines drawn across the map. The upper right is the only
 * side that is free — the name label sits below and the menu hangs above.
 *
 * Never faded with the token. An attack declared on something already down is still something the
 * table said, and the fade is about the token, not about what points at it.
 */
function drawPips(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  scale: number,
  colors: string[]
): void {
  const pipR = Math.max(r * 0.3, PIP_MIN_PX / scale);
  const ring = r + pipR * 0.6;
  const step = (pipR * 2.3) / ring;
  const first = -Math.PI / 4 - (step * (colors.length - 1)) / 2;
  ctx.save();
  colors.forEach((color, i) => {
    const angle = first + step * i;
    ctx.beginPath();
    ctx.arc(x + Math.cos(angle) * ring, y + Math.sin(angle) * ring, pipR, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    // Dark then white, the way the name label is outlined: a player's colour has to hold on a
    // light map and a dark one alike.
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(2, pipR * 0.4);
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, pipR * 0.2);
    ctx.stroke();
  });
  ctx.restore();
}

export function initTokenLayer(
  wrapper: HTMLElement,
  getImageSize: () => { w: number; h: number },
  screenToImage: (clientX: number, clientY: number) => { x: number; y: number },
  options?: {
    interactive?: boolean;
    getRadius?: () => number;
    getScale?: () => number;
    insertBefore?: HTMLElement;
    /** A press that lifted without dragging. The token was not moved. */
    onTapToken?: (tokenId: string) => void;
  }
): TokenController {
  const getRadius = options?.getRadius ?? (() => DEFAULT_RADIUS);
  const getScale = options?.getScale ?? (() => 1);

  /**
   * Grab radius in image pixels, floored at a finger-sized target on screen.
   * The drawn radius is in image space, so at fit-zoom on a tablet a 20px token
   * is only a few screen pixels wide — visually fine, impossible to hit.
   */
  function hitRadius(): number {
    const scale = getScale();
    return Math.max(getRadius(), MIN_TOUCH_PX / (scale > 0 ? scale : 1));
  }
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
  if (options?.interactive === false) {
    canvas.style.pointerEvents = 'none';
  }
  if (options?.insertBefore) {
    wrapper.insertBefore(canvas, options.insertBefore);
  } else {
    wrapper.appendChild(canvas);
  }
  const ctx = canvas.getContext('2d')!;

  const tokens = new Map<string, TokenData>();
  let ownTokenId: string | null = null;
  let onMoveCallback: ((x: number, y: number) => void) | null = null;
  let dragAllMode = false;
  let onMoveAnyCallback: ((tokenId: string, x: number, y: number) => void) | null = null;
  let selectedTokenId: string | null = null;
  let declarations = new Map<string, string[]>();

  /**
   * The first token whose finger-sized hit area contains this point, own token first.
   *
   * The tie matters: standing on a friend must not cost a player the ability to drag themselves,
   * and their own is the only one they can move.
   */
  function tokenAtPoint(pos: { x: number; y: number }): TokenData | null {
    const r = hitRadius();
    let hit: TokenData | null = null;
    for (const token of tokens.values()) {
      const dx = pos.x - token.x;
      const dy = pos.y - token.y;
      if (dx * dx + dy * dy >= r * r) continue;
      if (token.id === ownTokenId) return token;
      if (!hit) hit = token;
    }
    return hit;
  }

  function render() {
    const { w, h } = getImageSize();
    if (w === 0 || h === 0) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);

    for (const token of tokens.values()) {
      const r = getRadius();
      const isGmToken = token.token_type === 'monster' || token.token_type === 'npc';
      const down = token.state !== 'alive';

      if ((dragging && pressCanMove && token.id === dragTokenId) || token.id === selectedTokenId) {
        const s = getScale() > 0 ? getScale() : 1;
        ctx.save();
        ctx.beginPath();
        ctx.arc(token.x, token.y, r + HELD_HALO_PX / s, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 2 / s;
        ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      // State is shape and weight, never hue: the colour is the only thing on the map that says
      // whose token this is, and greying a dead one out would spend it to say something else.
      ctx.globalAlpha = token.state === 'dead' ? 0.45 : token.state === 'unconscious' ? 0.65 : 1;
      ctx.beginPath();
      ctx.arc(token.x, token.y, r, 0, Math.PI * 2);
      ctx.fillStyle = token.color;
      ctx.fill();

      if (isGmToken) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        // Type letter inside circle. The state glyph takes this spot when there is one: monster or
        // NPC is still read off the dashed ring and the name, and the state is the news.
        if (!down) {
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.font = `bold ${Math.max(10, r * 0.7)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(token.token_type === 'monster' ? 'M' : 'N', token.x, token.y);
        }
      } else if (token.id === ownTokenId) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();

      // Full strength over the faded circle: the fade says "out of the fight", the glyph says
      // which kind of out, and at fight zoom a fade on its own is a guess.
      if (token.state !== 'alive') drawStateGlyph(ctx, token.x, token.y, r, token.state);

      const pips = declarations.get(token.id);
      if (pips && pips.length > 0) {
        drawPips(ctx, token.x, token.y, r, getScale() > 0 ? getScale() : 1, pips);
      }

      // Name label below circle
      ctx.save();
      ctx.font = `bold ${FONT_SIZE}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const labelY = token.y + r + 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeText(token.name, token.x, labelY);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(token.name, token.x, labelY);
      ctx.restore();
    }
  }

  // Drag state
  //
  // `dragging` means "this layer has the gesture" and is set on the grab, because the held halo
  // has to appear when the token is picked up rather than when it first moves. Whether the token
  // actually *moved* is a separate question, and the one that decides between a tap and a drag.
  let dragging = false;
  let dragTokenId: string | null = null;
  /** Whether the press that took this token may also move it. A tap-only press may not. */
  let pressCanMove = false;
  let dragFrom: { x: number; y: number } | null = null;
  let hasMoved = false;
  let lastMoveTime = 0;
  const MOVE_INTERVAL = 1000 / 30;

  return {
    element: canvas,

    addToken(token: TokenData) {
      tokens.set(token.id, { ...token });
      render();
    },
    removeToken(tokenId: string) {
      tokens.delete(tokenId);
      render();
    },
    renameToken(tokenId: string, name: string) {
      const t = tokens.get(tokenId);
      if (t) { t.name = name; render(); }
    },
    setTokenState(tokenId: string, state: Token['state']) {
      const t = tokens.get(tokenId);
      if (t) { t.state = state; render(); }
    },
    moveToken(tokenId: string, x: number, y: number) {
      const t = tokens.get(tokenId);
      if (t) { t.x = x; t.y = y; render(); }
    },
    enableDrag(tokenId: string, onMove: (x: number, y: number) => void) {
      ownTokenId = tokenId;
      onMoveCallback = onMove;
    },
    enableDragAll(onMove: (tokenId: string, x: number, y: number) => void) {
      dragAllMode = true;
      onMoveAnyCallback = onMove;
    },
    isDragging() { return dragging; },
    getToken(tokenId: string) { return tokens.get(tokenId) ?? null; },
    setDeclarations(byTarget: Map<string, string[]>) {
      declarations = byTarget;
      render();
    },
    setSelected(tokenId: string | null) {
      const next = tokenId !== null && tokens.has(tokenId) ? tokenId : null;
      if (next === selectedTokenId) return;
      selectedTokenId = next;
      render();
    },
    render,

    handlePointerDown(ev: PointerEvent) {
      const hit = tokenAtPoint(screenToImage(ev.clientX, ev.clientY));
      if (!hit) return;
      // Whether this press may *move* the token is a separate question from whether this layer
      // answers the press at all. A player taps a monster to open its menu and may not drag it, so
      // the press is taken and the movement is not (#72).
      const canMove = dragAllMode || hit.id === ownTokenId;
      if (!canMove && !options?.onTapToken) return;
      dragging = true;
      dragTokenId = hit.id;
      pressCanMove = canMove;
      dragFrom = { x: ev.clientX, y: ev.clientY };
      hasMoved = false;
      if (canMove) render(); // The halo has to appear on the grab, not on the first movement.
    },

    handlePointerMove(ev: PointerEvent) {
      if (!dragging || !dragTokenId) return;
      // Below the threshold the token holds still and nothing goes on the wire, so a press that
      // ends up being a tap has moved nothing and remembered nothing.
      if (!hasMoved) {
        if (!dragFrom || !hasDragged(dragFrom, { x: ev.clientX, y: ev.clientY })) return;
        hasMoved = true;
      }
      // Recorded even when the token cannot follow: the press has travelled, so it is no longer a
      // tap, and lifting it must not open a menu the finger has already left.
      if (!pressCanMove) return;
      const pos = screenToImage(ev.clientX, ev.clientY);
      const token = tokens.get(dragTokenId);
      if (!token) return;
      token.x = pos.x;
      token.y = pos.y;
      render();
      const now = Date.now();
      if (now - lastMoveTime >= MOVE_INTERVAL) {
        if (dragAllMode && onMoveAnyCallback) {
          onMoveAnyCallback(dragTokenId, pos.x, pos.y);
        } else if (onMoveCallback) {
          onMoveCallback(pos.x, pos.y);
        }
        lastMoveTime = now;
      }
    },

    handlePointerUp() {
      if (!dragging || !dragTokenId) return;
      const token = tokens.get(dragTokenId);
      const tokenId = dragTokenId;
      const moved = hasMoved;
      const couldMove = pressCanMove;
      dragging = false;
      dragFrom = null;
      hasMoved = false;
      dragTokenId = null;
      pressCanMove = false;
      render();

      if (!moved) {
        options?.onTapToken?.(tokenId);
        return;
      }

      if (token && couldMove) {
        if (dragAllMode && onMoveAnyCallback) {
          onMoveAnyCallback(tokenId, token.x, token.y);
        } else if (onMoveCallback) {
          onMoveCallback(token.x, token.y);
        }
      }
    },

    clear() {
      tokens.clear();
      dragging = false;
      dragTokenId = null;
      dragFrom = null;
      hasMoved = false;
      pressCanMove = false;
      selectedTokenId = null;
      render();
    },
  };
}
