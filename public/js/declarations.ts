import type { Declaration } from '../../src/types';
import type { TokenController, TokenPip } from './tokens';

/**
 * What the table has said out loud, held for one page and drawn on the tokens it points at.
 *
 * Shared by both clients because a declaration means the same thing on either screen: the server
 * decides who may make one, and the two clients differ only in which tokens they offer it on.
 *
 * The list is the presented page's, whole. It is replaced on joining and on every page switch, and
 * nudged by `declaration:opened`, `declaration:updated` and `declaration:retracted` in between — a
 * client never writes one for itself, so a pip on screen is always one the server wrote down
 * (principle 2).
 */
export interface Declarations {
  /** The whole of a page, from `joined` or `map:switched`. */
  replace(list: Declaration[]): void;
  add(declaration: Declaration): void;
  /**
   * The same declaration, further on: answered, or carrying its number. Replaced where it stands,
   * so the pips keep the arrival order they are read in.
   */
  update(declaration: Declaration): void;
  /** Declarations that are gone — retracted, swept by an attacker's next swing, or cleared. */
  removeMany(declarationIds: string[]): void;
  /**
   * Drops whatever a removed token was part of, at either end.
   *
   * The database has already cascaded this away; without it the client would keep drawing a pip in
   * a dead monster's colour on the player it was attacking.
   */
  dropToken(tokenId: string): void;
  /** How many attacks on the page are still waiting on somebody. */
  openCount(): number;
  /** Whether anything answered is standing on the page — what `Clear resolved` would take. */
  hasResolved(): boolean;
  /**
   * Everything pointing at one token, oldest first — the order the pips sit in, which is the order
   * the table spoke in. Callers filter it for the half that is theirs (#73).
   */
  on(targetId: string): Declaration[];
  /** Redraws the pips. Needed after a layer is repopulated with a page's tokens. */
  render(): void;
}

/**
 * The colour of an attack nobody named a token for — the GM's.
 *
 * It never shares a ring with a player's colour: a player declares on monsters and the GM declares
 * on the party, so the two kinds of pip are never drawn on the same token. What this has to be is
 * legible on any map, not distinct from anybody.
 */
export const GM_DECLARATION_COLOR = '#c0392b';

/**
 * @param layers every layer that can hold a token, so an attacker's colour can be looked up
 * @param owes whether an exchange is waiting on the person at *this* screen. The two clients
 *   answer it differently — the GM answers for monsters and sends numbers for their own attacks,
 *   a player does the opposite — and it is the only thing that pulses (#73).
 */
export function createDeclarations(
  layers: TokenController[],
  owes: (declaration: Declaration) => boolean
): Declarations {
  let list: Declaration[] = [];

  function colorOf(sourceId: string | null): string {
    if (sourceId === null) return GM_DECLARATION_COLOR;
    for (const layer of layers) {
      const token = layer.getToken(sourceId);
      if (token) return token.color;
    }
    return GM_DECLARATION_COLOR;
  }

  function render() {
    const byTarget = new Map<string, TokenPip[]>();
    for (const declaration of list) {
      const pip: TokenPip = {
        id: declaration.id,
        color: colorOf(declaration.source_id),
        state: declaration.state,
        damage: declaration.damage,
        owed: owes(declaration),
      };
      const pips = byTarget.get(declaration.target_id);
      if (pips) pips.push(pip);
      else byTarget.set(declaration.target_id, [pip]);
    }
    // Both layers get the same map. A target lives in exactly one of them, and the other ignores it.
    for (const layer of layers) layer.setDeclarations(byTarget);
  }

  return {
    replace(next) {
      list = next.slice();
      render();
    },
    add(declaration) {
      list = list.filter((d) => d.id !== declaration.id);
      list.push(declaration);
      render();
    },
    update(declaration) {
      list = list.map((d) => (d.id === declaration.id ? declaration : d));
      render();
    },
    removeMany(declarationIds) {
      const gone = new Set(declarationIds);
      list = list.filter((d) => !gone.has(d.id));
      render();
    },
    dropToken(tokenId) {
      list = list.filter((d) => d.source_id !== tokenId && d.target_id !== tokenId);
      render();
    },
    on(targetId) {
      return list.filter((d) => d.target_id === targetId);
    },
    openCount() {
      return list.filter((d) => d.state === 'open').length;
    },
    hasResolved() {
      return list.some((d) => d.state !== 'open');
    },
    render,
  };
}
