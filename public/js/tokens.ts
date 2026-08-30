import type { Token } from '../../src/types';
import { hasDragged } from './gesture';

/**
 * What the token layer needs to draw one. Derived from the server's `Token` so the field
 * names and the token_type union cannot drift; the layer has no use for the rest of the row.
 */
export type TokenData = Pick<Token, 'id' | 'name' | 'color' | 'x' | 'y'> & {
  token_type?: Token['token_type'];
};

export interface TokenController {
  /** The layer's own canvas, so a caller can hide it without clearing the tokens it holds. */
  element: HTMLCanvasElement;
  addToken(token: TokenData): void;
  removeToken(tokenId: string): void;
  renameToken(tokenId: string, name: string): void;
  moveToken(tokenId: string, x: number, y: number): void;
  enableDrag(tokenId: string, onMove: (x: number, y: number) => void): void;
  enableDragAll(onMove: (tokenId: string, x: number, y: number) => void): void;
  isDragging(): boolean;
  /** The token this layer holds under that id, or null when it belongs to the other layer. */
  getToken(tokenId: string): TokenData | null;
  /** Rings the token whose menu is open. Pass null to clear; a foreign id is a no-op. */
  setSelected(tokenId: string | null): void;
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

      if ((dragging && token.id === dragTokenId) || token.id === selectedTokenId) {
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
        // Type letter inside circle
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = `bold ${Math.max(10, r * 0.7)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(token.token_type === 'monster' ? 'M' : 'N', token.x, token.y);
      } else if (token.id === ownTokenId) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();

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
    setSelected(tokenId: string | null) {
      const next = tokenId !== null && tokens.has(tokenId) ? tokenId : null;
      if (next === selectedTokenId) return;
      selectedTokenId = next;
      render();
    },
    render,

    handlePointerDown(ev: PointerEvent) {
      const pos = screenToImage(ev.clientX, ev.clientY);

      const r = hitRadius();

      if (dragAllMode) {
        for (const token of tokens.values()) {
          const dx = pos.x - token.x;
          const dy = pos.y - token.y;
          if (Math.sqrt(dx * dx + dy * dy) < r) {
            dragging = true;
            dragTokenId = token.id;
            dragFrom = { x: ev.clientX, y: ev.clientY };
            hasMoved = false;
            render(); // The halo has to appear on the grab, not on the first movement.
            return;
          }
        }
      }

      if (!ownTokenId) return;
      const own = tokens.get(ownTokenId);
      if (!own) return;
      const dx = pos.x - own.x;
      const dy = pos.y - own.y;
      if (Math.sqrt(dx * dx + dy * dy) < r) {
        dragging = true;
        dragTokenId = ownTokenId;
        dragFrom = { x: ev.clientX, y: ev.clientY };
        hasMoved = false;
        render();
      }
    },

    handlePointerMove(ev: PointerEvent) {
      if (!dragging || !dragTokenId) return;
      // Below the threshold the token holds still and nothing goes on the wire, so a press that
      // ends up being a tap has moved nothing and remembered nothing.
      if (!hasMoved) {
        if (!dragFrom || !hasDragged(dragFrom, { x: ev.clientX, y: ev.clientY })) return;
        hasMoved = true;
      }
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
      dragging = false;
      dragFrom = null;
      hasMoved = false;
      dragTokenId = null;
      render();

      if (!moved) {
        options?.onTapToken?.(tokenId);
        return;
      }

      if (token) {
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
      selectedTokenId = null;
      render();
    },
  };
}
