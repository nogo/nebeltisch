export interface FogStroke {
  x: number;
  y: number;
  radius: number;
  mode: 'reveal' | 'fog';
}

export interface CanvasController {
  loadImage(url: string): Promise<void>;
  applyFogMask(base64: string): Promise<void>;
  applyStroke(stroke: FogStroke): void;
  drawBrushPreview(imgX: number, imgY: number, radius: number): void;
  clearBrushPreview(): void;
  screenToImage(clientX: number, clientY: number): { x: number; y: number };
  getEventTarget(): HTMLCanvasElement;
  clear(): void;
}

const FOG_ALPHA = 0.85;
const FOG_FILL = `rgba(0,0,0,${FOG_ALPHA})`;

async function decompress(data: Uint8Array): Promise<Uint8Array> {
  // Try zlib (deflate with header) first, then raw deflate
  for (const fmt of ['deflate', 'deflate-raw'] as CompressionFormat[]) {
    try {
      const ds = new DecompressionStream(fmt);
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      // Clone data to avoid detached buffer on retry
      writer.write(data.slice());
      writer.close();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    } catch {
      // try next format
    }
  }
  throw new Error('Failed to decompress fog mask');
}

export function initCanvas(container: HTMLElement): CanvasController {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:relative;flex-shrink:0;';
  container.appendChild(wrapper);

  function makeCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
    wrapper.appendChild(c);
    return c;
  }

  const mapCanvas = makeCanvas();
  const fogCanvas = makeCanvas();
  const previewCanvas = makeCanvas();
  previewCanvas.style.pointerEvents = 'none';

  const mapCtx = mapCanvas.getContext('2d')!;
  const fogCtx = fogCanvas.getContext('2d')!;
  const previewCtx = previewCanvas.getContext('2d')!;

  let imgW = 0;
  let imgH = 0;

  function sizeAll(w: number, h: number) {
    imgW = w;
    imgH = h;
    for (const c of [mapCanvas, fogCanvas, previewCanvas]) {
      c.width = w;
      c.height = h;
    }
    const cw = container.clientWidth || 800;
    const ch = container.clientHeight || 600;
    const scale = Math.min(cw / w, ch / h);
    wrapper.style.width = `${Math.round(w * scale)}px`;
    wrapper.style.height = `${Math.round(h * scale)}px`;
  }

  function fillFog() {
    fogCtx.save();
    fogCtx.globalCompositeOperation = 'source-over';
    fogCtx.fillStyle = FOG_FILL;
    fogCtx.fillRect(0, 0, imgW, imgH);
    fogCtx.restore();
  }

  return {
    async loadImage(url: string) {
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error(`Failed to load image: ${url}`));
        img.src = url;
      });
      sizeAll(img.naturalWidth, img.naturalHeight);
      mapCtx.clearRect(0, 0, imgW, imgH);
      mapCtx.drawImage(img, 0, 0);
      fogCtx.clearRect(0, 0, imgW, imgH);
      fillFog();
      previewCtx.clearRect(0, 0, imgW, imgH);
    },

    async applyFogMask(base64: string) {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const view = new DataView(bytes.buffer);
      const w = view.getUint32(0, false);
      const h = view.getUint32(4, false);
      const pixels = await decompress(bytes.slice(8));
      if (imgW !== w || imgH !== h) sizeAll(w, h);
      const id = fogCtx.createImageData(w, h);
      for (let i = 0; i < pixels.length; i++) {
        const v = pixels[i];
        id.data[i * 4 + 0] = 0;
        id.data[i * 4 + 1] = 0;
        id.data[i * 4 + 2] = 0;
        id.data[i * 4 + 3] = Math.round(v * FOG_ALPHA);
      }
      fogCtx.putImageData(id, 0, 0);
    },

    applyStroke(stroke: FogStroke) {
      if (imgW === 0) return;
      fogCtx.save();
      fogCtx.beginPath();
      fogCtx.arc(stroke.x, stroke.y, stroke.radius, 0, Math.PI * 2);
      if (stroke.mode === 'reveal') {
        fogCtx.globalCompositeOperation = 'destination-out';
        fogCtx.fillStyle = 'rgba(0,0,0,1)';
      } else {
        fogCtx.globalCompositeOperation = 'source-over';
        fogCtx.fillStyle = FOG_FILL;
      }
      fogCtx.fill();
      fogCtx.restore();
    },

    drawBrushPreview(imgX: number, imgY: number, radius: number) {
      if (imgW === 0) return;
      previewCtx.clearRect(0, 0, imgW, imgH);
      previewCtx.save();
      previewCtx.strokeStyle = 'rgba(255,255,255,0.7)';
      previewCtx.lineWidth = Math.max(1, 2 * (imgW / (wrapper.clientWidth || imgW)));
      previewCtx.beginPath();
      previewCtx.arc(imgX, imgY, radius, 0, Math.PI * 2);
      previewCtx.stroke();
      previewCtx.restore();
    },

    clearBrushPreview() {
      if (imgW > 0) previewCtx.clearRect(0, 0, imgW, imgH);
    },

    screenToImage(clientX: number, clientY: number) {
      const rect = fogCanvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left) * (imgW / (rect.width || 1)),
        y: (clientY - rect.top) * (imgH / (rect.height || 1)),
      };
    },

    getEventTarget() { return fogCanvas; },

    clear() {
      mapCtx.clearRect(0, 0, imgW, imgH);
      fogCtx.clearRect(0, 0, imgW, imgH);
      previewCtx.clearRect(0, 0, imgW, imgH);
    },
  };
}
