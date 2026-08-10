/**
 * The fog on the waiting screen.
 *
 * Nebeltisch is a table where the map shows only what the party has seen, so the screen a player
 * sits on before anything is presented is not an empty state to be dressed up — it is the premise,
 * drawn honestly. Nothing has been revealed yet, so there is fog.
 *
 * **How it stays cheap without looking cheap.** The expensive part of convincing fog is the noise;
 * the cheap part is moving it. So the noise is fractal value noise baked *once* into a seamless
 * tile, and every frame is three tiled fills of that one texture at different scales, speeds and
 * opacities. Nothing is computed per pixel per frame. Layers whose periods do not divide each other
 * never visibly repeat, which is what separates this from two divs sliding past one another.
 */

/** Baked once. Large enough that the lattice does not read as a grid, small enough to be instant. */
const TEXTURE_SIZE = 256;
/** Cells across the texture in the first octave. The tile wraps on this, which is what makes it seamless. */
const BASE_LATTICE = 4;
const OCTAVES = 5;

/**
 * Fog is all soft gradients, so rendering it at device resolution buys nothing a viewer can see and
 * costs four times the fill on a retina tablet — the device this screen actually runs on.
 */
const MAX_PIXEL_RATIO = 1;
/** Fog this slow has nothing to say at 60fps, and halving the frames halves the work. */
const TARGET_FPS = 30;

interface Layer {
  /** Texture repeats across the canvas width. Lower is a bigger, softer bank. */
  scale: number;
  /** Screen pixels per second. */
  vx: number;
  vy: number;
  alpha: number;
}

/**
 * Three layers reading as depth: one vast and slow behind, one mid, one small and quick in front.
 * The speeds are deliberately not multiples of each other.
 */
const LAYERS: Layer[] = [
  { scale: 0.9, vx: 5.5, vy: -1.7, alpha: 0.34 },
  { scale: 1.7, vx: -8.3, vy: 2.6, alpha: 0.22 },
  { scale: 3.1, vx: 13.1, vy: -3.9, alpha: 0.13 },
];

/** The fog's own colour. The depth comes from the background beneath it, not from tinting layers. */
const FOG_RGB = '168, 176, 208';

export interface Veil {
  /** Idempotent: starting a running veil does nothing. */
  start(): void;
  /** Releases the frame loop and its listeners. Safe to call when already stopped. */
  stop(): void;
}

/** Deterministic, so the fog is the same shape on every device and in every test run. */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Value noise on a wrapping lattice. Sampling modulo the lattice size is the whole trick behind a
 * seamless tile: the right edge reads the same cells as the left.
 */
