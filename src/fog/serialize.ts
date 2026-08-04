import type { Database } from "bun:sqlite";
import type { FogMask } from "../types";
import { getImage, updateFogMask } from "../db/images";

// Format: 4-byte width (uint32 BE) + 4-byte height (uint32 BE) + deflate-compressed pixel data

export async function serializeMask(mask: FogMask): Promise<Buffer> {
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(mask.width, 0);
  header.writeUInt32BE(mask.height, 4);
  const compressed = Bun.deflateSync(mask.data);
  return Buffer.concat([header, Buffer.from(compressed)]);
}

export function deserializeMask(data: Buffer): FogMask {
  if (data.length < 8) throw new Error("Invalid fog mask data: too short");
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  // Copied into a plain Uint8Array: a Buffer subarray is typed over ArrayBufferLike,
  // which Bun.inflateSync does not accept.
  const compressed = new Uint8Array(data.subarray(8));
  const pixels = Bun.inflateSync(compressed);
  if (pixels.length !== width * height) {
    throw new Error(
      `Invalid fog mask data: expected ${width * height} pixels, got ${pixels.length}`
    );
  }
  return { width, height, data: new Uint8Array(pixels) };
}

export async function saveFogMask(
  db: Database,
  imageId: string,
  mask: FogMask
): Promise<void> {
  const buffer = await serializeMask(mask);
  updateFogMask(db, imageId, buffer);
}

export async function loadFogMask(
  db: Database,
  imageId: string
): Promise<FogMask | null> {
  const image = getImage(db, imageId);
  if (!image || !image.fog_mask) return null;
  return deserializeMask(Buffer.from(image.fog_mask));
}
