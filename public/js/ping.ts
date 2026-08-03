const PING_DURATION = 3000;
const RING_MIN_SCREEN_PX = 15;
const RING_MAX_SCREEN_PX = 50;
const FLASH_DURATION = 200;

interface Ping {
  x: number;
  y: number;
  color: string;
  startTime: number;
}

export interface PingController {
  addPing(x: number, y: number, color: string): void;
  clear(): void;
}

export function initPingLayer(
  wrapper: HTMLElement,
  getImageSize: () => { w: number; h: number },
  getScale: () => number
): PingController {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
  wrapper.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  const pings: Ping[] = [];
  // The animation loop only runs while something is on screen. Driving rAF for
  // the whole session keeps the page from ever idling, which costs battery and
  // thermal headroom on a tablet for no benefit.
  let rafId: number | null = null;

  function ensureSize() {
    const { w, h } = getImageSize();
    if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function loop() {
    tick();
    rafId = pings.length > 0 ? requestAnimationFrame(loop) : null;
  }

  function tick() {
      if (pings.length === 0) return;
      ensureSize();
      const { w, h } = getImageSize();
      if (w === 0 || h === 0) return;

      const now = performance.now();
      for (let i = pings.length - 1; i >= 0; i--) {
        if (now - pings[i].startTime >= PING_DURATION) pings.splice(i, 1);
      }

      ctx.clearRect(0, 0, w, h);
      if (pings.length === 0) return;

      const scale = getScale();
      const invScale = scale > 0 ? 1 / scale : 1;

      for (const ping of pings) {
        const elapsed = now - ping.startTime;
        const t = elapsed / PING_DURATION;
        const opacity = 1 - t;
        const radius = (RING_MIN_SCREEN_PX + t * (RING_MAX_SCREEN_PX - RING_MIN_SCREEN_PX)) * invScale;

        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.shadowBlur = 8 * invScale;
        ctx.shadowColor = 'rgba(255,255,255,0.9)';
        ctx.strokeStyle = ping.color;
        ctx.lineWidth = 3 * invScale;
        ctx.beginPath();
        ctx.arc(ping.x, ping.y, radius, 0, Math.PI * 2);
        ctx.stroke();

        if (elapsed < FLASH_DURATION) {
          const ft = elapsed / FLASH_DURATION;
          ctx.globalAlpha = (1 - ft) * 0.5;
          ctx.shadowBlur = 0;
          ctx.fillStyle = ping.color;
          ctx.beginPath();
          ctx.arc(ping.x, ping.y, radius * 0.4, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.restore();
      }
  }

  return {
    addPing(x, y, color) {
      pings.push({ x, y, color, startTime: performance.now() });
      if (rafId === null) rafId = requestAnimationFrame(loop);
    },

    clear() {
      pings.length = 0;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      const { w, h } = getImageSize();
      if (w > 0 && h > 0) ctx.clearRect(0, 0, w, h);
    },
  };
}
