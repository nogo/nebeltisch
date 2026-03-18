export type MessageHandler = (msg: Record<string, unknown>) => void;

export interface WebSocketClient {
  send(msg: Record<string, unknown>): void;
  on(type: string, handler: MessageHandler): void;
  close(): void;
}

export function connectGM(adventureId: string, password: string): WebSocketClient {
  const handlers = new Map<string, MessageHandler[]>();
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 1000;

  function emit(type: string, msg: Record<string, unknown>) {
    for (const h of handlers.get(type) ?? []) {
      try { h(msg); } catch (e) { console.error('ws handler error', e); }
    }
  }

  function buildUrl(): string {
    const u = new URL('/ws', window.location.href);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('adventureId', adventureId);
    u.searchParams.set('role', 'gm');
    u.searchParams.set('password', password);
    return u.toString();
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
    setTimeout(() => { backoff = Math.min(backoff * 2, 30000); connect(); }, backoff);
  }

  connect();

  return {
    send(msg: Record<string, unknown>) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    on(type: string, handler: MessageHandler) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(handler);
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}
