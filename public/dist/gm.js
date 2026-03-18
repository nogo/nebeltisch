// public/js/websocket.ts
function connectGM(adventureId, password) {
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
  function buildUrl() {
    const u = new URL("/ws", window.location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.searchParams.set("adventureId", adventureId);
    u.searchParams.set("role", "gm");
    u.searchParams.set("password", password);
    return u.toString();
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

// public/js/canvas.ts
var FOG_ALPHA = 0.85;
var FOG_FILL = `rgba(0,0,0,${FOG_ALPHA})`;
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
function initCanvas(container) {
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
    fogCtx.fillStyle = FOG_FILL;
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
        id.data[i * 4 + 3] = Math.round(v * FOG_ALPHA);
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
        fogCtx.fillStyle = FOG_FILL;
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
    clear() {
      mapCtx.clearRect(0, 0, imgW, imgH);
      fogCtx.clearRect(0, 0, imgW, imgH);
      previewCtx.clearRect(0, 0, imgW, imgH);
    }
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

// public/js/gm.ts
var fragment = new URLSearchParams(location.hash.slice(1));
var adventureId = fragment.get("id") ?? "";
var password = fragment.get("password") ?? "";
if (!adventureId || !password) {
  document.body.innerHTML = '<p style="padding:2rem">Missing adventure ID or password. <a href="/">Return home</a></p>';
  throw new Error("Missing params");
}
var brushRadius = 50;
var brushMode = "reveal";
var activeImageId = null;
var imageList = [];
var adventureNameEl = document.getElementById("adventure-name");
var inviteLinkEl = document.getElementById("invite-link");
var copyInviteBtn = document.getElementById("copy-invite");
var brushSizeSlider = document.getElementById("brush-size");
var brushSizeLabel = document.getElementById("brush-size-label");
var modeRevealBtn = document.getElementById("mode-reveal");
var modeFogBtn = document.getElementById("mode-fog");
var gallery = document.getElementById("gallery");
var uploadInput = document.getElementById("upload-input");
var statusBar = document.getElementById("status-bar");
var canvasArea = document.getElementById("canvas-area");
var canvasCtrl = initCanvas(canvasArea);
var ws = connectGM(adventureId, password);
ws.on("connect", () => {
  statusBar.textContent = "";
});
ws.on("disconnect", () => {
  statusBar.textContent = "Reconnecting…";
});
ws.on("error", (msg) => {
  console.error("WS error", msg);
});
ws.on("joined", async (msg) => {
  const adv = msg.adventure;
  adventureNameEl.textContent = adv.name;
  try {
    const advData = await getAdventure(adventureId, password);
    const inviteUrl = `${location.origin}/player#link=${encodeURIComponent(advData.player_link)}`;
    inviteLinkEl.textContent = inviteUrl;
    copyInviteBtn.onclick = () => {
      navigator.clipboard.writeText(inviteUrl).catch(() => {});
    };
  } catch {}
  activeImageId = adv.activeImageId;
  imageList = await listImages(adventureId, password);
  renderGallery();
  if (activeImageId) {
    const img = imageList.find((i) => i.id === activeImageId);
    if (img) {
      await canvasCtrl.loadImage(`/uploads/${img.filename}`);
      if (typeof msg.fogMask === "string") {
        await canvasCtrl.applyFogMask(msg.fogMask);
      }
    }
  }
});
ws.on("fog:stroke", (msg) => {
  if (msg.imageId === activeImageId) {
    canvasCtrl.applyStroke(msg.stroke);
  }
});
ws.on("fog:stroke:batch", (msg) => {
  if (msg.imageId === activeImageId) {
    for (const stroke of msg.strokes) {
      canvasCtrl.applyStroke(stroke);
    }
  }
});
ws.on("map:switched", async (msg) => {
  activeImageId = msg.imageId;
  imageList = await listImages(adventureId, password);
  const img = imageList.find((i) => i.id === activeImageId);
  if (img) {
    await canvasCtrl.loadImage(`/uploads/${img.filename}`);
    if (typeof msg.fogMask === "string") {
      await canvasCtrl.applyFogMask(msg.fogMask);
    }
  }
  renderGallery();
});
function renderGallery() {
  gallery.innerHTML = "";
  for (const img of imageList) {
    const item = document.createElement("div");
    item.className = "gallery-item" + (img.id === activeImageId ? " active" : "");
    const thumb = document.createElement("img");
    thumb.src = `/uploads/${img.filename}`;
    thumb.alt = img.original_name;
    thumb.title = img.original_name;
    item.appendChild(thumb);
    item.addEventListener("click", () => {
      ws.send({ type: "map:switch", imageId: img.id });
    });
    gallery.appendChild(item);
  }
}
uploadInput.addEventListener("change", async () => {
  const file = uploadInput.files?.[0];
  if (!file)
    return;
  try {
    await uploadImage(adventureId, password, file);
    imageList = await listImages(adventureId, password);
    renderGallery();
  } catch (e) {
    console.error("Upload failed", e);
  }
  uploadInput.value = "";
});
brushSizeSlider.addEventListener("input", () => {
  brushRadius = parseInt(brushSizeSlider.value, 10);
  brushSizeLabel.textContent = `${brushRadius}px`;
});
function setMode(mode) {
  brushMode = mode;
  modeRevealBtn.classList.toggle("active", mode === "reveal");
  modeFogBtn.classList.toggle("active", mode === "fog");
}
modeRevealBtn.addEventListener("click", () => setMode("reveal"));
modeFogBtn.addEventListener("click", () => setMode("fog"));
var eventTarget = canvasCtrl.getEventTarget();
var isDrawing = false;
var pending = [];
var lastFlush = 0;
var FLUSH_INTERVAL = 1000 / 60;
function makeStroke(clientX, clientY) {
  const pos = canvasCtrl.screenToImage(clientX, clientY);
  return { x: pos.x, y: pos.y, radius: brushRadius, mode: brushMode };
}
function flushPending() {
  if (pending.length === 0)
    return;
  if (pending.length === 1) {
    ws.send({ type: "fog:stroke", stroke: pending[0] });
  } else {
    ws.send({ type: "fog:stroke:batch", strokes: pending.slice() });
  }
  pending.length = 0;
  lastFlush = Date.now();
}
eventTarget.addEventListener("pointerdown", (ev) => {
  if (!activeImageId)
    return;
  isDrawing = true;
  eventTarget.setPointerCapture(ev.pointerId);
  const stroke = makeStroke(ev.clientX, ev.clientY);
  canvasCtrl.applyStroke(stroke);
  pending.push(stroke);
  if (Date.now() - lastFlush >= FLUSH_INTERVAL)
    flushPending();
});
eventTarget.addEventListener("pointermove", (ev) => {
  const pos = canvasCtrl.screenToImage(ev.clientX, ev.clientY);
  canvasCtrl.drawBrushPreview(pos.x, pos.y, brushRadius);
  if (!isDrawing)
    return;
  const stroke = makeStroke(ev.clientX, ev.clientY);
  canvasCtrl.applyStroke(stroke);
  pending.push(stroke);
  if (Date.now() - lastFlush >= FLUSH_INTERVAL)
    flushPending();
});
eventTarget.addEventListener("pointerup", () => {
  if (!isDrawing)
    return;
  isDrawing = false;
  flushPending();
});
eventTarget.addEventListener("pointerleave", () => {
  canvasCtrl.clearBrushPreview();
  if (isDrawing) {
    isDrawing = false;
    flushPending();
  }
});
