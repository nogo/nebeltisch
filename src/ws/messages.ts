import type { Declaration, FogStroke, Token, TokenState } from "../types";

// ---- Client → Server ----

export interface JoinMessage {
  type: "join";
  adventureId: string;
  role: "gm" | "player";
  playerName?: string;
  playerColor?: string;
  playerLink?: string;
}

/**
 * Every fog message names the page it paints.
 *
 * The GM prepares a page the party is not looking at, so "which page" can no longer be inferred
 * from `active_image_id`. The server stores the stroke either way and **broadcasts only when this
 * id is the presented page** — the rule that keeps preparation invisible lives there, not in a UI
 * mode, and the GM's phase never reaches the server (#51).
 */
export interface FogStrokeMessage {
  type: "fog:stroke";
  imageId: string;
  stroke: FogStroke;
}

export interface FogStrokeBatchMessage {
  type: "fog:stroke:batch";
  imageId: string;
  strokes: FogStroke[];
}

export interface TokenMoveMessage {
  type: "token:move";
  tokenId: string;
  x: number;
  y: number;
}

export interface MapSwitchMessage {
  type: "map:switch";
  imageId: string;
}

/**
 * Takes the presented page off the table. A message of its own rather than a null `imageId` on
 * `map:switch`: that path moves the party onto a page, opens its fog and sends its mask, and none
 * of it has a meaning when there is no page.
 */
export interface MapUnpresentMessage {
  type: "map:unpresent";
}

export interface PlayerRemoveMessage {
  type: "player:remove";
  tokenId: string;
}

/** Marks the end of one brush action, so the server can snapshot for undo. */
export interface FogActionEndMessage {
  type: "fog:action:end";
  imageId: string;
}

/** History is per page, so undo on a page in preparation never touches the live page's stack. */
export interface FogUndoMessage {
  type: "fog:undo";
  imageId: string;
}

export interface FogRedoMessage {
  type: "fog:redo";
  imageId: string;
}

/**
 * GM-only: what are undo and redo able to do on this page?
 *
 * Undo history is server-owned and per image, so selecting a page on the board is the moment the
 * GM's buttons need its state. Answered with `fog:history`; never loads a mask that is not already
 * resident.
 */
export interface FogHistoryQueryMessage {
  type: "fog:history:query";
  imageId: string;
}

export interface SettingsUpdateMessage {
  type: "settings:update";
  tokenSize: number;
}

export interface MapStartPointMessage {
  type: "map:start_point";
  imageId: string;
  /** Null clears the start point; the map centre becomes the fallback again. */
  x: number | null;
  y: number | null;
}

export interface MapStartPointLockMessage {
  type: "map:start_point:lock";
  imageId: string;
  locked: boolean;
}

export interface PingMessage {
  type: "ping";
}

export interface PingMapMessage {
  type: "ping:map";
  x: number;
  y: number;
  color: string;
}

/**
 * Places a monster or NPC on one page of the adventure. GM only.
 *
 * Same rule as fog: stored on whichever page is named, broadcast only when that page is the one
 * the party is looking at.
 */
export interface GmTokenPlaceMessage {
  type: "gm_token:place";
  imageId: string;
  name: string;
  tokenType: "monster" | "npc";
  x: number;
  y: number;
}

/** Removes a monster or NPC. GM only; never accepts a player token. */
export interface GmTokenRemoveMessage {
  type: "gm_token:remove";
  tokenId: string;
}

/**
 * Renames a monster or NPC — "Ork" becomes "Ork 2" once there are three of them. GM only.
 *
 * **Never accepts a player token.** Player identity is the composite `playerLink|playerName`, and
 * reconnection matches on it: renaming without touching `player_link` leaves a token whose name no
 * longer matches how its owner rejoins, and renaming with it breaks every other device. The
 * restriction lives on the message rather than in the caller so there is one place to hold it.
 *
 * No `imageId`: a monster carries its own `image_id`, so which page this belongs to is never
 * ambiguous, and the presented-page rule is applied from the token itself.
 */
export interface GmTokenRenameMessage {
  type: "gm_token:rename";
  tokenId: string;
  name: string;
}

