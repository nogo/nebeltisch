import * as api from './api';
import { createPasskey, passkeysAvailable, usePasskey } from './passkey';

/**
 * The home page: log in or sign up while signed out, the adventure dashboard once signed in
 * (#54, #55). Three views, one visible at a time, chosen by what `/api/auth/me` says.
 *
 * A passkey is the default; the password sits behind "Use a password instead". Where the browser
 * has no passkeys — or the page is not on HTTPS — the password forms are simply open.
 */

interface PublicUser {
  id: string;
  name: string;
  hasPassword: boolean;
  passkeys: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const views = { signedOut: $('signed-out'), phrase: $('phrase'), dashboard: $('dashboard') };
let user: PublicUser | null = null;

function show(view: keyof typeof views): void {
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
}

/** POST or PUT a JSON body; resolves to the parsed answer, or throws with the server's message. */
async function call<T>(path: string, body: unknown = {}, method = 'POST'): Promise<T> {
  const res = await fetch(`/api/auth/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Something went wrong (${res.status})`);
  return data as T;
}

/**
 * Runs `work` with `errorEl` cleared first and filled on failure. A passkey prompt the person
 * closed is not an error worth a red line.
 */
async function attempt(errorEl: HTMLElement, work: () => Promise<void>): Promise<void> {
  errorEl.textContent = '';
  try {
    await work();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') return;
    errorEl.textContent = err instanceof Error ? err.message : String(err);
  }
}

/** Where every way in ends: the phrase first when there is a new one, then the dashboard. */
function signedIn(answer: { user: PublicUser; recoveryPhrase?: string }): void {
  user = answer.user;
  if (answer.recoveryPhrase) {
    $('phrase-value').textContent = answer.recoveryPhrase;
    show('phrase');
    $('phrase-done').focus();
    return;
  }
  void openDashboard();
}

// ---- Signed out ----

if (!passkeysAvailable()) {
  for (const el of document.querySelectorAll<HTMLElement>('[data-passkey]')) el.hidden = true;
  for (const el of document.querySelectorAll<HTMLDetailsElement>('[data-password-fallback]')) el.open = true;
}

$('login-passkey').addEventListener('click', () =>
  attempt($('login-error'), async () => {
    const options = await call<Parameters<typeof usePasskey>[0] & { challenge: string }>('login/passkey/options');
    const credential = await usePasskey(options);
    signedIn(await call('login/passkey', { challenge: options.challenge, credential }));
  })
);

$('login-password').addEventListener('submit', (e) => {
  e.preventDefault();
  void attempt($('login-error'), async () =>
    signedIn(await call('login/password', {
      name: $<HTMLInputElement>('login-name').value,
      password: $<HTMLInputElement>('login-secret').value,
    }))
  );
});

$('recover').addEventListener('submit', (e) => {
  e.preventDefault();
  void attempt($('login-error'), async () =>
    signedIn(await call('recover', {
      name: $<HTMLInputElement>('recover-name').value,
      phrase: $<HTMLInputElement>('recover-phrase').value,
    }))
  );
});

const signupName = $<HTMLInputElement>('signup-name');

// Submitting the form is the passkey path: Enter in the name field does the default thing.
$('signup').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!passkeysAvailable()) return signUpWithPassword();
  void attempt($('signup-error'), async () => {
    const options = await call<Parameters<typeof createPasskey>[0]>('signup/passkey/options', { name: signupName.value });
    const credential = await createPasskey(options);
    signedIn(await call('signup/passkey', { challenge: options.challenge, credential }));
  });
});

function signUpWithPassword(): void {
  if (!signupName.reportValidity()) return;
  void attempt($('signup-error'), async () =>
    signedIn(await call('signup/password', {
      name: signupName.value,
      password: $<HTMLInputElement>('signup-secret').value,
    }))
  );
}
$('signup-password').addEventListener('click', signUpWithPassword);

$('phrase-done').addEventListener('click', () => {
  $('phrase-value').textContent = '';
  void openDashboard();
});

