/**
 * These are **not** imported from `src/types.ts`, unlike the WebSocket contract and `Token`.
 *
 * `Adventure` and `ImageRecord` there are database row types. The REST routes happen to return
 * whole rows today, which is the defect in #5 — `fog_mask` and every map's `filename` reach the
 * player. Importing the row types here would make that leak the contract rather than a bug, and
 * `fog_mask: Buffer` does not exist in a browser anyway.
 *
 * So these stay narrower on purpose: they describe what a client is entitled to, not what the
 * table holds. When #5 is fixed, the server response should narrow to meet them.
 */
export interface Adventure {
  id: string;
  name: string;
  player_link: string;
  active_image_id: string | null;
  gm_password: string;
}

export interface ImageRecord {
  id: string;
  adventure_id: string;
  filename: string;
  original_name: string;
  width: number;
  height: number;
  sort_order: number;
  /** Null means "never moved", not "none" — the map centre is where the party lands either way. */
  start_x: number | null;
  start_y: number | null;
  start_locked: number;
  /** Where the page sits on the board. Null only for a row the migration has not reached yet. */
  board_x: number | null;
  board_y: number | null;
}

function gmHeaders(password: string): HeadersInit {
  return { 'X-GM-Password': password };
}

async function checkOk(res: Response): Promise<Response> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res;
}

export async function createAdventure(name: string, password: string): Promise<Adventure> {
  const res = await fetch('/api/adventures', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, gmPassword: password }),
  });
  return (await checkOk(res)).json();
}

export async function getAdventure(adventureId: string, password: string): Promise<Adventure> {
  const res = await fetch(`/api/adventures/${adventureId}`, {
    headers: gmHeaders(password),
  });
  return (await checkOk(res)).json();
}

export async function uploadImage(adventureId: string, password: string, file: File): Promise<ImageRecord> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/adventures/${adventureId}/images`, {
    method: 'POST',
    headers: gmHeaders(password),
    body: form,
  });
  return (await checkOk(res)).json();
}

export async function listImages(adventureId: string, password: string): Promise<ImageRecord[]> {
  const res = await fetch(`/api/adventures/${adventureId}/images`, {
    headers: gmHeaders(password),
  });
  return (await checkOk(res)).json();
}

export async function deleteImage(adventureId: string, password: string, imageId: string): Promise<void> {
  const res = await fetch(`/api/adventures/${adventureId}/images/${imageId}`, {
    method: 'DELETE',
    headers: gmHeaders(password),
  });
  await checkOk(res);
}

export async function getAdventureByPlayerLink(playerLink: string): Promise<{ id: string; name: string; activeImageId: string | null }> {
  const res = await fetch(`/api/adventures/join/${encodeURIComponent(playerLink)}`);
  return (await checkOk(res)).json();
}

export async function listImagesAsPlayer(adventureId: string, playerLink: string): Promise<ImageRecord[]> {
  const res = await fetch(`/api/adventures/${adventureId}/images`, {
    headers: { 'X-Player-Link': playerLink },
  });
  return (await checkOk(res)).json();
}

/** Board layout is REST: players never see the board, so none of it belongs on the wire. */
export async function setBoardPosition(
  adventureId: string,
  password: string,
  imageId: string,
  x: number,
  y: number
): Promise<void> {
  const res = await fetch(`/api/adventures/${adventureId}/images/${imageId}/position`, {
    method: 'PUT',
    headers: { ...gmHeaders(password), 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y }),
  });
  await checkOk(res);
}

/**
 * The stored fog of any page, in the same encoding `map:switched` carries.
 *
 * Needed because the WebSocket only ever sends the presented page's mask, and the board has to show
 * a page's fog as it is stored once the GM zooms into it.
 */
export async function getImageFog(
  adventureId: string,
  password: string,
  imageId: string
): Promise<string | null> {
  const res = await fetch(`/api/adventures/${adventureId}/images/${imageId}/fog`, {
    headers: gmHeaders(password),
  });
  const data = await (await checkOk(res)).json();
  return typeof data.fogMask === 'string' ? data.fogMask : null;
}

export async function switchActiveImage(adventureId: string, password: string, imageId: string): Promise<void> {
  const res = await fetch(`/api/adventures/${adventureId}/active-image`, {
    method: 'PUT',
    headers: { ...gmHeaders(password), 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageId }),
  });
  await checkOk(res);
}
