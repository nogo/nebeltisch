/**
 * Who hears about an edit: only the presented page reaches the players (see "Only the presented
 * page reaches the players" in docs/architecture.md).
 */

/**
 * Whether the players hear about something on `imageId` while `liveImageId` is presented. `null`
 * is a player token's page: it stands on whatever is presented, so it is always heard. So is a
 * monster row with no image, which predates per-map GM tokens.
 */
export function reachesTable(imageId: string | null, liveImageId: string | null): boolean {
  return imageId === null || imageId === liveImageId;
}
