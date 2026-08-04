import type { FogStroke } from '../../src/types';

/** Re-exported so client modules keep importing it from here. One definition, server-owned. */
export type { FogStroke };

export interface CanvasController {
  loadImage(url: string): Promise<void>;
  applyFogMask(base64: string): Promise<void>;
  applyStroke(stroke: FogStroke): void;
  drawBrushPreview(imgX: number, imgY: number, radius: number, viewportScale?: number): void;
  clearBrushPreview(): void;
  getEventTarget(): HTMLCanvasElement;
  getFogCanvas(): HTMLCanvasElement;
  getWrapper(): HTMLElement;
  getImageSize(): { w: number; h: number };
  clear(): void;
}

async function decompress(data: Uint8Array): Promise<Uint8Array> {
  // Try zlib (deflate with header) first, then raw deflate
  for (const fmt of ['deflate', 'deflate-raw'] as CompressionFormat[]) {
    try {
      const ds = new DecompressionStream(fmt);
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      // Write and close — catch write-side errors to avoid unhandled rejections
      const writePromise = writer.write(data.slice()).then(() => writer.close()).catch(() => {});
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      await writePromise;
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

export function initCanvas(container: HTMLElement, options?: { mode?: 'gm' | 'player' }): CanvasController {
  const isGM = options?.mode !== 'player';
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

  // GM sees fog as semi-transparent; player sees fully opaque.
  // Use CSS opacity so the canvas internally stores full alpha (no stacking issues on re-fog).
  if (isGM) {
    fogCanvas.style.opacity = '0.85';
  }

  if (!isGM) {
    fogCanvas.style.pointerEvents = 'none';
  }

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
    // Set wrapper to image dimensions; viewport CSS transform handles visual scaling.
    wrapper.style.width = `${w}px`;
    wrapper.style.height = `${h}px`;
  }

  function fillFog() {
    fogCtx.save();
    fogCtx.globalCompositeOperation = 'source-over';
    fogCtx.fillStyle = 'rgba(0,0,0,1)';
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
      let w = view.getUint32(0, false);
      let h = view.getUint32(4, false);
      if (w === 0 || h === 0) {
        if (imgW === 0) return; // No image loaded yet
        console.warn('Fog mask has 0x0 dimensions, falling back to loaded image dimensions', imgW, imgH);
        w = imgW;
        h = imgH;
      }
      const pixels = await decompress(bytes.slice(8));
      if (imgW !== w || imgH !== h) sizeAll(w, h);
      const id = fogCtx.createImageData(w, h);
      for (let i = 0; i < pixels.length; i++) {
        const v = pixels[i];
        id.data[i * 4 + 0] = 0;
        id.data[i * 4 + 1] = 0;
        id.data[i * 4 + 2] = 0;
        id.data[i * 4 + 3] = v; // Store full alpha; CSS opacity handles GM transparency
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
      } else {
        fogCtx.globalCompositeOperation = 'source-over';
      }
      fogCtx.fillStyle = 'rgba(0,0,0,1)';
      fogCtx.fill();
      fogCtx.restore();
    },

    drawBrushPreview(imgX: number, imgY: number, radius: number, viewportScale?: number) {
      if (imgW === 0) return;
      previewCtx.clearRect(0, 0, imgW, imgH);
      previewCtx.save();
      previewCtx.strokeStyle = 'rgba(255,255,255,0.7)';
      // Draw at 2px screen width regardless of zoom level
      const invScale = viewportScale && viewportScale > 0 ? 1 / viewportScale : 1;
      previewCtx.lineWidth = Math.max(1, 2 * invScale);
      previewCtx.beginPath();
      previewCtx.arc(imgX, imgY, radius, 0, Math.PI * 2);
      previewCtx.stroke();
      previewCtx.restore();
    },

    clearBrushPreview() {
      if (imgW > 0) previewCtx.clearRect(0, 0, imgW, imgH);
    },

    getEventTarget() { return fogCanvas; },

    getFogCanvas() { return fogCanvas; },

    getWrapper() { return wrapper; },

    getImageSize() { return { w: imgW, h: imgH }; },

    clear() {
      mapCtx.clearRect(0, 0, imgW, imgH);
      fogCtx.clearRect(0, 0, imgW, imgH);
      previewCtx.clearRect(0, 0, imgW, imgH);
    },
  };
}