function sampleLattice(lattice: Float32Array, n: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = smoothstep(x - xi);
  const ty = smoothstep(y - yi);
  const x0 = ((xi % n) + n) % n;
  const y0 = ((yi % n) + n) % n;
  const x1 = (x0 + 1) % n;
  const y1 = (y0 + 1) % n;
  const top = lattice[y0 * n + x0] * (1 - tx) + lattice[y0 * n + x1] * tx;
  const bottom = lattice[y1 * n + x0] * (1 - tx) + lattice[y1 * n + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * One seamless tile of fractal noise, written straight into the alpha channel. The colour is
 * constant; only opacity varies, which is what fog is.
 */
function bakeFogTile(): HTMLCanvasElement {
  const random = makeRandom(0x6e626c74);
  const lattices: Array<{ n: number; data: Float32Array }> = [];
  for (let o = 0; o < OCTAVES; o++) {
    const n = BASE_LATTICE * 2 ** o;
    const data = new Float32Array(n * n);
    for (let i = 0; i < data.length; i++) data[i] = random();
    lattices.push({ n, data });
  }

  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  const data = image.data;

  let amplitudeTotal = 0;
  for (let o = 0; o < OCTAVES; o++) amplitudeTotal += 0.5 ** o;

  const [r, g, b] = FOG_RGB.split(',').map((n) => parseInt(n, 10));

  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      let value = 0;
      for (let o = 0; o < OCTAVES; o++) {
        const { n, data: lattice } = lattices[o];
        value += sampleLattice(lattice, n, (x / TEXTURE_SIZE) * n, (y / TEXTURE_SIZE) * n) * 0.5 ** o;
      }
      value /= amplitudeTotal;
      // Bias towards thin: fog that is dense everywhere is a grey rectangle. The curve keeps the
      // banks sparse and the gaps genuinely clear, which is where the depth comes from.
      const alpha = smoothstep(Math.max(0, Math.min(1, (value - 0.42) / 0.46))) ** 1.6;
      const i = (y * TEXTURE_SIZE + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = Math.round(alpha * 255);
    }
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Baked lazily and shared: one texture serves every layer and every veil on the page. */
let fogTile: HTMLCanvasElement | null = null;

export function initVeil(canvas: HTMLCanvasElement, getClearCentre: () => { x: number; y: number }): Veil {
  const ctx = canvas.getContext('2d')!;
  let pattern: CanvasPattern | null = null;
  let frame: number | null = null;
  let last = 0;
  let elapsed = 0;
  let width = 0;
  let height = 0;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    width = Math.max(1, Math.round(w * ratio));
    height = Math.max(1, Math.round(h * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function draw(seconds: number) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!pattern) return;

    for (const layer of LAYERS) {
      // One tiled fill per layer. The pattern is scaled and offset by the transform, so the whole
      // layer costs a single fillRect however large the screen is.
      const size = (width / layer.scale) / TEXTURE_SIZE;
      const offsetX = (layer.vx * seconds) % TEXTURE_SIZE;
      const offsetY = (layer.vy * seconds) % TEXTURE_SIZE;
      ctx.save();
      ctx.globalAlpha = layer.alpha;
      ctx.setTransform(size, 0, 0, size, offsetX * size, offsetY * size);
      ctx.fillStyle = pattern;
      // Two tiles of slack in every direction so the drifting offset never exposes an edge.
      ctx.fillRect(
        -TEXTURE_SIZE * 2,
        -TEXTURE_SIZE * 2,
        width / size + TEXTURE_SIZE * 4,
        height / size + TEXTURE_SIZE * 4
      );
      ctx.restore();
    }

    // The title sits in a clearing, the shape the GM's brush makes. It is the one place the fog is
    // gone, which is exactly what the whole application is about — and it needs no interaction to
    // say so. It breathes slightly, so the screen is never completely still.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const centre = getClearCentre();
    const breath = 1 + Math.sin(seconds * 0.35) * 0.04;
    const radius = Math.min(width, height) * 0.34 * breath;
    const clearing = ctx.createRadialGradient(centre.x, centre.y, 0, centre.x, centre.y, radius);
    clearing.addColorStop(0, 'rgba(0,0,0,1)');
    clearing.addColorStop(0.55, 'rgba(0,0,0,0.85)');
    clearing.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = clearing;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
  }

  function tick(now: number) {
    frame = requestAnimationFrame(tick);
    const delta = now - last;
    if (delta < 1000 / TARGET_FPS) return;
    last = now;
    elapsed += delta / 1000;
    draw(elapsed);
  }

  function stop() {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
  }

  function onResize() {
    resize();
    draw(elapsed);
  }

  /**
   * Players sit in a voice call and switch apps constantly. Browsers throttle background frames
   * rather than stopping them, so a veil nobody is looking at would still be costing a tablet
   * battery — this drops it entirely and picks the drift back up where it left off.
   */
  function onVisibility() {
    if (document.hidden) {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    } else if (frame === null) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
  }

  return {
    start() {
      if (frame !== null) return;
      if (!fogTile) fogTile = bakeFogTile();
      pattern = ctx.createPattern(fogTile, 'repeat');
      resize();
      window.addEventListener('resize', onResize);
      document.addEventListener('visibilitychange', onVisibility);
      // Motion here is atmosphere, never information, so removing it costs nothing but the mood.
      if (reduceMotion.matches) {
        draw(0);
        return;
      }
      last = performance.now();
      frame = requestAnimationFrame(tick);
    },
    stop,
  };
}
