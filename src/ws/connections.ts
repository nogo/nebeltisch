import type { ServerWebSocket } from "bun";
import type { WsData } from "../types";

export interface ConnectionInfo {
  adventureId: string;
  role: "gm" | "player";
  playerName?: string;
  playerColor?: string;
  tokenId?: string;
  playerLink?: string;
}

const connections = new Map<ServerWebSocket<WsData>, ConnectionInfo>();

export function registerConnection(
  ws: ServerWebSocket<WsData>,
  info: ConnectionInfo
): void {
  connections.set(ws, info);
  ws.subscribe(`adventure:${info.adventureId}`);
}

export function unregisterConnection(
  ws: ServerWebSocket<WsData>
): ConnectionInfo | undefined {
  const info = connections.get(ws);
  if (!info) return undefined;
  connections.delete(ws);
  return info;
}

export function getConnection(
  ws: ServerWebSocket<WsData>
): ConnectionInfo | undefined {
  return connections.get(ws);
}

export function getConnectionsForAdventure(adventureId: string): ConnectionInfo[] {
  const result: ConnectionInfo[] = [];
  for (const [, info] of connections) {
    if (info.adventureId === adventureId) result.push(info);
  }
  return result;
}

export function getWsForToken(
  adventureId: string,
  tokenId: string
): ServerWebSocket<WsData> | undefined {
  for (const [ws, info] of connections) {
    if (info.adventureId === adventureId && info.tokenId === tokenId) return ws;
  }
  return undefined;
}

export function getGmWsForAdventure(
  adventureId: string
): ServerWebSocket<WsData> | undefined {
  for (const [ws, info] of connections) {
    if (info.adventureId === adventureId && info.role === "gm") return ws;
  }
  return undefined;
}