/**
 * Marks a token alive, unconscious or dead. GM only — and unlike `gm_token:rename`, it **accepts a
 * player token**: a player does not adjudicate their own unconsciousness, so the GM is the only
 * writer of every token's state. Nothing sets one automatically; this message is the only path.
 *
 * No `imageId`, for the same reason rename has none: a monster carries its own `image_id`, and a
 * player token has none and is therefore always on the presented page.
 */
export interface GmTokenStateMessage {
  type: "gm_token:state";
  tokenId: string;
  state: TokenState;
}

/**
 * Declares an attack on a token. Sent by both clients, and it names only the target.
 *
 * **The attacker is never on the wire.** The server reads it off the connection — a player's own
 * token, or nothing at all for the GM — so there is no source for a client to get wrong and none
 * for a client to forge. The page is read off `active_image_id` for the same reason: a declaration
 * is made at the table, and the table is showing one page.
 */
export interface DeclarationOpenMessage {
  type: "declaration:open";
  targetId: string;
}

/** Takes back an open declaration. Only the client that made it may. */
export interface DeclarationRetractMessage {
  type: "declaration:retract";
  declarationId: string;
}

/**
 * Takes every answered declaration off the presented page. GM only, and it cannot touch an open
 * one — the fight tidies itself as it goes, and this is for what the last round left behind (#74).
 */
export interface DeclarationClearMessage {
  type: "declaration:clear";
}

/**
 * Parried, or not parried. Sent by the owner of the *target*: a player for their own token, the GM
 * for every monster and NPC. One writer per object, and the object is the declaration.
 *
 * Only an open declaration can be answered. Answering is what makes it a record.
 */
export interface DeclarationAnswerMessage {
  type: "declaration:answer";
  declarationId: string;
  parried: boolean;
}

/**
 * The number the attacker rolled, sent by the owner of the *source* — the other half of the pair.
 *
 * Only on a not-parried declaration, and only once. The first client-supplied number on the wire,
 * so it is range-checked at the boundary rather than trusted (principle 9).
 */
export interface DeclarationDamageMessage {
  type: "declaration:damage";
  declarationId: string;
  damage: number;
}

export type ClientMessage =
  | JoinMessage
  | FogStrokeMessage
  | FogStrokeBatchMessage
  | FogActionEndMessage
  | FogUndoMessage
  | FogRedoMessage
  | FogHistoryQueryMessage
  | TokenMoveMessage
  | MapSwitchMessage
  | MapUnpresentMessage
  | PlayerRemoveMessage
  | PingMessage
  | PingMapMessage
  | MapStartPointMessage
  | MapStartPointLockMessage
  | SettingsUpdateMessage
  | GmTokenPlaceMessage
  | GmTokenRemoveMessage
  | GmTokenRenameMessage
  | GmTokenStateMessage
  | DeclarationOpenMessage
  | DeclarationRetractMessage
  | DeclarationAnswerMessage
  | DeclarationDamageMessage
  | DeclarationClearMessage;

// ---- Server → Client ----

export interface JoinedMessage {
  type: "joined";
  adventure: { id: string; name: string; activeImageId: string | null; tokenSize: number };
  tokens: Token[];
  fogMask: string | null;
  yourTokenId?: string;
  /** Standing on the presented page. Empty when there is none, so a reload draws the fight again. */
  declarations: Declaration[];
}

export interface FogStrokeBroadcast {
  type: "fog:stroke";
  stroke: FogStroke;
  imageId: string;
}

export interface FogStrokeBatchBroadcast {
  type: "fog:stroke:batch";
  strokes: FogStroke[];
  imageId: string;
}

export interface FogResetMessage {
  type: "fog:reset";
  imageId: string;
  fogMask: string;
}

/** GM-only: drives the undo/redo button state. */
export interface FogHistoryMessage {
  type: "fog:history";
  imageId: string;
  canUndo: boolean;
  canRedo: boolean;
}

export interface TokenMovedMessage {
  type: "token:moved";
  tokenId: string;
  x: number;
  y: number;
}

export interface TokenAddedMessage {
  type: "token:added";
  token: Token;
}

export interface TokenRemovedMessage {
  type: "token:removed";
  tokenId: string;
}

