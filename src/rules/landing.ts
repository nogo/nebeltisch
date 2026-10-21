/**
 * Where the party lands on a page: arrival on the start point, return to where a token last walked.
 *
 * Pure geometry with no imports, because the GM's browser imports this file too — it draws the ring
 * these functions place tokens on, and one formula means the ring cannot drift from the landing.
 * Keep it import-free: anything it imports is bundled into the client.
 */

export interface Point {
  x: number;
  y: number;
}

/** The parts of a page landing reads. `start_*` null means "never moved": the centre stands in. */
export interface LandingPage {
  width: number;
  height: number;
  start_x: number | null;
  start_y: number | null;
}

function startOf(page: LandingPage): Point {
  return { x: page.start_x ?? page.width / 2, y: page.start_y ?? page.height / 2 };
}

/** Radius of the ring the party lands on, and the one the GM's start marker draws. */
export function ringRadius(count: number, tokenSize: number): number {
  // The ring grows with the party so neighbours never overlap: circumference / count must exceed a
  // token's diameter plus a gap.
  return tokenSize * Math.max(2.2, Math.max(count, 1) * 0.45);
}

/**
 * Places `count` tokens around a target point without stacking them, clamped
 * inside the image so a switch to a smaller map can never strand a token
 * off-canvas where nobody can reach it.
 */
export function scatterPositions(
  count: number,
  cx: number,
  cy: number,
  width: number,
  height: number,
  tokenSize: number
): Point[] {
  const margin = Math.min(tokenSize, width / 2, height / 2);
  // Every token stands around the point, never on it, so the marker underneath stays visible.
  const ring = ringRadius(count, tokenSize);
  const out: Point[] = [];
  for (let i = 0; i < count; i++) {
    // Start at the top and go clockwise — predictable, so the GM can learn it.
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    out.push({
      x: Math.round(Math.min(width - margin, Math.max(margin, cx + Math.cos(angle) * ring))),
      y: Math.round(Math.min(height - margin, Math.max(margin, cy + Math.sin(angle) * ring))),
    });
  }
  return out;
}

/** Where one more arrival stands when `alreadyThere` players are on the page. */
export function arrivalPosition(alreadyThere: number, page: LandingPage, tokenSize: number): Point {
  const start = startOf(page);
  const ring = scatterPositions(
    alreadyThere + 1,
    start.x,
    start.y,
    page.width,
    page.height,
    tokenSize
  );
  return ring[alreadyThere];
}

/**
 * Where every player token stands after the party moves onto `page`, in the order given.
 *
 * A token with a remembered position walked there and returns to it. Every other token arrives,
 * spread on the ring around the start point. `remembered` must only ever hold walks (#46).
 */
export function landParty(
  tokenIds: string[],
  remembered: Map<string, Point>,
  page: LandingPage,
  tokenSize: number
): Map<string, Point> {
  const arriving = tokenIds.filter((id) => !remembered.has(id));
  const start = startOf(page);
  const ring = scatterPositions(
    arriving.length,
    start.x,
    start.y,
    page.width,
    page.height,
    tokenSize
  );
  const out = new Map<string, Point>();
  let next = 0;
  for (const id of tokenIds) {
    const previous = remembered.get(id);
    out.set(
      id,
      previous
        ? {
            // Only rescue positions outside the image. The player chose this spot and token:move
            // does not clamp, so the margin applied to arrivals must not drag them off it.
            x: Math.round(Math.min(page.width, Math.max(0, previous.x))),
            y: Math.round(Math.min(page.height, Math.max(0, previous.y))),
          }
        : ring[next++]
    );
  }
  return out;
}
