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
  start_x: number | null;
  start_y: number | null;
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

export async function switchActiveImage(adventureId: string, password: string, imageId: string): Promise<void> {
  const res = await fetch(`/api/adventures/${adventureId}/active-image`, {
    method: 'PUT',
    headers: { ...gmHeaders(password), 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageId }),
  });
  await checkOk(res);
}
