import type { FogMask, FogStroke } from "../types";

export function createMask(width: number, height: number): FogMask {
  return { width, height, data: new Uint8Array(width * height).fill(255) };
}

export function createRevealedMask(width: number, height: number): FogMask {
  return { width, height, data: new Uint8Array(width * height) };
}

export function applyStroke(mask: FogMask, stroke: FogStroke): void {
  const { x, y, radius, mode } = stroke;
  const value = mode === "reveal" ? 0 : 255;
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(x - radius));
  const x1 = Math.min(mask.width - 1, Math.ceil(x + radius));
  const y0 = Math.max(0, Math.floor(y - radius));
  const y1 = Math.min(mask.height - 1, Math.ceil(y + radius));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = px - x;
      const dy = py - y;
      if (dx * dx + dy * dy <= r2) {
        mask.data[py * mask.width + px] = value;
      }
    }
  }
}

export function applyStrokes(mask: FogMask, strokes: FogStroke[]): void {
  for (const stroke of strokes) {
    applyStroke(mask, stroke);
  }
}

export function isRevealed(mask: FogMask, x: number, y: number): boolean {
  if (x < 0 || x >= mask.width || y < 0 || y >= mask.height) return false;
  return mask.data[y * mask.width + x] === 0;
}

export function getRevealedPercentage(mask: FogMask): number {
  let revealed = 0;
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] === 0) revealed++;
  }
  return mask.data.length === 0 ? 0 : revealed / mask.data.length;
}
