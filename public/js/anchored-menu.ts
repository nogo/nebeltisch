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
  /** Shown instead of acting on the item; the menu stays open. */
  disabled?: boolean;
  /** Hover text, and the place to say *why* an item is disabled. */
  title?: string;
  onSelect(): void;
}

export interface AnchoredMenu {
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  setItems(items: MenuItem[]): void;
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

  const menu: AnchoredMenu = {
    element,
    get isOpen() { return open; },

    setItems(items) {
      element.textContent = '';
      for (const item of items) {
        const button = document.createElement('button');
        button.textContent = item.label;
        button.className = 'anchored-menu-item';
        if (item.title) button.title = item.title;
        button.disabled = item.disabled === true;
        button.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (item.disabled) return;
          item.onSelect();
        });
        element.appendChild(button);
      }
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
