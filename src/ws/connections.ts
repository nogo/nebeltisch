import type { ServerWebSocket } from "bun";
import type { WsData } from "../types";

export interface ConnectionInfo {
  adventureId: string;
  role: "gm" | "player";
  playerName?: string;
  playerColor?: string;
  tokenId?: string;
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
