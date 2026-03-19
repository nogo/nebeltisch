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

export interface PingMessage {
  type: "ping";
}

export type ClientMessage =
  | JoinMessage
  | FogStrokeMessage
  | FogStrokeBatchMessage
  | TokenMoveMessage
  | MapSwitchMessage
  | PlayerRemoveMessage
  | PingMessage;

// ---- Server → Client ----

export interface JoinedMessage {
  type: "joined";
  adventure: { id: string; name: string; activeImageId: string | null };
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

export type ServerMessage =
  | JoinedMessage
  | FogStrokeBroadcast
  | FogStrokeBatchBroadcast
  | FogResetMessage
  | TokenMovedMessage
  | TokenAddedMessage
  | TokenRemovedMessage
  | MapSwitchedMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | PlayerRosterMessage
  | PlayerRemovedMessage
  | ErrorMessage
  | PongMessage;

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
