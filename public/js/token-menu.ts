import { createAnchoredMenu } from './anchored-menu';
import type { MenuGroup, MenuInput } from './anchored-menu';
import type { TokenController, TokenData } from './tokens';

/**
 * One menu, re-anchored to whichever token is selected.
 *
 * Tokens are many and a menu per token would be a menu per token to keep in sync. It opens on
 * *every* token: what it offers differs — the GM renames and removes monsters, a player declares
 * (#62) — but the hit-test rule is one rule, and both clients have to obey the same one or the
 * tablet lies to whoever is holding it.
 *
 * What belongs here is everything both clients must do identically: which layer holds the token,
 * what a tap on a selected token means, where the strip hangs, and re-anchoring on zoom. What
 * belongs to the caller is the items — `build` is called on every render, so it reads live state
 * rather than a snapshot taken when the menu opened.
 */
export interface TokenMenuOptions {
  /** The transformed wrapper the menu hangs inside, so it moves with the map. */
  parent: HTMLElement;
  /** Every layer that can hold a token. An id lives in exactly one of them. */
  layers: TokenController[];
  /** Token radius in image pixels — the strip clears the circle at every zoom. */
  getRadius(): number;
  getScale(): number;
  /**
   * What this client offers on this token, as one row per thing it has to say. Empty means there
   * is nothing to offer and the menu does not open.
   */
  build(token: TokenData): MenuGroup[];
  /**
   * The selection moved to another token, or to none.
   *
   * Where a caller drops the transient state of the menu it just left: a half-armed Remove does
   * not survive the GM going off to another token. Fires before the new menu is built.
   */
  onSelectionChange?(tokenId: string | null): void;
}

export interface TokenMenu {
  /** The token the menu is open on, or null. */
  readonly selectedId: string | null;
  /** What a tap on a token means: open it, or close it if it is the one already open. */
  toggle(tokenId: string): void;
  select(tokenId: string | null): void;
  /**
   * Rebuild from `build` and re-anchor. Call it when the server echoes a change to the selected
   * token, and from the viewport's change callback — the strip counter-scales, so zooming has to
   * re-apply it. A selection whose token has gone closes instead.
   */
  render(): void;
  /** An edit in place of the button strip, anchored to the same token. */
  showInput(input: MenuInput): void;
}

export function createTokenMenu(options: TokenMenuOptions): TokenMenu {
  const menu = createAnchoredMenu(options.parent, 'token-menu');
  let selectedTokenId: string | null = null;

  /** Whichever layer holds this token. */
  function tokenOf(tokenId: string): TokenData | null {
    for (const layer of options.layers) {
      const token = layer.getToken(tokenId);
      if (token) return token;
    }
    return null;
  }

  /** Above the token, clear of the circle at every zoom. */
  function anchorAtToken(token: TokenData) {
    menu.anchorAt(token.x, token.y - options.getRadius() - 6);
    menu.applyScale(options.getScale());
    menu.open();
  }

  const controller: TokenMenu = {
    get selectedId() { return selectedTokenId; },

    toggle(tokenId) {
      controller.select(selectedTokenId === tokenId ? null : tokenId);
    },

    select(tokenId) {
      if (selectedTokenId === tokenId) return;
      selectedTokenId = tokenId;
      options.onSelectionChange?.(tokenId);
      // The ring is what says which token in a cluster the menu belongs to, and only the layer
      // holding it draws one — the others no-op on a foreign id.
      for (const layer of options.layers) layer.setSelected(tokenId);
      controller.render();
    },

    render() {
      if (selectedTokenId === null) { menu.close(); return; }
      const token = tokenOf(selectedTokenId);
      if (!token) { controller.select(null); return; }
      const groups = options.build(token);
      // A token with nothing to offer is not a menu. It happens where the two clients differ —
      // a player tapping a friend's token — and an empty strip would be worse than no strip.
      if (groups.length === 0) { controller.select(null); return; }
      menu.setGroups(groups);
      anchorAtToken(token);
    },

    showInput(input) {
      if (selectedTokenId === null) return;
      const token = tokenOf(selectedTokenId);
      if (!token) { controller.select(null); return; }
      menu.setInput(input);
      anchorAtToken(token);
    },
  };

  return controller;
}
