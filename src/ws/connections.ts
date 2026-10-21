import type { ServerWebSocket } from "bun";
import type { WsData } from "../types";

export interface ConnectionInfo {
  adventureId: string;
  role: "gm" | "player";
  playerName?: string;
  playerColor?: string;
  tokenId?: string;
  playerLink?: string;
  /** The signed-in account, on a GM connection. */
  userId?: string;
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

export function getGmWsForAdventure(
  adventureId: string
): ServerWebSocket<WsData> | undefined {
  for (const [ws, info] of connections) {
    if (info.adventureId === adventureId && info.role === "gm") return ws;
  }
  return undefined;
}

export function getGmSocketsForAdventure(
  adventureId: string
): ServerWebSocket<WsData>[] {
  const result: ServerWebSocket<WsData>[] = [];
  for (const [ws, info] of connections) {
    if (info.adventureId === adventureId && info.role === "gm") result.push(ws);
  }
  return result;
}

/** Every device holding a token: one player may be on a phone and a laptop at once (#59). */
export function getSocketsForToken(adventureId: string, tokenId: string): ServerWebSocket<WsData>[] {
  const result: ServerWebSocket<WsData>[] = [];
  for (const [ws, info] of connections) {
    if (info.adventureId === adventureId && info.tokenId === tokenId) result.push(ws);
  }
  return result;
}

/** Every socket on an adventure, or only one account's GM sockets when `userId` is given. */
export function getSocketsForAdventure(adventureId: string, userId?: string): ServerWebSocket<WsData>[] {
  const result: ServerWebSocket<WsData>[] = [];
  for (const [ws, info] of connections) {
    if (info.adventureId !== adventureId) continue;
    if (userId !== undefined && (info.role !== "gm" || info.userId !== userId)) continue;
    result.push(ws);
  }
  return result;
}
