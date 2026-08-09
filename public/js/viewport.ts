/**
 * What is worth looking at, in world coordinates. A player's is their page, at the origin. The
 * GM's is the bounding box of every page on the board, which can start at a negative coordinate.
 */
export interface WorldBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * An unbounded viewport is a canvas, not a page: zoom is an absolute range and panning is free, so
 * what happens to be on it never decides how far the GM can pull back. Roughly Miro's range.
 */
const MIN_SCALE = 0.02;
const MAX_SCALE = 4;

export interface Viewport {
  readonly scale: number;
  readonly panX: number;
  readonly panY: number;
  /** Screen coordinates to world coordinates. The GM's world is the board; the player's is a page. */
  screenToImage(clientX: number, clientY: number): { x: number; y: number };
  attach(
    container: HTMLElement,
    wrapper: HTMLElement,
    getWorldBounds: () => WorldBounds,
    options?: {
      /**
       * Bounded (the default) is the player's map: you cannot zoom out past it filling the screen,
       * and you cannot pan it off the edge. Unbounded is the GM's board — see `MIN_SCALE` above.
       */
      bounded?: boolean;
    }
  ): void;
  /** Frames the world bounds. On an unbounded viewport this is the only way back to the content. */
  resetView(): void;
  onChange(callback: () => void): void;
  // Fires for all single-pointer moves (hover + drag). Caller checks own state.
  onPointerMove(callback: (ev: PointerEvent) => void): void;
  // Fires when grace period expires with 1 pointer — interact mode confirmed.
  onInteractStart(callback: (ev: PointerEvent) => void): void;
  // Fires when interact pointer lifts.
  onInteractEnd(callback: () => void): void;
  // Fires when pointer leaves the area.
  onPointerLeave(callback: () => void): void;
}

