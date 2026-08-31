import type { ClientMessage, ServerMessage } from '../../src/ws/messages';

/**
 * Type-only import of the server's wire contract. It is erased at build time, so no
 * server code reaches the bundle — but a handler that reads a field the server does not
 * send is now a compile error instead of `undefined` at the table.
 */

/** Emitted locally by this client, not by the server. */
export type LocalEvent = 'connect' | 'disconnect';

export type EventType = ServerMessage['type'] | LocalEvent;

export type PayloadOf<T extends EventType> = T extends ServerMessage['type']
  ? Extract<ServerMessage, { type: T }>
  : Record<string, never>;

export interface WebSocketClient {
  send(msg: ClientMessage): void;
  on<T extends EventType>(type: T, handler: (msg: PayloadOf<T>) => void): void;
  close(): void;
}

type AnyHandler = (msg: never) => void;

function makeClient(buildUrl: () => string): WebSocketClient {
  const handlers = new Map<string, AnyHandler[]>();
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  // The one unchecked hop in the client: the socket yields JSON, and `type` selects the
  // handler list. Everything downstream of here is checked against ServerMessage.
  function emit(type: string, msg: unknown) {
    for (const h of handlers.get(type) ?? []) {
      try { (h as (m: unknown) => void)(msg); } catch (e) { console.error('ws handler error', e); }
    }
  }

  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(buildUrl());
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      backoff = 1000;
      emit('connect', {});
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as Record<string, unknown>;
        if (typeof msg?.type === 'string') emit(msg.type, msg);
      } catch {}
    };

    ws.onerror = () => { ws?.close(); };

    ws.onclose = () => {
      ws = null;
      if (closed) return;
      emit('disconnect', {});
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      backoff = Math.min(backoff * 2, 30000);
      connect();
    }, backoff);
  }

  /**
   * A tablet that woke up, or a network that came back. The scheduled retry can be 30 seconds
   * away, and a player who presses something in that window sends nothing — so retry at once.
   * The pending timer has to be cancelled or the two attempts race and open two sockets.
   */
  function reconnectNow() {
    if (closed) return;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
    connect();
  }

  function onVisibility() { if (!document.hidden) reconnectNow(); }

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', reconnectNow);

  connect();

  return {
    send(msg: ClientMessage) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    on<T extends EventType>(type: T, handler: (msg: PayloadOf<T>) => void) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(handler as AnyHandler);
    },
    close() {
      closed = true;
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', reconnectNow);
      ws?.close();
    },
  };
}

export function connectGM(adventureId: string, password: string): WebSocketClient {
  return makeClient(() => {
    const u = new URL('/ws', window.location.href);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('adventureId', adventureId);
    u.searchParams.set('role', 'gm');
    u.searchParams.set('password', password);
    return u.toString();
  });
}

export function connectPlayer(
  adventureId: string,
  playerLink: string,
  playerName: string,
  playerColor: string
): WebSocketClient {
  return makeClient(() => {
    const u = new URL('/ws', window.location.href);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('adventureId', adventureId);
    u.searchParams.set('role', 'player');
    u.searchParams.set('playerLink', playerLink);
    u.searchParams.set('playerName', playerName);
    u.searchParams.set('playerColor', playerColor);
    return u.toString();
  });
}
