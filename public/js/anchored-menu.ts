/**
 * A small menu anchored to a point inside the transformed world — beside a page on the board, or
 * beside the start marker on a page.
 *
 * It exists because three things about such a menu are non-obvious and each has already cost
 * something:
 *
 * 1. **The viewport must be told to leave it alone.** `viewport.ts` listens for pointer events in
 *    the capture phase and would swallow a button's sequence before it could become a click. The
 *    opt-out is `data-viewport-control`, and the start marker's Lock/Unlock shipped without it and
 *    silently did nothing (`46c26e3`).
 * 2. **It counter-scales.** Drawn in world units it would shrink to nothing when zoomed out and
 *    swallow the screen when zoomed in. One size on screen, at every zoom.
 * 3. **Dismissal is one thing.** `closeAllMenus` is the single path, so a caller adding a menu does
 *    not also have to remember every other menu's way of closing.
 *
 * Opening a menu deliberately does *not* close the others. The page menu is persistent chrome for
 * whatever is selected, not a popup; if opening closed its siblings, any redraw — a websocket
 * message arriving, say — would silently steal the start marker's menu away mid-use.
 */

export interface MenuItem {
  label: string;
  /** Drawn instead of the label; `label` stays as the item's accessible name. */
  icon?: HTMLTemplateElement;
  /** Shown instead of acting on the item; the menu stays open. */
  disabled?: boolean;
  /** Hover text, and the place to say *why* an item is disabled. */
  title?: string;
  /** A destructive item waiting for its second press. */
  armed?: boolean;
  /** A lit toggle: this item's state is the one in force. Marked rather than hidden, so a tablet
   *  with no hover can still see what the set offers. Reaches the DOM as `aria-pressed` too. */
  current?: boolean;
  onSelect(): void;
}

/**
 * What the menu is acting on — which token, when several overlap and their canvas labels do too.
 *
 * With `onSelect` the name is the control that edits it, so renaming is reached by tapping the
 * thing being renamed rather than through an item of its own. `icon` is the affordance that says
 * so: on a tablet there is no hover to discover it with.
 */
export interface MenuLabel {
  text: string;
  /** A colour dot before the text — whose attack this row is about (#73). */
  swatch?: string;
  icon?: HTMLTemplateElement;
  title?: string;
  onSelect?(): void;
}

/**
 * An edit in place of the button strip — renaming a token, and the damage number after it.
 *
 * It lives here rather than in a form of its own because the field has to appear where the menu
 * that opened it is: anchored to the same token, at the same counter-scale, already inside the
 * viewport opt-out. A screen-fixed form would put the field somewhere the GM was not looking.
 */
export interface MenuInput {
  value: string;
  placeholder?: string;
  maxLength?: number;
  /** A number field: the tablet offers a keypad instead of the whole keyboard (#73). */
  inputMode?: 'numeric';
  /** Enter, or the confirm button. Never called with an empty value. */
  onCommit(value: string): void;
  /** Escape. The caller decides what the menu shows next. */
  onCancel(): void;
}

/**
 * One line of the menu. A menu is usually one of these and looks exactly as it always has; a second
 * appears when the token carries an exchange that wants an answer (#73).
 *
 * Rows rather than a longer strip because the two lines say different things: what this token is
 * and what may be done to it, and then the one attack that is waiting on you.
 */
export interface MenuGroup {
  label?: MenuLabel;
  items: MenuItem[];
}

export interface AnchoredMenu {
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  setItems(items: MenuItem[], label?: MenuLabel): void;
  /** The same, in as many rows as the caller has things to say. */
  setGroups(groups: MenuGroup[]): void;
  setInput(input: MenuInput): void;
  /** World coordinates of the point the menu hangs above. */
  anchorAt(x: number, y: number): void;
  open(): void;
  close(): void;
  /** Re-applies the counter-scale. Call from the viewport's change callback. */
  applyScale(scale: number): void;
}

/** Every menu ever created, so opening one can close the others. */
const all = new Set<AnchoredMenu>();

/** Closes every open anchored menu. The caller's own dismissal paths route through this. */
export function closeAllMenus(except?: AnchoredMenu): void {
  for (const menu of all) if (menu !== except) menu.close();
}