/** A monster or NPC now goes by another name. Reaches players only for the presented page. */
export interface TokenRenamedMessage {
  type: "token:renamed";
  tokenId: string;
  name: string;
}

/** A token is standing, down or gone. Reaches players only for the presented page. */
export interface TokenStateSetMessage {
  type: "token:state:set";
  tokenId: string;
  state: TokenState;
}

/**
 * The table is empty again. Player tokens are deliberately left where they stand: their positions
 * are what `token_positions` remembers, so presenting the page again returns the party to it
 * rather than re-scattering them at the start point.
 */
export interface MapUnpresentedMessage {
  type: "map:unpresented";
}

export interface MapSwitchedMessage {
  type: "map:switched";
  imageId: string;
  fogMask: string | null;
  /** GM tokens belonging to the new map. */
  gmTokens: Token[];
  /** Player tokens, repositioned onto the new map's start point. */
  playerTokens: Token[];
  /** The new page's declarations. The previous page's are hidden by being absent from this list. */
  declarations: Declaration[];
}

/** GM-only. Sent for both a move and a lock, so one message carries the whole state. */
export interface MapStartPointSetMessage {
  type: "map:start_point:set";
  imageId: string;
  x: number | null;
  y: number | null;
  locked: boolean;
}

export interface PlayerJoinedMessage {
  type: "player:joined";
  playerName: string;
  playerColor: string;
}

export interface PlayerLeftMessage {
  type: "player:left";
  playerName: string;
}

export interface PlayerRosterMessage {
  type: "player:roster";
  players: Array<{
    tokenId: string;
    name: string;
    color: string;
    online: boolean;
  }>;
}

export interface PlayerRemovedMessage {
  type: "player:removed";
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export interface PongMessage {
  type: "pong";
}

export interface SettingsUpdatedMessage {
  type: "settings:updated";
  tokenSize: number;
}

export interface PingMapBroadcast {
  type: "ping:map";
  x: number;
  y: number;
  color: string;
  name: string;
}

/** A monster or NPC was placed. Removal reuses `token:removed`. */
export interface GmTokenAddedMessage {
  type: "gm_token:added";
  token: Token;
}

/**
 * Somebody declared an attack. Reaches players only for the presented page — like fog, like a
 * monster, and for the same reason.
 */
export interface DeclarationOpenedMessage {
  type: "declaration:opened";
  declaration: Declaration;
}

/**
 * These declarations are gone. One message for every way that happens: retracted by the one who
 * made it, swept away by that attacker's next swing, or cleared off the table by the GM.
 *
 * The client's job is the same in all three — stop drawing them — so it is one message and one
 * handler rather than three of each.
 */
export interface DeclarationClearedMessage {
  type: "declaration:cleared";
  declarationIds: string[];
}

/** A declaration has been answered, or has had its number put on it. Presented page only. */
export interface DeclarationUpdatedMessage {
  type: "declaration:updated";
  declaration: Declaration;
}

export type ServerMessage =
  | JoinedMessage
  | GmTokenAddedMessage
  | FogStrokeBroadcast
  | FogStrokeBatchBroadcast
  | FogResetMessage
  | FogHistoryMessage
  | TokenMovedMessage
  | TokenAddedMessage
  | TokenRemovedMessage
  | TokenRenamedMessage
  | TokenStateSetMessage
  | MapSwitchedMessage
  | MapUnpresentedMessage
  | MapStartPointSetMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | PlayerRosterMessage
  | PlayerRemovedMessage
  | ErrorMessage
  | PongMessage
  | PingMapBroadcast
  | SettingsUpdatedMessage
  | DeclarationOpenedMessage
  | DeclarationClearedMessage
  | DeclarationUpdatedMessage;

// ---- Checking what arrives ----

/** One field's rule. True means the value may reach a handler as the type the union declares. */
type Check = (value: unknown) => boolean;

/** Every field of a message except `type`, optional ones included, each with its rule. */
type ShapeOf<M> = { [F in Exclude<keyof M, "type">]-?: Check };

/** Ids are UUIDs or eight-character links; the ceiling only stops a megabyte reaching SQLite. */
const MAX_ID_LENGTH = 64;
/** Longer than any name the clients send. The handlers trim to their own lengths after this. */
const MAX_TEXT_LENGTH = 500;
/** Strokes in one batch. The GM's client flushes every frame, so a batch holds a handful. */
const MAX_STROKES_PER_BATCH = 256;
/** The brush slider stops at 200; this leaves room without letting one stroke cover a planet. */
const MAX_BRUSH_RADIUS = 1000;

const id: Check = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH;
const text: Check = (v) => typeof v === "string" && v.length <= MAX_TEXT_LENGTH;
const finite: Check = (v) => typeof v === "number" && Number.isFinite(v);
const bool: Check = (v) => typeof v === "boolean";
const oneOf = (...values: unknown[]): Check => (v) => values.includes(v);
const nullable = (check: Check): Check => (v) => v === null || check(v);
const optional = (check: Check): Check => (v) => v === undefined || check(v);

const stroke: Check = (v) => {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    finite(s.x) &&
    finite(s.y) &&
    finite(s.radius) &&
    (s.radius as number) > 0 &&
    (s.radius as number) <= MAX_BRUSH_RADIUS &&
    oneOf("reveal", "fog")(s.mode)
  );
};
const strokes: Check = (v) =>
  Array.isArray(v) && v.length <= MAX_STROKES_PER_BATCH && v.every(stroke);

