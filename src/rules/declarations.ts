/**
 * Who may write which half of a declaration. Checked against the connection, never the message
 * (see "No CRDT" in docs/architecture.md): the halves are disjoint, so there is nothing to resolve.
 */

/** Who sent a message: the GM, or a player and the one token their socket holds. */
export interface Actor {
  role: "gm" | "player";
  tokenId?: string;
}

/**
 * Whether `actor` speaks for the attacking side: retracting it and sending its number. `null` is
 * the GM — their declarations have no source token, because which monster swings is narration.
 */
export function ownsSource(actor: Actor, sourceId: string | null): boolean {
  return sourceId === null
    ? actor.role === "gm"
    : actor.role !== "gm" && actor.tokenId === sourceId;
}

/** Whether `actor` answers for the target: a player for their own token, the GM for every other. */
export function ownsTarget(actor: Actor, target: { id: string; token_type: string }): boolean {
  return target.token_type === "player"
    ? actor.role !== "gm" && actor.tokenId === target.id
    : actor.role === "gm";
}
