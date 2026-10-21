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
  li.className = 'adventure';
  const href = `/gm#id=${encodeURIComponent(adventure.id)}`;

  // The first map, so two campaigns are told apart at a glance. Decorative: the name says it all.
  const thumb = document.createElement(adventure.thumbnail ? 'img' : 'span');
  thumb.className = 'adventure-thumb';
  if (thumb instanceof HTMLImageElement) {
    thumb.src = `/uploads/${encodeURIComponent(adventure.thumbnail!)}`;
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.width = 80;
    thumb.height = 60;
  }

  const open = document.createElement('a');
  open.href = href;
  open.className = 'adventure-name';
  open.textContent = adventure.name;

  const meta = document.createElement('span');
  meta.className = 'adventure-meta';
  const pages = adventure.page_count === 1 ? '1 map' : `${adventure.page_count} maps`;
  // SQLite's datetime('now') is UTC without a zone marker.
  const created = dateFormat.format(new Date(`${adventure.created_at.replace(' ', 'T')}Z`));
  const others = adventure.gms.filter((gm) => gm.id !== user?.id).map((gm) => gm.name);
  meta.textContent = [pages, `created ${created}`, ...(others.length ? [`with ${others.join(', ')}`] : [])].join(' · ');

  // The invite link without opening the board, so starting a session is not the price of
  // sending it to a player.
  const invite = quietButton('Copy invite link');
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

  li.append(thumb, open, meta, invite, manageSection(adventure));
  return li;
}

/** The adventure whose Manage panel is open, so a change that redraws the list keeps it open. */
let managing: string | null = null;

/** Rename, share, the GMs and delete — folded away, because they are rare (#76, #77). */
function manageSection(adventure: api.AdventureSummary): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'fallback adventure-manage';
  details.open = managing === adventure.id;
  details.addEventListener('toggle', () => {
    if (details.open) managing = adventure.id;
    else if (managing === adventure.id) managing = null;
  });
  const summary = document.createElement('summary');
  summary.textContent = 'Manage';
  const errorEl = document.createElement('p');
  errorEl.className = 'error';
  errorEl.setAttribute('role', 'alert');

  /** Runs a change, then redraws the list from the server so every entry tells the truth. */
  const change = (work: () => Promise<unknown>) =>
    attempt(errorEl, async () => {
      await work();
      await renderAdventures();
    });

  const rename = inlineForm('Name', adventure.name, 'Rename', (name) => change(() => api.renameAdventure(adventure.id, name)));
  rename.input.maxLength = 80;

  const share = inlineForm('Share with another GM, by account name', '', 'Share', (name) =>
    change(() => api.shareAdventure(adventure.id, name))
  );
  share.input.autocomplete = 'off';

  const gmsTitle = document.createElement('p');
  gmsTitle.className = 'gm-title';
  gmsTitle.textContent = 'GMs, all equal';
  gmsTitle.id = `gms-${adventure.id}`;
  const gms = document.createElement('ul');
  gms.className = 'gm-list';
  gms.setAttribute('aria-labelledby', gmsTitle.id);
  for (const gm of adventure.gms) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = gm.id === user?.id ? `${gm.name} (you)` : gm.name;
    item.append(name);
    // Every GM is equal, so any of them may go — except the last, who deletes it instead.
    if (adventure.gms.length > 1) {
      const remove = quietButton(gm.id === user?.id ? 'Leave' : 'Remove');
      remove.setAttribute('aria-label', gm.id === user?.id ? `Leave ${adventure.name}` : `Remove ${gm.name}`);
      remove.addEventListener('click', () => change(() => api.removeGm(adventure.id, gm.id)));
      item.append(remove);
    }
    gms.append(item);
  }

  const remove = armedButton('Delete adventure', 'Sure? Delete it for good', () =>
    change(() => api.deleteAdventure(adventure.id))
  );
  remove.classList.add('danger');

  details.append(summary, rename.form, share.form, gmsTitle, gms, remove, errorEl);
  return details;
}

function quietButton(text: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'quiet';
  button.textContent = text;
  return button;
}

/** A labelled text field and its button, submitting the trimmed value. */
function inlineForm(label: string, value: string, action: string, onSubmit: (value: string) => void) {
  const form = document.createElement('form');
  form.className = 'inline-form';
  const field = document.createElement('label');
  field.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.required = true;
  input.value = value;
  field.append(input);
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'quiet';
  submit.textContent = action;
  form.append(field, submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    onSubmit(input.value.trim());
  });
  return { form, input };
}

/**
 * Arms on the first click, fires on the second, in place. Disarms on blur, on Escape, and after
 * four seconds — a destructive action never sits armed.
 */
function armedButton(label: string, armedLabel: string, fire: () => void): HTMLButtonElement {
  const button = quietButton(label);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    button.textContent = label;
    button.removeAttribute('data-armed');
  };
  button.addEventListener('click', () => {
    if (!button.hasAttribute('data-armed')) {
      button.setAttribute('data-armed', '');
      button.textContent = armedLabel;
      timer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    fire();
  });
  button.addEventListener('blur', disarm);
  button.addEventListener('keydown', (e) => { if (e.key === 'Escape') disarm(); });
  return button;
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
