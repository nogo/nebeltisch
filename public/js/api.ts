import type { TokenData } from './tokens';

/**
 * GM calls carry no credential of their own: the browser sends the session cookie with every
 * same-origin request, and the server checks ownership from it (#56).
 *
 * These are **not** imported from `src/types.ts`, unlike the WebSocket contract and `Token`.
 *
 * `Adventure` and `ImageRecord` there are database row types. Importing them here would make every
 * column the contract — a map's `filename` and its `fog_mask` reached players that way until #5 —
 * and `fog_mask: Buffer` does not exist in a browser anyway.
 *
 * So these stay narrower on purpose: they describe what a client is entitled to, not what the
 * table holds, and the server narrows its answers to meet them.
 */
export interface Adventure {
  id: string;
  name: string;
  player_link: string;
  active_image_id: string | null;
}

export interface ImageRecord {
  id: string;
  adventure_id: string;
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

async function checkOk(res: Response): Promise<Response> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res;
}

/** It belongs to whoever is signed in. */
export async function createAdventure(name: string): Promise<Adventure> {
  const res = await fetch('/api/adventures', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return (await checkOk(res)).json();
}

/** One dashboard entry: enough to tell two campaigns apart without opening either. */
export interface AdventureSummary {
  id: string;
  name: string;
  player_link: string;
  created_at: string;
  page_count: number;
  /** The first map's page id, for `imageUrl`; null while there is none. */
  thumbnail_id: string | null;
  /** Every GM, all equal, in the order they joined (#77). */
  gms: Gm[];
}

export interface Gm {
  id: string;
  name: string;
}

export async function listMyAdventures(): Promise<AdventureSummary[]> {
  return (await checkOk(await fetch('/api/adventures'))).json();
}

/** The error the server gave, as a sentence a person can act on. */
async function answer(res: Response): Promise<Response> {
  if (res.ok) return res;
  const data = await res.json().catch(() => ({}));
  throw new Error(data.error ?? `Something went wrong (${res.status})`);
}

function sendJson(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(answer);
}

export async function renameAdventure(adventureId: string, name: string): Promise<void> {
  await sendJson('PATCH', `/api/adventures/${adventureId}`, { name });
}

/** For good: maps, fog, tokens and files (#76). */
export async function deleteAdventure(adventureId: string): Promise<void> {
  await sendJson('DELETE', `/api/adventures/${adventureId}`);
}

export async function shareAdventure(adventureId: string, name: string): Promise<Gm[]> {
  return (await sendJson('POST', `/api/adventures/${adventureId}/gms`, { name })).json();
}

/** Any GM may remove any GM, themselves included — but not the last one. */
export async function removeGm(adventureId: string, userId: string): Promise<Gm[]> {
  return (await sendJson('DELETE', `/api/adventures/${adventureId}/gms/${userId}`)).json();
}

export async function getAdventure(adventureId: string): Promise<Adventure> {
  const res = await fetch(`/api/adventures/${adventureId}`, {
  });
  return (await checkOk(res)).json();
}

export async function uploadImage(adventureId: string, file: File): Promise<ImageRecord> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/adventures/${adventureId}/images`, {
    method: 'POST',
    body: form,
  });
  // The server's sentence, because a refused map is the GM's to fix: convert it, or shrink it.
  return (await answer(res)).json();
}

export async function listImages(adventureId: string): Promise<ImageRecord[]> {
  const res = await fetch(`/api/adventures/${adventureId}/images`, {
  });
  return (await checkOk(res)).json();
}

export async function deleteImage(adventureId: string, imageId: string): Promise<void> {
  const res = await fetch(`/api/adventures/${adventureId}/images/${imageId}`, {
    method: 'DELETE',
  });
  await checkOk(res);
}

export async function getAdventureByPlayerLink(playerLink: string): Promise<{ id: string; name: string; activeImageId: string | null }> {
  const res = await fetch(`/api/adventures/join/${encodeURIComponent(playerLink)}`);
  return (await checkOk(res)).json();
}

/** A page's map, for a GM: the session cookie goes with an `<img>` request by itself (#4). */
export function imageUrl(adventureId: string, imageId: string): string {
  return `/api/adventures/${encodeURIComponent(adventureId)}/images/${encodeURIComponent(imageId)}/file`;
}

/**
 * The presented page's map, for a player, as an object URL to draw from. A player has no session,
 * so the invite link goes in a header — an `<img>` cannot send one, and a link in the address
 * ends up in logs. Revoke the URL once the map is drawn.
 */
export async function loadPlayerImage(adventureId: string, imageId: string, playerLink: string): Promise<string> {
  const res = await fetch(imageUrl(adventureId, imageId), { headers: { 'X-Player-Link': playerLink } });
  return URL.createObjectURL(await (await checkOk(res)).blob());
}

/** Board layout is REST: players never see the board, so none of it belongs on the wire. */
export async function setBoardPosition(adventureId: string,
  imageId: string,
  x: number,
  y: number
): Promise<void> {
  const res = await fetch(`/api/adventures/${adventureId}/images/${imageId}/position`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
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
export async function getImageFog(adventureId: string,
  imageId: string
): Promise<string | null> {
  const res = await fetch(`/api/adventures/${adventureId}/images/${imageId}/fog`, {
  });
  const data = await (await checkOk(res)).json();
  return typeof data.fogMask === 'string' ? data.fogMask : null;
}

/**
 * The monsters and NPCs standing on one page.
 *
 * The WebSocket only ever carries the presented page's GM tokens, and preparing a page the party is
 * not looking at reaches nobody — so this is how the board shows the GM what they already placed
 * there (#51). Player tokens are not included: the party stands on whatever is presented.
 */
export async function getImageGmTokens(adventureId: string,
  imageId: string
): Promise<TokenData[]> {
  const res = await fetch(`/api/adventures/${adventureId}/images/${imageId}/tokens`, {
  });
  return (await checkOk(res)).json();
}

export async function switchActiveImage(adventureId: string, imageId: string): Promise<void> {
  const res = await fetch(`/api/adventures/${adventureId}/active-image`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageId }),
  });
  await checkOk(res);
}
