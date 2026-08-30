/**
 * Has this pointer gesture become a drag, or is it still a tap?
 *
 * One named answer because the question is asked from three places — the board, the start marker
 * and the token layer — and the token layer was the one that never asked it. Landing a finger on a
 * token was treated as an infinitesimal drag, so a tap sent `token:move`, and `token:move` is the
 * only writer of `token_positions`: tapping a player token quietly consumed that map's start point
 * (#60, the same trap as #46).
 */

/** Screen pixels of slop before a press counts as a drag. */
export const DRAG_THRESHOLD_PX = 5;

export interface ScreenPoint {
  x: number;
  y: number;
}

export function hasDragged(from: ScreenPoint, to: ScreenPoint): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX;
}
