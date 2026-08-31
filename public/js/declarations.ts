import type { Declaration } from '../../src/types';
import type { TokenController } from './tokens';

/**
 * What the table has said out loud, held for one page and drawn on the tokens it points at.
 *
 * Shared by both clients because a declaration means the same thing on either screen: the server
 * decides who may make one, and the two clients differ only in which tokens they offer it on.
 *
 * The list is the presented page's, whole. It is replaced on joining and on every page switch, and
 * nudged by `declaration:opened` and `declaration:retracted` in between — a client never computes
 * a declaration for itself, so a pip on screen is always one the server wrote down (principle 2).
 */
export interface Declarations {
  /** The whole of a page, from `joined` or `map:switched`. */
  replace(list: Declaration[]): void;
  add(declaration: Declaration): void;
  remove(declarationId: string): void;
  /**
   * Drops whatever a removed token was part of, at either end.
   *
   * The database has already cascaded this away; without it the client would keep drawing a pip in
   * a dead monster's colour on the player it was attacking.
   */
  dropToken(tokenId: string): void;
  /** This attacker's open declaration on that token, if they have one. The menu's toggle. */
  openOn(targetId: string, sourceId: string | null): Declaration | null;
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

export function createDeclarations(layers: TokenController[]): Declarations {
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
    const byTarget = new Map<string, string[]>();
    for (const declaration of list) {
      const pips = byTarget.get(declaration.target_id);
      if (pips) pips.push(colorOf(declaration.source_id));
      else byTarget.set(declaration.target_id, [colorOf(declaration.source_id)]);
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
    remove(declarationId) {
      list = list.filter((d) => d.id !== declarationId);
      render();
    },
    dropToken(tokenId) {
      list = list.filter((d) => d.source_id !== tokenId && d.target_id !== tokenId);
      render();
    },
    openOn(targetId, sourceId) {
      return (
        list.find(
          (d) => d.target_id === targetId && d.source_id === sourceId && d.state === 'open'
        ) ?? null
      );
    },
    render,
  };
}