/**
 * The shape of every client message. A message type missing here, or a field of one, is a compile
 * error — so a new message cannot reach a handler unchecked.
 *
 * Shape only: whether the sender may do it, and whether a number is in the table's range, stay
 * with the handler that knows the rule.
 */
const SHAPES: { [T in ClientMessage["type"]]: ShapeOf<Extract<ClientMessage, { type: T }>> } = {
  join: {
    adventureId: id,
    role: oneOf("gm", "player"),
    playerName: optional(text),
    playerColor: optional(text),
    playerLink: optional(id),
  },
  "fog:stroke": { imageId: id, stroke },
  "fog:stroke:batch": { imageId: id, strokes },
  "fog:action:end": { imageId: id },
  "fog:undo": { imageId: id },
  "fog:redo": { imageId: id },
  "fog:history:query": { imageId: id },
  "token:move": { tokenId: id, x: finite, y: finite },
  "map:switch": { imageId: id },
  "map:unpresent": {},
  "player:remove": { tokenId: id },
  ping: {},
  "ping:map": { x: finite, y: finite, color: text },
  "map:start_point": { imageId: id, x: nullable(finite), y: nullable(finite) },
  "map:start_point:lock": { imageId: id, locked: bool },
  "settings:update": { tokenSize: finite },
  "gm_token:place": {
    imageId: id,
    name: text,
    tokenType: oneOf("monster", "npc"),
    x: finite,
    y: finite,
  },
  "gm_token:remove": { tokenId: id },
  "gm_token:rename": { tokenId: id, name: text },
  "gm_token:state": { tokenId: id, state: oneOf("alive", "unconscious", "dead") },
  "declaration:open": { targetId: id },
  "declaration:retract": { declarationId: id },
  "declaration:answer": { declarationId: id, parried: bool },
  "declaration:damage": { declarationId: id, damage: finite },
  "declaration:clear": {},
};

export type ParseResult = { message: ClientMessage } | { error: string };

/**
 * Reads one client message off the wire, or says why not.
 *
 * What comes back as `message` matches its member of `ClientMessage` field for field, so handlers
 * may use a value without coercing it. Unknown types are told apart from malformed ones, because
 * a client newer than the server sends the first and a broken or hostile one sends the second.
 */
export function parseMessage(raw: string): ParseResult {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { error: "Invalid message format" };
  }
  if (!msg || typeof msg !== "object") return { error: "Invalid message format" };
  const fields = msg as Record<string, unknown>;
  if (typeof fields.type !== "string") return { error: "Invalid message format" };
  if (!Object.hasOwn(SHAPES, fields.type)) return { error: "Unknown message type" };
  const shape: Record<string, Check> = SHAPES[fields.type as ClientMessage["type"]];
  for (const [field, check] of Object.entries(shape)) {
    if (!check(fields[field])) return { error: "Invalid message format" };
  }
  return { message: msg as ClientMessage };
}

export function serializeMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
