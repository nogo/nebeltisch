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
  render(): void;
}

const SCREEN_RADIUS = 20;
const SCREEN_FONT_SIZE = 12;

export function initTokenLayer(
  wrapper: HTMLElement,
  getImageSize: () => { w: number; h: number },
  options?: { interactive?: boolean }
): TokenController {
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

  function getScale(): number {
    const { w } = getImageSize();
    const cw = canvas.clientWidth || w || 1;
    return w / cw;
  }

  function screenToImage(clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    const { w, h } = getImageSize();
    return {
      x: (clientX - rect.left) * (w / (rect.width || 1)),
      y: (clientY - rect.top) * (h / (rect.height || 1)),
    };
  }

  function render() {
    const { w, h } = getImageSize();
    if (w === 0 || h === 0) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);

    const scale = getScale();
    const r = SCREEN_RADIUS * scale;
    const fontSize = Math.max(10, Math.round(SCREEN_FONT_SIZE * scale));

    for (const token of tokens.values()) {
      ctx.save();

      // Circle fill
      ctx.beginPath();
      ctx.arc(token.x, token.y, r, 0, Math.PI * 2);
      ctx.fillStyle = token.color;
      ctx.fill();

      // Highlight ring for own token
      if (token.id === ownTokenId) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2 * scale;
        ctx.stroke();
      }

      ctx.restore();

      // Name label
      ctx.save();
      ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const labelY = token.y + r + 3 * scale;

      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3 * scale;
      ctx.lineJoin = 'round';
      ctx.strokeText(token.name, token.x, labelY);

      ctx.fillStyle = '#ffffff';
      ctx.fillText(token.name, token.x, labelY);

      ctx.restore();
    }
  }

  // Drag state
  let dragging = false;
  let lastMoveTime = 0;
  const MOVE_INTERVAL = 1000 / 30;

  canvas.addEventListener('pointerdown', (ev: PointerEvent) => {
    if (!ownTokenId) return;
    const own = tokens.get(ownTokenId);
    if (!own) return;
    const scale = getScale();
    const r = SCREEN_RADIUS * scale;
    const pos = screenToImage(ev.clientX, ev.clientY);
    const dx = pos.x - own.x;
    const dy = pos.y - own.y;
    if (Math.sqrt(dx * dx + dy * dy) < r) {
      dragging = true;
      canvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }
  });

  canvas.addEventListener('pointermove', (ev: PointerEvent) => {
    if (!dragging || !ownTokenId) return;
    const pos = screenToImage(ev.clientX, ev.clientY);
    const token = tokens.get(ownTokenId);
    if (!token) return;
    token.x = pos.x;
    token.y = pos.y;
    render();
    const now = Date.now();
    if (onMoveCallback && now - lastMoveTime >= MOVE_INTERVAL) {
      onMoveCallback(pos.x, pos.y);
      lastMoveTime = now;
    }
  });

  canvas.addEventListener('pointerup', () => {
    if (!dragging || !ownTokenId) return;
    const token = tokens.get(ownTokenId);
    dragging = false;
    render();
    if (onMoveCallback && token) {
      onMoveCallback(token.x, token.y);
    }
  });

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
    render,
  };
}
