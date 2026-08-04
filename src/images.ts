import { readFileSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { getImage, updateImageDimensions } from "./db/images";

/**
 * Image dimensions read straight from the file header, so no image library is
 * needed — see the zero-dependency rule in docs/architecture.md.
 *
 * Lives here rather than in `routes.ts` because the fog layer needs it too, and
 * `fog/` must not import the HTTP layer.
 */
export function parseImageDimensions(buf: Buffer): { width: number; height: number } {
  // PNG: bytes 0-7 = signature, 8-15 = IHDR length+type, 16-19 = width, 20-23 = height
  if (buf.length >= 24 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  }
  // JPEG: scan for SOF0/SOF2 markers (0xFF 0xC0 or 0xFF 0xC2)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xc0 || marker === 0xc2) {
        return {
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
        };
      }
      // Skip to next marker
      const segLen = buf.readUInt16BE(i + 2);
      i += 2 + segLen;
    }
  }
  // WebP: RIFF container with WEBP signature
  if (buf.length >= 20 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    const chunk = buf.slice(12, 16).toString("ascii");
    if (chunk === "VP8X" && buf.length >= 30) {
      // Extended: canvas width-1 at bytes 24-26 (24-bit LE), height-1 at bytes 27-29 (24-bit LE)
      const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
      const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
      return { width: w + 1, height: h + 1 };
    }
    if (chunk === "VP8 " && buf.length >= 30) {
      // Lossy VP8: frame tag (3 bytes) + start code (3 bytes: 0x9D 0x01 0x2A) + width (2 bytes LE) + height (2 bytes LE)
      if (buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
        const w = buf.readUInt16LE(26) & 0x3fff;
        const h = buf.readUInt16LE(28) & 0x3fff;
        return { width: w, height: h };
      }
    }
    if (chunk === "VP8L" && buf.length >= 25) {
      // Lossless: signature byte 0x2F at offset 20, then 4 bytes encoding width-1 (14 bits) and height-1 (14 bits)
      if (buf[20] === 0x2f) {
        const bits = buf[21] | (buf[22] << 8) | (buf[23] << 16) | (buf[24] << 24);
        const w = (bits & 0x3fff) + 1;
        const h = ((bits >> 14) & 0x3fff) + 1;
        return { width: w, height: h };
      }
    }
  }
  return { width: 0, height: 0 };
}

export function repairImageDimensions(db: Database, imageId: string, uploadsDir: string): void {
  const image = getImage(db, imageId);
  if (!image || (image.width > 0 && image.height > 0)) return;
  try {
    const buf = readFileSync(join(uploadsDir, image.filename));
    const { width, height } = parseImageDimensions(buf);
    if (width > 0 && height > 0) {
      updateImageDimensions(db, imageId, width, height);
    }
  } catch {
    // file not found or unreadable, skip
  }
}
