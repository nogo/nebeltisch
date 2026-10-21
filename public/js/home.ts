import * as api from './api';
import { createPasskey, passkeysAvailable, usePasskey } from './passkey';

/**
 * The home page: log in or sign up while signed out; once signed in, the adventure dashboard at
 * `/` and the account page at `/account` (#54, #55). Four views, one visible at a time, chosen by
 * what `/api/auth/me` says and then by the address.
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

const views = { signedOut: $('signed-out'), phrase: $('phrase'), dashboard: $('dashboard'), account: $('account') };
let user: PublicUser | null = null;

function show(view: keyof typeof views): void {
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
  const signedIn = view === 'dashboard' || view === 'account';
  $('intro').hidden = signedIn; // both carry their own header
  // The shelf takes the screen's width; every other view is one narrow column.
  document.querySelector('main')!.classList.toggle('wide', view === 'dashboard');
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

/** Where every way in ends: the phrase first when there is a new one, then the page asked for. */
function signedIn(answer: { user: PublicUser; recoveryPhrase?: string }): void {
  user = answer.user;
  if (answer.recoveryPhrase) {
    $('phrase-value').textContent = answer.recoveryPhrase;
    show('phrase');
    $('phrase-done').focus();
    return;
  }
  void openSignedIn();
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
  void openSignedIn();
});

// ---- Signed in ----

const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** The account at `/account`, the dashboard anywhere else. */
async function openSignedIn(): Promise<void> {
  if (!user) return;
  if (location.pathname === '/account') {
    renderAccount();
    show('account');
    return;
  }
  $('account-name').textContent = user.name;
  show('dashboard');
  await renderAdventures();
}

/** The list as last drawn, so the GMs popover can redraw from it after a change. */
let adventures: api.AdventureSummary[] = [];

async function renderAdventures(): Promise<void> {
  const list = $('adventures');
  const status = $('adventures-status');
  status.textContent = 'Loading…';
  try {
    adventures = await api.listMyAdventures();
  } catch {
    status.textContent = 'Your adventures could not be loaded. Reload the page to try again.';
    return;
  }
  status.textContent = '';
  $('adventures-empty').hidden = adventures.length > 0;
  // With nothing on the shelf, starting one is the only thing to do.
  if (adventures.length === 0) openCreateForm();
  list.replaceChildren(...adventures.map(adventureCard));
  refreshGms();
}

/**
 * One adventure on the shelf. The whole card opens the board; every other act is an icon in the
 * row at its foot, in a fixed order: invite, rename, GMs, delete.
 */
function adventureCard(adventure: api.AdventureSummary): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'adventure-card';

  // The first map is the card's face, so two campaigns are told apart before their names are
  // read. Decorative: the name says it all.
  const face = document.createElement(adventure.thumbnail_id ? 'img' : 'span');
  face.className = 'adventure-face';
  if (face instanceof HTMLImageElement) {
    face.src = api.imageUrl(adventure.id, adventure.thumbnail_id!);
    face.alt = '';
    face.loading = 'lazy';
    face.width = 320;
    face.height = 200;
  }

  const open = document.createElement('a');
  open.href = `/gm#id=${encodeURIComponent(adventure.id)}`;
  open.className = 'adventure-name';
  open.textContent = adventure.name;

  const meta = document.createElement('p');
  meta.className = 'adventure-meta';
  const pages = adventure.page_count === 0 ? 'No maps yet' : adventure.page_count === 1 ? '1 map' : `${adventure.page_count} maps`;
  // SQLite's datetime('now') is UTC without a zone marker.
  const created = dateFormat.format(new Date(`${adventure.created_at.replace(' ', 'T')}Z`));
  const others = adventure.gms.filter((gm) => gm.id !== user?.id).map((gm) => gm.name);
  meta.textContent = [pages, created, ...(others.length ? [`with ${others.join(', ')}`] : [])].join(' · ');

  const errorEl = document.createElement('p');
  errorEl.className = 'error';
  errorEl.setAttribute('role', 'alert');

  const text = document.createElement('div');
  text.className = 'adventure-text';
  text.append(open, meta, errorEl);

  const actions = document.createElement('div');
  actions.className = 'adventure-actions';
  actions.append(
    inviteButton(adventure, text),
    renameButton(adventure, open, errorEl),
    gmsButton(adventure),
    deleteButton(adventure, errorEl),
  );

  li.append(face, text, actions);
  return li;
}

const icons = {
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  gms: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M19 8v6M16 11h6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
};