export function createViewport(): Viewport {
  let _scale = 1;
  let _panX = 0;
  let _panY = 0;
  let _container: HTMLElement | null = null;
  let _wrapper: HTMLElement | null = null;
  let _getWorldBounds: (() => WorldBounds) | null = null;
  let _bounded = true;

  const changeCbs: Array<() => void> = [];
  const moveCbs: Array<(ev: PointerEvent) => void> = [];
  const startCbs: Array<(ev: PointerEvent) => void> = [];
  const endCbs: Array<() => void> = [];
  const leaveCbs: Array<() => void> = [];

  function applyTransform() {
    if (_wrapper) {
      _wrapper.style.transform = `translate(${_panX}px,${_panY}px) scale(${_scale})`;
    }
    for (const cb of changeCbs) cb();
  }

  /** The scale at which the whole world fits the container. A limit only when bounded. */
  function computeFitScale(): number {
    if (!_container || !_getWorldBounds) return 1;
    const { w, h } = _getWorldBounds();
    if (w === 0 || h === 0) return 1;
    const cw = _container.clientWidth || 800;
    const ch = _container.clientHeight || 600;
    return Math.min(cw / w, ch / h);
  }

  function clampScale(s: number): number {
    if (!_bounded) return Math.min(Math.max(MIN_SCALE, s), MAX_SCALE);
    const fit = computeFitScale();
    return Math.min(Math.max(fit, s), fit * 10);
  }

  function clampPan() {
    // A canvas does not push back. `resetView` is what brings the GM home instead.
    if (!_bounded || !_container || !_getWorldBounds) return;
    const { x, y, w, h } = _getWorldBounds();
    const cw = _container.clientWidth;
    const ch = _container.clientHeight;
    // Never let more than half the container sit past either edge of the world.
    _panX = Math.min(cw / 2 - x * _scale, Math.max(cw / 2 - (x + w) * _scale, _panX));
    _panY = Math.min(ch / 2 - y * _scale, Math.max(ch / 2 - (y + h) * _scale, _panY));
  }

  // --- Pointer state ---
  interface PPos { x: number; y: number }
  const pointers = new Map<number, PPos>();
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let gracePendingEv: PointerEvent | null = null;
  let interacting = false;
  let panActive = false;
  let prevMidX = 0, prevMidY = 0, prevDist = 0;

  function getMid() {
    const pts = [...pointers.values()];
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }

  function getPinchDist() {
    const pts = [...pointers.values()];
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Controls that live inside the transformed world still need ordinary DOM input. The viewport
   * listens in the capture phase, so without this opt-out it would swallow their pointer sequence
   * before a button could produce a click.
   */
  function isViewportControl(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('[data-viewport-control]') !== null;
  }

  function cancelGrace() {
    if (graceTimer !== null) { clearTimeout(graceTimer); graceTimer = null; }
    gracePendingEv = null;
  }

  function commitInteract() {
    interacting = true;
    if (gracePendingEv) {
      try { _container?.setPointerCapture(gracePendingEv.pointerId); } catch {}
      const ev = gracePendingEv;
      gracePendingEv = null;
      for (const cb of startCbs) cb(ev);
    }
  }

  function stopInteract() {
    if (interacting) {
      interacting = false;
      for (const cb of endCbs) cb();
    }
  }

  function initPanZoom() {
    panActive = true;
    const mid = getMid();
    prevMidX = mid.x;
    prevMidY = mid.y;
    prevDist = getPinchDist();
  }

  function onDown(ev: PointerEvent) {
    if (isViewportControl(ev.target)) return;
    ev.preventDefault();
    ev.stopPropagation();
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (pointers.size === 1) {
      if (ev.button === 1 || ev.button === 2) {
        // Middle or right mouse — pan immediately
        panActive = true;
        prevMidX = ev.clientX;
        prevMidY = ev.clientY;
        try { _container?.setPointerCapture(ev.pointerId); } catch {}
      } else if (ev.pointerType === 'mouse') {
        // Mouse — commit immediately (no pinch-zoom ambiguity)
        gracePendingEv = ev;
        commitInteract();
      } else {
        // Touch — start grace period to distinguish from pinch-zoom
        gracePendingEv = ev;
        graceTimer = setTimeout(() => {
          graceTimer = null;
          if (pointers.size === 1 && !panActive) commitInteract();
        }, 100);
      }
    } else if (pointers.size === 2) {
      // Second finger — cancel grace/interact, start pan/zoom
      cancelGrace();
      stopInteract();
      initPanZoom();
      for (const [id] of pointers) {
        try { _container?.setPointerCapture(id); } catch {}
      }
    }
  }

  function onMove(ev: PointerEvent) {
    if (isViewportControl(ev.target)) return;
    if (!pointers.has(ev.pointerId)) {
      // Hover (no button pressed) — forward for brush preview
      if (pointers.size === 0) {
        for (const cb of moveCbs) cb(ev);
      }
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (panActive) {
      if (pointers.size >= 2) {
        // Pinch + pan
        const mid = getMid();
        const dist = getPinchDist();
        const dx = mid.x - prevMidX;
        const dy = mid.y - prevMidY;
        const factor = prevDist > 0 ? dist / prevDist : 1;
        const newScale = clampScale(_scale * factor);
        const af = newScale / _scale;
        if (_container) {
          const rect = _container.getBoundingClientRect();
          const fx = prevMidX - rect.left;
          const fy = prevMidY - rect.top;
          _panX = fx - af * (fx - _panX) + dx;
          _panY = fy - af * (fy - _panY) + dy;
        }
        _scale = newScale;
        prevMidX = mid.x;
        prevMidY = mid.y;
        prevDist = dist;
      } else {
        // Middle mouse single-pointer pan
        _panX += ev.clientX - prevMidX;
        _panY += ev.clientY - prevMidY;
        prevMidX = ev.clientX;
        prevMidY = ev.clientY;
      }
      clampPan();
      applyTransform();
      return;
    }

    // Single-pointer interact or grace — fire move callbacks for brush preview / drawing
    if (pointers.size === 1) {
      for (const cb of moveCbs) cb(ev);
    }
  }

  function onUp(ev: PointerEvent) {
    if (isViewportControl(ev.target)) return;
    ev.stopPropagation();
    pointers.delete(ev.pointerId);
    cancelGrace();
    stopInteract();

    if (pointers.size < 2) {
      panActive = false;
    }
    if (pointers.size === 1 && !interacting) {
      // Dropped from 2 to 1 — reinitialize for single-pointer pan if still panning
      const pts = [...pointers.values()];
      prevMidX = pts[0].x;
      prevMidY = pts[0].y;
    }
  }

  function onLeave(ev: PointerEvent) {
    if (isViewportControl(ev.target)) return;
    // Ignore pointerleave on descendant elements — these fire as boundary
    // events when setPointerCapture redirects the pointer to the container.
    if (ev.target !== _container) return;
    ev.stopPropagation();
    const wasInteracting = interacting;
    pointers.delete(ev.pointerId);
    cancelGrace();
    if (interacting) stopInteract();
    if (pointers.size === 0) {
      panActive = false;
    }
    if (wasInteracting || (!panActive && pointers.size === 0)) {
      for (const cb of leaveCbs) cb();
    }
  }

  return {
    get scale() { return _scale; },
    get panX() { return _panX; },
    get panY() { return _panY; },

    screenToImage(clientX, clientY) {
      const rect = _container!.getBoundingClientRect();
      return {
        x: (clientX - rect.left - _panX) / _scale,
        y: (clientY - rect.top - _panY) / _scale,
      };
    },

    attach(container, wrapper, getWorldBounds, options) {
      _container = container;
      _wrapper = wrapper;
      _getWorldBounds = getWorldBounds;
      _bounded = options?.bounded !== false;
      wrapper.style.transformOrigin = '0 0';
      wrapper.style.willChange = 'transform';

      container.addEventListener('pointerdown', onDown, { capture: true });
      container.addEventListener('pointermove', onMove, { capture: true });
      container.addEventListener('pointerup', onUp, { capture: true });
      container.addEventListener('pointercancel', onUp, { capture: true });
      container.addEventListener('pointerleave', onLeave, { capture: true });

      // Suppress context menu so right-click drag works for panning
      container.addEventListener('contextmenu', (ev) => ev.preventDefault());

      container.addEventListener('wheel', (ev: WheelEvent) => {
        ev.preventDefault();
        const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
        const rect = container.getBoundingClientRect();
        const fx = ev.clientX - rect.left;
        const fy = ev.clientY - rect.top;
        const newScale = clampScale(_scale * factor);
        const af = newScale / _scale;
        _panX = fx - af * (fx - _panX);
        _panY = fy - af * (fy - _panY);
        _scale = newScale;
        clampPan();
        applyTransform();
      }, { passive: false });
    },

    resetView() {
      if (!_container || !_getWorldBounds) return;
      const { x, y, w, h } = _getWorldBounds();
      if (w === 0 || h === 0) return;
      const cw = _container.clientWidth || 800;
      const ch = _container.clientHeight || 600;
      // Clamped, so a board too large to fit at MIN_SCALE still lands somewhere legal.
      const fit = clampScale(Math.min(cw / w, ch / h));
      _scale = fit;
      _panX = (cw - w * fit) / 2 - x * fit;
      _panY = (ch - h * fit) / 2 - y * fit;
      applyTransform();
    },

    onChange(cb) { changeCbs.push(cb); },
    onPointerMove(cb) { moveCbs.push(cb); },
    onInteractStart(cb) { startCbs.push(cb); },
    onInteractEnd(cb) { endCbs.push(cb); },
    onPointerLeave(cb) { leaveCbs.push(cb); },
  };
}