// ---- Signed in ----

const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

async function openDashboard(): Promise<void> {
  if (!user) return;
  $('user-name').textContent = user.name;
  renderAccount();
  show('dashboard');
  await renderAdventures();
}

async function renderAdventures(): Promise<void> {
  const list = $('adventures');
  const status = $('adventures-status');
  status.textContent = 'Loading…';
  let adventures: api.AdventureSummary[];
  try {
    adventures = await api.listMyAdventures();
  } catch {
    status.textContent = 'Your adventures could not be loaded. Reload the page to try again.';
    return;
  }
  status.textContent = '';
  $('adventures-empty').hidden = adventures.length > 0;
  list.replaceChildren(...adventures.map(adventureEntry));
}

function adventureEntry(adventure: api.AdventureSummary): HTMLLIElement {
  const li = document.createElement('li');

  const open = document.createElement('a');
  open.href = `/gm#id=${encodeURIComponent(adventure.id)}`;
  open.className = 'adventure-name';
  open.textContent = adventure.name;

  const meta = document.createElement('span');
  meta.className = 'adventure-meta';
  const pages = adventure.page_count === 1 ? '1 map' : `${adventure.page_count} maps`;
  // SQLite's datetime('now') is UTC without a zone marker.
  meta.textContent = `${pages} · created ${dateFormat.format(new Date(`${adventure.created_at.replace(' ', 'T')}Z`))}`;

  // The invite link without opening the board, so starting a session is not the price of
  // sending it to a player.
  const invite = document.createElement('button');
  invite.type = 'button';
  invite.className = 'quiet';
  invite.textContent = 'Copy invite link';
  invite.addEventListener('click', async () => {
    const url = `${location.origin}/join/${encodeURIComponent(adventure.player_link)}`;
    try {
      await navigator.clipboard.writeText(url);
      invite.textContent = 'Copied';
    } catch {
      invite.textContent = url;
    }
    setTimeout(() => { invite.textContent = 'Copy invite link'; }, 2000);
  });

  li.append(open, meta, invite);
  return li;
}

$('create-form').addEventListener('submit', (e) => {
  e.preventDefault();
  void attempt($('create-error'), async () => {
    const adventure = await api.createAdventure($<HTMLInputElement>('adv-name').value.trim());
    location.href = `/gm#id=${encodeURIComponent(adventure.id)}`;
  });
});

function renderAccount(): void {
  if (!user) return;
  const ways = [
    ...(user.passkeys === 0 ? [] : [user.passkeys === 1 ? 'your passkey' : `${user.passkeys} passkeys`]),
    ...(user.hasPassword ? ['your password'] : []),
  ];
  $('account-summary').textContent = `You sign in with ${ways.join(' or ')}.`;
  $('password-summary').textContent = user.hasPassword ? 'Change your password' : 'Set a password';
}

$('add-passkey').addEventListener('click', () =>
  attempt($('account-error'), async () => {
    $('account-status').textContent = '';
    const options = await call<Parameters<typeof createPasskey>[0]>('passkeys/options');
    const credential = await createPasskey(options);
    user = (await call<{ user: PublicUser }>('passkeys', { challenge: options.challenge, credential })).user;
    renderAccount();
    $('account-status').textContent = 'Passkey added.';
  })
);

$('set-password').addEventListener('submit', (e) => {
  e.preventDefault();
  void attempt($('account-error'), async () => {
    $('account-status').textContent = '';
    const input = $<HTMLInputElement>('new-secret');
    user = (await call<{ user: PublicUser }>('password', { password: input.value }, 'PUT')).user;
    input.value = '';
    renderAccount();
    $('account-status').textContent = 'Password saved.';
  });
});

$('logout').addEventListener('click', async () => {
  await call('logout').catch(() => {});
  user = null;
  location.replace('/');
});

// ---- Start ----

{
  const res = await fetch('/api/auth/me');
  if (res.ok) {
    user = (await res.json()).user;
    await openDashboard();
  } else {
    show('signedOut');
  }
}
