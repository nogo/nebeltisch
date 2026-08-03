import type { FogStroke, Token } from "../types";

// ---- Client → Server ----

export interface JoinMessage {
  type: "join";
  adventureId: string;
  role: "gm" | "player";
  password?: string;
  playerName?: string;
  playerColor?: string;
  playerLink?: string;
}

export interface FogStrokeMessage {
  type: "fog:stroke";
  stroke: FogStroke;
}

export interface FogStrokeBatchMessage {
  type: "fog:stroke:batch";
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

export interface PlayerRemoveMessage {
  type: "player:remove";
  tokenId: string;
}

export interface FogUndoMessage {
  type: "fog:undo";
  strokes: FogStroke[];
}

export interface SettingsUpdateMessage {
  type: "settings:update";
  tokenSize: number;
}

export interface MapStartPointMessage {
  type: "map:start_point";
  imageId: string;
  x: number;
  y: number;
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

export type ClientMessage =
  | JoinMessage
  | FogStrokeMessage
  | FogStrokeBatchMessage
  | FogUndoMessage
  | TokenMoveMessage
  | MapSwitchMessage
  | PlayerRemoveMessage
  | PingMessage
  | PingMapMessage
  | MapStartPointMessage
  | SettingsUpdateMessage;

// ---- Server → Client ----

export interface JoinedMessage {
  type: "joined";
  adventure: { id: string; name: string; activeImageId: string | null; tokenSize: number };
  tokens: Token[];
  fogMask: string | null;
  yourTokenId?: string;
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

export interface MapSwitchedMessage {
  type: "map:switched";
  imageId: string;
  fogMask: string | null;
  /** GM tokens belonging to the new map. */
  gmTokens: Token[];
  /** Player tokens, repositioned onto the new map's start point. */
  playerTokens: Token[];
}

export interface MapStartPointSetMessage {
  type: "map:start_point:set";
  imageId: string;
  x: number;
  y: number;
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

export type ServerMessage =
  | JoinedMessage
  | FogStrokeBroadcast
  | FogStrokeBatchBroadcast
  | FogResetMessage
  | TokenMovedMessage
  | TokenAddedMessage
  | TokenRemovedMessage
  | MapSwitchedMessage
  | MapStartPointSetMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | PlayerRosterMessage
  | PlayerRemovedMessage
  | ErrorMessage
  | PongMessage
  | PingMapBroadcast
  | SettingsUpdatedMessage;

export function parseMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw);
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string")
      return null;
    return msg as ClientMessage;
  } catch {
    return null;
  }
}

export function serializeMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