function icon(name: keyof typeof icons): string {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${icons[name]}</svg>`;
}

/** A button that shows only an icon; `label` is its name for a screen reader and its tooltip. */
function iconButton(name: keyof typeof icons, label: string, type: 'button' | 'submit' = 'button'): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = type;
  button.className = 'icon-button';
  button.innerHTML = icon(name);
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
}

/**
 * The invite link without opening the board, so starting a session is not the price of sending it.
 * Where the clipboard fails, the link appears in the card, selected, to copy by hand.
 */
function inviteButton(adventure: api.AdventureSummary, card: HTMLElement): HTMLButtonElement {
  const label = `Copy invite link for ${adventure.name}`;
  const button = iconButton('link', label);
  button.addEventListener('click', async () => {
    const url = `${location.origin}/join/${encodeURIComponent(adventure.player_link)}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // No clipboard on an insecure origin, or the browser said no.
      showLink(card, adventure, url);
      return;
    }
    button.innerHTML = icon('check');
    button.setAttribute('aria-label', 'Copied');
    setTimeout(() => {
      button.innerHTML = icon('link');
      button.setAttribute('aria-label', label);
    }, 2000);
  });
  return button;
}

/** The link as a read-only field in the card. It stays until the shelf is drawn again. */
function showLink(card: HTMLElement, adventure: api.AdventureSummary, url: string): void {
  let field = card.querySelector<HTMLInputElement>('.adventure-invite');
  if (!field) {
    field = document.createElement('input');
    field.type = 'text';
    field.readOnly = true;
    field.className = 'adventure-invite';
    field.value = url;
    field.setAttribute('aria-label', `Invite link for ${adventure.name}`);
    field.addEventListener('focus', () => field!.select());
    card.append(field);
  }
  field.focus();
  field.select();
}

/** Runs a change, then redraws the shelf from the server so every card tells the truth. */
function change(errorEl: HTMLElement, work: () => Promise<unknown>): Promise<void> {
  return attempt(errorEl, async () => {
    await work();
    await renderAdventures();
  });
}

/** The name turns into a field in place. Enter or ✓ keeps it; Escape or leaving the field drops it. */
function renameButton(adventure: api.AdventureSummary, name: HTMLAnchorElement, errorEl: HTMLElement): HTMLButtonElement {
  const button = iconButton('edit', `Rename ${adventure.name}`);
  button.addEventListener('click', () => {
    if (!name.isConnected) return;
    const form = document.createElement('form');
    form.className = 'adventure-rename';
    const input = document.createElement('input');
    input.type = 'text';
    input.required = true;
    input.maxLength = 80;
    input.value = adventure.name;
    input.setAttribute('aria-label', `New name for ${adventure.name}`);
    const save = iconButton('check', 'Save name', 'submit');
    // Keeps the focus in the field when ✓ is tapped, so leaving the field does not cancel first.
    save.addEventListener('pointerdown', (e) => e.preventDefault());
    form.append(input, save);

    const cancel = () => {
      if (form.isConnected) form.replaceWith(name);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = input.value.trim();
      if (value === adventure.name) return cancel();
      void change(errorEl, () => api.renameAdventure(adventure.id, value));
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') cancel();
    });
    form.addEventListener('focusout', (e) => {
      if (!form.contains(e.relatedTarget as Node | null)) cancel();
    });

    name.replaceWith(form);
    input.focus();
    input.select();
  });
  return button;
}

// ---- The GMs popover: one element, hung off the icon of whichever card opened it (#77) ----

const gmsPopover = document.createElement('div');
gmsPopover.className = 'gms-popover';
gmsPopover.popover = 'auto';
document.body.append(gmsPopover);
/** The adventure the popover is about, so a redraw of the shelf can redraw it too. */
let gmsFor: string | null = null;
gmsPopover.addEventListener('toggle', (e) => {
  if ((e as ToggleEvent).newState === 'closed') gmsFor = null;
});

function gmsButton(adventure: api.AdventureSummary): HTMLButtonElement {
  const button = iconButton('gms', `GMs of ${adventure.name}`);
  button.dataset.gms = adventure.id;
  // More than one GM is worth seeing from the shelf; one is the usual case and says nothing.
  if (adventure.gms.length > 1) {
    const count = document.createElement('span');
    count.className = 'gms-count';
    count.textContent = String(adventure.gms.length);
    button.append(count);
  }
  button.addEventListener('click', () => {
    if (gmsFor === adventure.id) return gmsPopover.hidePopover();
    gmsFor = adventure.id;
    fillGms(adventure);
    gmsPopover.showPopover();
    placeGms();
    gmsPopover.querySelector('input')?.focus();
  });
  return button;
}

