// public/js/websocket.ts
function makeClient(buildUrl) {
  const handlers = new Map;
  let ws = null;
  let closed = false;
  let backoff = 1000;
  function emit(type, msg) {
    for (const h of handlers.get(type) ?? []) {
      try {
        h(msg);
      } catch (e) {
        console.error("ws handler error", e);
      }
    }
  }
  function connect() {
    if (closed)
      return;
    try {
      ws = new WebSocket(buildUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      backoff = 1000;
      emit("connect", {});
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (typeof msg?.type === "string")
          emit(msg.type, msg);
      } catch {}
    };
    ws.onerror = () => {
      ws?.close();
    };
    ws.onclose = () => {
      ws = null;
      if (closed)
        return;
      emit("disconnect", {});
      scheduleReconnect();
    };
  }
  function scheduleReconnect() {
    setTimeout(() => {
      backoff = Math.min(backoff * 2, 30000);
      connect();
    }, backoff);
  }
  connect();
  return {
    send(msg) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    on(type, handler) {
      if (!handlers.has(type))
        handlers.set(type, []);
      handlers.get(type).push(handler);
    },
    close() {
      closed = true;
      ws?.close();
    }
  };
}
function connectGM(adventureId, password) {
  return makeClient(() => {
    const u = new URL("/ws", window.location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.searchParams.set("adventureId", adventureId);
    u.searchParams.set("role", "gm");
    u.searchParams.set("password", password);
    return u.toString();
  });
}
function connectPlayer(adventureId, playerLink, playerName, playerColor) {
  return makeClient(() => {
    const u = new URL("/ws", window.location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.searchParams.set("adventureId", adventureId);
    u.searchParams.set("role", "player");
    u.searchParams.set("playerLink", playerLink);
    u.searchParams.set("playerName", playerName);
    u.searchParams.set("playerColor", playerColor);
    return u.toString();
  });
}

// public/js/canvas.ts
async function decompress(data) {
  for (const fmt of ["deflate", "deflate-raw"]) {
    try {
      const ds = new DecompressionStream(fmt);
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(data.slice());
      writer.close();
      const chunks = [];
      for (;; ) {
        const { done, value } = await reader.read();
        if (done)
          break;
        chunks.push(value);
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out;
    } catch {}
  }
  throw new Error("Failed to decompress fog mask");
}
function initCanvas(container, options) {
  const fogAlpha = options?.mode === "player" ? 1 : 0.85;
  const fogFill = `rgba(0,0,0,${fogAlpha})`;
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:relative;flex-shrink:0;";
  container.appendChild(wrapper);
  function makeCanvas() {
    const c = document.createElement("canvas");
    c.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;";
    wrapper.appendChild(c);
    return c;
  }
  const mapCanvas = makeCanvas();
  const fogCanvas = makeCanvas();
  const previewCanvas = makeCanvas();
  previewCanvas.style.pointerEvents = "none";
  if (options?.mode === "player") {
    fogCanvas.style.pointerEvents = "none";
  }
  const mapCtx = mapCanvas.getContext("2d");
  const fogCtx = fogCanvas.getContext("2d");
  const previewCtx = previewCanvas.getContext("2d");
  let imgW = 0;
  let imgH = 0;
  function sizeAll(w, h) {
    imgW = w;
    imgH = h;
    for (const c of [mapCanvas, fogCanvas, previewCanvas]) {
      c.width = w;
      c.height = h;
    }
    const cw = container.clientWidth || 800;
    const ch = container.clientHeight || 600;
    const scale = Math.min(cw / w, ch / h);
    wrapper.style.width = `${Math.round(w * scale)}px`;
    wrapper.style.height = `${Math.round(h * scale)}px`;
  }
  function fillFog() {
    fogCtx.save();
    fogCtx.globalCompositeOperation = "source-over";
    fogCtx.fillStyle = fogFill;
    fogCtx.fillRect(0, 0, imgW, imgH);
    fogCtx.restore();
  }
  return {
    async loadImage(url) {
      const img = new Image;
      await new Promise((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error(`Failed to load image: ${url}`));
        img.src = url;
      });
      sizeAll(img.naturalWidth, img.naturalHeight);
      mapCtx.clearRect(0, 0, imgW, imgH);
      mapCtx.drawImage(img, 0, 0);
      fogCtx.clearRect(0, 0, imgW, imgH);
      fillFog();
      previewCtx.clearRect(0, 0, imgW, imgH);
    },
    async applyFogMask(base64) {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0;i < bin.length; i++)
        bytes[i] = bin.charCodeAt(i);
      const view = new DataView(bytes.buffer);
      const w = view.getUint32(0, false);
      const h = view.getUint32(4, false);
      const pixels = await decompress(bytes.slice(8));
      if (imgW !== w || imgH !== h)
        sizeAll(w, h);
      const id = fogCtx.createImageData(w, h);
      for (let i = 0;i < pixels.length; i++) {
        const v = pixels[i];
        id.data[i * 4 + 0] = 0;
        id.data[i * 4 + 1] = 0;
        id.data[i * 4 + 2] = 0;
        id.data[i * 4 + 3] = Math.round(v * fogAlpha);
      }
      fogCtx.putImageData(id, 0, 0);
    },
    applyStroke(stroke) {
      if (imgW === 0)
        return;
      fogCtx.save();
      fogCtx.beginPath();
      fogCtx.arc(stroke.x, stroke.y, stroke.radius, 0, Math.PI * 2);
      if (stroke.mode === "reveal") {
        fogCtx.globalCompositeOperation = "destination-out";
        fogCtx.fillStyle = "rgba(0,0,0,1)";
      } else {
        fogCtx.globalCompositeOperation = "source-over";
        fogCtx.fillStyle = fogFill;
      }
      fogCtx.fill();
      fogCtx.restore();
    },
    drawBrushPreview(imgX, imgY, radius) {
      if (imgW === 0)
        return;
      previewCtx.clearRect(0, 0, imgW, imgH);
      previewCtx.save();
      previewCtx.strokeStyle = "rgba(255,255,255,0.7)";
      previewCtx.lineWidth = Math.max(1, 2 * (imgW / (wrapper.clientWidth || imgW)));
      previewCtx.beginPath();
      previewCtx.arc(imgX, imgY, radius, 0, Math.PI * 2);
      previewCtx.stroke();
      previewCtx.restore();
    },
    clearBrushPreview() {
      if (imgW > 0)
        previewCtx.clearRect(0, 0, imgW, imgH);
    },
    screenToImage(clientX, clientY) {
      const rect = fogCanvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left) * (imgW / (rect.width || 1)),
        y: (clientY - rect.top) * (imgH / (rect.height || 1))
      };
    },
    getEventTarget() {
      return fogCanvas;
    },
    getWrapper() {
      return wrapper;
    },
    getImageSize() {
      return { w: imgW, h: imgH };
    },
    clear() {
      mapCtx.clearRect(0, 0, imgW, imgH);
      fogCtx.clearRect(0, 0, imgW, imgH);
      previewCtx.clearRect(0, 0, imgW, imgH);
    }
  };
}

