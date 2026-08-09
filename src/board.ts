/**
 * Where a page sits on an adventure's board.
 *
 * A position means only what the GM means by it — village here, mill to the right, cellar below.
 * Nothing here reads an order, an adjacency or a geography into it; these functions exist only so
 * that a page the GM has never arranged lands somewhere readable instead of on top of another one.
 *
 * Pure by design (principle 3): no DOM, no database. The migration in `db/schema.ts` and the upload
 * route both go through `nextFreeSpot`, so a page that predates the board and a page uploaded today
 * are placed by the same rule.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageSize {
  id: string;
  width: number;
  height: number;
}

export interface PagePosition {
  id: string;
  x: number;
  y: number;
}

/**
 * A page whose dimensions were never parsed still needs a footprint, or it would be placed at zero
 * size and every page after it would land on top of it. `images.width`/`height` are 0 for uploads
 * whose header could not be read — see `repairImageDimensions` and #10.
 */
const MIN_FOOTPRINT = 512;

/** Pages per row before the layout wraps. Three reads as a board rather than as a filmstrip. */
const ROW_LIMIT = 3;

function footprint(width: number, height: number): { w: number; h: number } {
  return {
    w: width > 0 ? width : MIN_FOOTPRINT,
    h: height > 0 ? height : MIN_FOOTPRINT,
  };
}

/** Breathing room between pages, proportional to the largest one so big maps do not touch. */
export function gapFor(sizes: Array<{ width: number; height: number }>): number {
  let largest = 0;
  for (const s of sizes) {
    const { w, h } = footprint(s.width, s.height);
    largest = Math.max(largest, w, h);
  }
  return Math.max(40, Math.round(largest * 0.08));
}

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * The spot a new page takes on a board that already holds `existing`.
 *
 * Bottom-left packing: every candidate sits flush right of, or flush below, a page that is already
 * there, and the top-most then left-most candidate that collides with nothing wins. Rows wrap at
 * `ROW_LIMIT` pages wide, so folding this over an unarranged adventure produces a grid rather than
 * one long strip.
 */
export function nextFreeSpot(
  existing: Rect[],
  width: number,
  height: number,
  gap?: number
): { x: number; y: number } {
  const { w, h } = footprint(width, height);
  const g = gap ?? gapFor([...existing, { width, height }]);
  if (existing.length === 0) return { x: 0, y: 0 };

  // A stored page whose dimensions were never parsed occupies nothing, so it would block no
  // candidate and the next upload would land on top of it. Same floor as the page being placed.
  const taken: Rect[] = existing.map((r) => {
    const size = footprint(r.width, r.height);
    return { x: r.x, y: r.y, width: size.w, height: size.h };
  });

  const widest = Math.max(w, ...taken.map((r) => r.width));
  const rowLimit = widest * ROW_LIMIT + g * (ROW_LIMIT - 1);

  const candidates: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
  for (const r of taken) {
    candidates.push({ x: r.x + r.width + g, y: r.y });
    candidates.push({ x: r.x, y: r.y + r.height + g });
  }
  candidates.sort((a, b) => a.y - b.y || a.x - b.x);

  for (const c of candidates) {
    if (c.x > 0 && c.x + w > rowLimit) continue;
    const spot: Rect = { x: c.x, y: c.y, width: w, height: h };
    if (!taken.some((r) => intersects(r, spot))) return c;
  }

  // Every candidate was blocked, which the "below each page" candidates make unreachable for
  // non-degenerate input. Falling back below the whole board still overlaps nothing.
  const bottom = Math.max(...taken.map((r) => r.y + r.height));
  return { x: 0, y: bottom + g };
}

/** The default arrangement for pages nobody has ever dragged. Deterministic for a given input. */
export function layoutPages(pages: PageSize[]): PagePosition[] {
  const gap = gapFor(pages);
  const placed: Rect[] = [];
  const out: PagePosition[] = [];
  for (const page of pages) {
    const { w, h } = footprint(page.width, page.height);
    const spot = nextFreeSpot(placed, page.width, page.height, gap);
    placed.push({ x: spot.x, y: spot.y, width: w, height: h });
    out.push({ id: page.id, x: spot.x, y: spot.y });
  }
  return out;
}