function fillGms(adventure: api.AdventureSummary): void {
  const title = document.createElement('h3');
  title.textContent = `GMs of ${adventure.name}`;
  const note = document.createElement('p');
  note.className = 'gm-title';
  note.textContent = 'All equal';

  const errorEl = document.createElement('p');
  errorEl.className = 'error';
  errorEl.setAttribute('role', 'alert');

  const gms = document.createElement('ul');
  gms.className = 'gm-list';
  for (const gm of adventure.gms) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = gm.id === user?.id ? `${gm.name} (you)` : gm.name;
    item.append(name);
    // Every GM is equal, so any of them may go — except the last, who deletes it instead.
    if (adventure.gms.length > 1) {
      const remove = quietButton(gm.id === user?.id ? 'Leave' : 'Remove');
      remove.setAttribute('aria-label', gm.id === user?.id ? `Leave ${adventure.name}` : `Remove ${gm.name}`);
      remove.addEventListener('click', () => change(errorEl, () => api.removeGm(adventure.id, gm.id)));
      item.append(remove);
    }
    gms.append(item);
  }

  const share = inlineForm('Share with another GM, by account name', '', 'Share', (name) =>
    change(errorEl, () => api.shareAdventure(adventure.id, name))
  );
  share.input.autocomplete = 'off';

  gmsPopover.replaceChildren(title, note, gms, share.form, errorEl);
}

/** After a redraw: the popover follows its adventure's new card, or closes if the card is gone. */
function refreshGms(): void {
  if (!gmsFor) return;
  const adventure = adventures.find((a) => a.id === gmsFor);
  if (!adventure) return gmsPopover.hidePopover();
  fillGms(adventure);
  placeGms();
}

/** Under its icon, right edges aligned, flipped above when there is no room below. */
function placeGms(): void {
  const trigger = gmsFor && document.querySelector<HTMLElement>(`[data-gms="${CSS.escape(gmsFor)}"]`);
  if (!trigger) return;
  const r = trigger.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = gmsPopover;
  const left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8));
  const below = r.bottom + 6;
  const top = below + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : below;
  gmsPopover.style.left = `${left}px`;
  gmsPopover.style.top = `${top}px`;
}
addEventListener('scroll', placeGms, { passive: true });
addEventListener('resize', placeGms);

function deleteButton(adventure: api.AdventureSummary, errorEl: HTMLElement): HTMLButtonElement {
  const button = iconButton('trash', `Delete ${adventure.name}`);
  button.classList.add('danger');
  armed(button, 'Delete?', `Delete ${adventure.name} for good`, () =>
    change(errorEl, () => api.deleteAdventure(adventure.id))
  );
  return button;
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
 * Arms on the first click, fires on the second, in place: the icon gains the word `armedText`.
 * Disarms on blur, on Escape, and after four seconds — a destructive action never sits armed.
 */
function armed(button: HTMLButtonElement, armedText: string, armedLabel: string, fire: () => void): void {
  const idle = { html: button.innerHTML, label: button.getAttribute('aria-label') ?? '' };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    button.innerHTML = idle.html;
    button.setAttribute('aria-label', idle.label);
    button.removeAttribute('data-armed');
  };
  button.addEventListener('click', () => {
    if (!button.hasAttribute('data-armed')) {
      button.setAttribute('data-armed', '');
      button.innerHTML = `${idle.html}<span>${armedText}</span>`;
      button.setAttribute('aria-label', armedLabel);
      timer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    fire();
  });
  button.addEventListener('blur', disarm);
  button.addEventListener('keydown', (e) => { if (e.key === 'Escape') disarm(); });
}

function openCreateForm(): void {
  $('create-form').hidden = false;
  $('new-adventure').setAttribute('aria-expanded', 'true');
}

$('new-adventure').addEventListener('click', () => {
  const form = $('create-form');
  if (!form.hidden && adventures.length > 0) {
    form.hidden = true;
    $('new-adventure').setAttribute('aria-expanded', 'false');
    return;
  }
  openCreateForm();
  $('adv-name').focus();
});

$('create-form').addEventListener('submit', (e) => {
  e.preventDefault();
  void attempt($('create-error'), async () => {
    const adventure = await api.createAdventure($<HTMLInputElement>('adv-name').value.trim());
    location.href = `/gm#id=${encodeURIComponent(adventure.id)}`;
  });
});

function renderAccount(): void {
  if (!user) return;
  $('user-name').textContent = user.name;
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
    await openSignedIn();
  } else {
    show('signedOut');
  }
}