export function createAnchoredMenu(parent: HTMLElement, className: string): AnchoredMenu {
  const element = document.createElement('div');
  element.className = `anchored-menu ${className}`;
  element.dataset.viewportControl = '';
  element.hidden = true;
  parent.appendChild(element);

  let x = 0;
  let y = 0;
  let scale = 1;
  let open = false;

  function position() {
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
    // Anchored by its bottom centre, so it sits above the point and grows upward.
    element.style.transform = `translate(-50%, -100%) scale(${1 / (scale || 1)})`;
  }

  function buildRow(group: MenuGroup): HTMLElement {
    const row = document.createElement('div');
    row.className = 'anchored-menu-row';
    const label = group.label;
    if (label !== undefined) {
      const name = document.createElement(label.onSelect ? 'button' : 'span');
      name.className = 'anchored-menu-label';
      if (label.title) name.title = label.title;
      if (label.swatch) {
        // The attacker's colour, the same one their pip is drawn in: on a monster with three
        // attacks on it, the name and the pip have to be the same person at a glance.
        const dot = document.createElement('span');
        dot.className = 'anchored-menu-swatch';
        dot.style.background = label.swatch;
        name.appendChild(dot);
      }
      const text = document.createElement('span');
      text.textContent = label.text;
      name.appendChild(text);
      if (label.icon) name.appendChild(label.icon.content.cloneNode(true));
      if (label.onSelect) {
        name.classList.add('editable');
        name.addEventListener('click', (ev) => {
          ev.stopPropagation();
          label.onSelect!();
        });
      }
      row.appendChild(name);
    }

    for (const item of group.items) {
      const button = document.createElement('button');
      button.className = 'anchored-menu-item';
      if (item.icon) {
        button.appendChild(item.icon.content.cloneNode(true));
        button.setAttribute('aria-label', item.label);
      } else {
        button.textContent = item.label;
      }
      if (item.title) button.title = item.title;
      button.classList.toggle('armed', item.armed === true);
      button.classList.toggle('current', item.current === true);
      if (item.current !== undefined) button.setAttribute('aria-pressed', String(item.current));
      button.disabled = item.disabled === true;
      button.addEventListener('click', (ev) => {
        // Anything else the GM does disarms a waiting item, and this press is not that: without
        // stopping it, the dismissal path would read it as such and undo the arming it caused.
        ev.stopPropagation();
        if (item.disabled) return;
        item.onSelect();
      });
      row.appendChild(button);
    }
    return row;
  }

  const menu: AnchoredMenu = {
    element,
    get isOpen() { return open; },

    setItems(items, label) {
      menu.setGroups([{ items, label }]);
    },

    setGroups(groups) {
      element.textContent = '';
      for (const group of groups) menu.element.appendChild(buildRow(group));
    },
    setInput(input) {
      element.textContent = '';
      const field = document.createElement('input');
      field.type = 'text';
      field.className = 'anchored-menu-input';
      field.value = input.value;
      field.autocomplete = 'off';
      if (input.placeholder) field.placeholder = input.placeholder;
      if (input.maxLength) field.maxLength = input.maxLength;
      // Text, not `type=number`: the spinners are a mouse control and the field is a tablet's.
      if (input.inputMode) field.inputMode = input.inputMode;

      const commit = () => {
        const value = field.value.trim();
        if (value === '') { input.onCancel(); return; }
        input.onCommit(value);
      };

      field.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); input.onCancel(); }
      });

      const confirm = document.createElement('button');
      confirm.textContent = 'Save';
      confirm.className = 'anchored-menu-item';
      confirm.addEventListener('click', (ev) => { ev.stopPropagation(); commit(); });

      element.append(field, confirm);
      // Selected rather than merely focused: renaming replaces a name far more often than it
      // edits one, and on a tablet the keyboard is the expensive part either way.
      field.focus();
      field.select();
    },

    anchorAt(nextX, nextY) {
      x = nextX;
      y = nextY;
      position();
    },

    open() {
      open = true;
      element.hidden = false;
      position();
    },

    close() {
      if (!open) return;
      open = false;
      element.hidden = true;
    },

    applyScale(next) {
      scale = next > 0 ? next : 1;
      position();
    },
  };

  all.add(menu);
  return menu;
}
