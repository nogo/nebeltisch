export interface TokenData {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
}

export interface TokenController {
  addToken(token: TokenData): void;
  removeToken(tokenId: string): void;
  moveToken(tokenId: string, x: number, y: number): void;
  enableDrag(tokenId: string, onMove: (x: number, y: number) => void): void;
  enableDragAll(onMove: (tokenId: string, x: number, y: number) => void): void;
  isDragging(): boolean;
  render(): void;
  handlePointerDown(ev: PointerEvent): void;
  handlePointerMove(ev: PointerEvent): void;
  handlePointerUp(): void;
}

const DEFAULT_RADIUS = 20;
const FONT_SIZE = 12;

export function initTokenLayer(
  wrapper: HTMLElement,
  getImageSize: () => { w: number; h: number },
  screenToImage: (clientX: number, clientY: number) => { x: number; y: number },
  options?: { interactive?: boolean; getRadius?: () => number }
): TokenController {
  const getRadius = options?.getRadius ?? (() => DEFAULT_RADIUS);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
  if (options?.interactive === false) {
    canvas.style.pointerEvents = 'none';
  }
  wrapper.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  const tokens = new Map<string, TokenData>();
  let ownTokenId: string | null = null;
  let onMoveCallback: ((x: number, y: number) => void) | null = null;
  let dragAllMode = false;
  let onMoveAnyCallback: ((tokenId: string, x: number, y: number) => void) | null = null;

  function render() {
    const { w, h } = getImageSize();
    if (w === 0 || h === 0) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);

    for (const token of tokens.values()) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(token.x, token.y, getRadius(), 0, Math.PI * 2);
      ctx.fillStyle = token.color;
      ctx.fill();
      if (token.id === ownTokenId) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();

      ctx.save();
      ctx.font = `bold ${FONT_SIZE}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const labelY = token.y + getRadius() + 3;
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
  let dragging = false;
  let dragTokenId: string | null = null;
  let lastMoveTime = 0;
  const MOVE_INTERVAL = 1000 / 30;

  return {
    addToken(token: TokenData) {
      tokens.set(token.id, { ...token });
      render();
    },
    removeToken(tokenId: string) {
      tokens.delete(tokenId);
      render();
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
    render,

    handlePointerDown(ev: PointerEvent) {
      const pos = screenToImage(ev.clientX, ev.clientY);

      if (dragAllMode) {
        // GM mode: find any token under cursor
        for (const token of tokens.values()) {
          const dx = pos.x - token.x;
          const dy = pos.y - token.y;
          if (Math.sqrt(dx * dx + dy * dy) < getRadius()) {
            dragging = true;
            dragTokenId = token.id;
            return;
          }
        }
      }

      // Player mode: only own token
      if (!ownTokenId) return;
      const own = tokens.get(ownTokenId);
      if (!own) return;
      const dx = pos.x - own.x;
      const dy = pos.y - own.y;
      if (Math.sqrt(dx * dx + dy * dy) < getRadius()) {
        dragging = true;
        dragTokenId = ownTokenId;
      }
    },

    handlePointerMove(ev: PointerEvent) {
      if (!dragging || !dragTokenId) return;
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
      dragging = false;
      render();
      if (token) {
        if (dragAllMode && onMoveAnyCallback) {
          onMoveAnyCallback(dragTokenId, token.x, token.y);
        } else if (onMoveCallback) {
          onMoveCallback(token.x, token.y);
        }
      }
      dragTokenId = null;
    },
  };
}