// public/js/tokens.ts
var SCREEN_RADIUS = 20;
var SCREEN_FONT_SIZE = 12;
function initTokenLayer(wrapper, getImageSize, options) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;";
  if (options?.interactive === false) {
    canvas.style.pointerEvents = "none";
  }
  wrapper.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const tokens = new Map;
  let ownTokenId = null;
  let onMoveCallback = null;
  function getScale() {
    const { w } = getImageSize();
    const cw = canvas.clientWidth || w || 1;
    return w / cw;
  }
  function screenToImage(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const { w, h } = getImageSize();
    return {
      x: (clientX - rect.left) * (w / (rect.width || 1)),
      y: (clientY - rect.top) * (h / (rect.height || 1))
    };
  }
  function render() {
    const { w, h } = getImageSize();
    if (w === 0 || h === 0)
      return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    const scale = getScale();
    const r = SCREEN_RADIUS * scale;
    const fontSize = Math.max(10, Math.round(SCREEN_FONT_SIZE * scale));
    for (const token of tokens.values()) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(token.x, token.y, r, 0, Math.PI * 2);
      ctx.fillStyle = token.color;
      ctx.fill();
      if (token.id === ownTokenId) {
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 2 * scale;
        ctx.stroke();
      }
      ctx.restore();
      ctx.save();
      ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const labelY = token.y + r + 3 * scale;
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.lineWidth = 3 * scale;
      ctx.lineJoin = "round";
      ctx.strokeText(token.name, token.x, labelY);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(token.name, token.x, labelY);
      ctx.restore();
    }
  }
  let dragging = false;
  let lastMoveTime = 0;
  const MOVE_INTERVAL = 1000 / 30;
  canvas.addEventListener("pointerdown", (ev) => {
    if (!ownTokenId)
      return;
    const own = tokens.get(ownTokenId);
    if (!own)
      return;
    const scale = getScale();
    const r = SCREEN_RADIUS * scale;
    const pos = screenToImage(ev.clientX, ev.clientY);
    const dx = pos.x - own.x;
    const dy = pos.y - own.y;
    if (Math.sqrt(dx * dx + dy * dy) < r) {
      dragging = true;
      canvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!dragging || !ownTokenId)
      return;
    const pos = screenToImage(ev.clientX, ev.clientY);
    const token = tokens.get(ownTokenId);
    if (!token)
      return;
    token.x = pos.x;
    token.y = pos.y;
    render();
    const now = Date.now();
    if (onMoveCallback && now - lastMoveTime >= MOVE_INTERVAL) {
      onMoveCallback(pos.x, pos.y);
      lastMoveTime = now;
    }
  });
  canvas.addEventListener("pointerup", () => {
    if (!dragging || !ownTokenId)
      return;
    const token = tokens.get(ownTokenId);
    dragging = false;
    render();
    if (onMoveCallback && token) {
      onMoveCallback(token.x, token.y);
    }
  });
  return {
    addToken(token) {
      tokens.set(token.id, { ...token });
      render();
    },
    removeToken(tokenId) {
      tokens.delete(tokenId);
      render();
    },
    moveToken(tokenId, x, y) {
      const t = tokens.get(tokenId);
      if (t) {
        t.x = x;
        t.y = y;
        render();
      }
    },
    enableDrag(tokenId, onMove) {
      ownTokenId = tokenId;
      onMoveCallback = onMove;
    },
    render
  };
}

// public/js/api.ts
function gmHeaders(password) {
  return { "X-GM-Password": password };
}
async function checkOk(res) {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res;
}
async function getAdventure(adventureId, password) {
  const res = await fetch(`/api/adventures/${adventureId}`, {
    headers: gmHeaders(password)
  });
  return (await checkOk(res)).json();
}
async function uploadImage(adventureId, password, file) {
  const form = new FormData;
  form.append("file", file);
  const res = await fetch(`/api/adventures/${adventureId}/images`, {
    method: "POST",
    headers: gmHeaders(password),
    body: form
  });
  return (await checkOk(res)).json();
}
async function listImages(adventureId, password) {
  const res = await fetch(`/api/adventures/${adventureId}/images`, {
    headers: gmHeaders(password)
  });
  return (await checkOk(res)).json();
}
async function listImagesAsPlayer(adventureId, playerLink) {
  const res = await fetch(`/api/adventures/${adventureId}/images`, {
    headers: { "X-Player-Link": playerLink }
  });
  return (await checkOk(res)).json();
}

export { connectGM, connectPlayer, initCanvas, initTokenLayer, getAdventure, uploadImage, listImages, listImagesAsPlayer };
