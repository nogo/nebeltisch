import type { ImageRecord } from './api';

/**
 * The adventure's board: every page laid out on one canvas, in board coordinates.
 *
 * The board is the world the GM's viewport pans over — page positions are plain layout and nothing
 * reads an order, an adjacency or a geography into them (#49).
 *
 * Only the *focused* page gets a canvas stack, drawn by `gm.ts` on top of this element. Every other
 * page is a plain `<img>` of the original upload: measured against the production adventures on
 * 2026-08-09, a six-page board is ~41 MB of decoded bitmap, which is why no thumbnail is stored.
 */

export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardController {
  element: HTMLElement;
  setPages(images: ImageRecord[]): void;
  /** The world the viewport fits and clamps to. */
  getWorldSize(): { w: number; h: number };
  rectOf(id: string): PageRect | null;
  pageAt(boardX: number, boardY: number): string | null;
  setSelected(id: string | null): void;
  setLive(id: string | null): void;
  /** The page the canvas stack covers: its flat image hides, its frame and labels stay. */
  setFocused(id: string | null): void;
  /** Keeps names, badges and outlines at a constant screen size, at every zoom (#50). */
  applyScale(scale: number): void;
  beginDrag(id: string, boardX: number, boardY: number): void;
  dragTo(boardX: number, boardY: number): void;
  /** The page's resting position, or null if nothing was being dragged. */
  endDrag(): { id: string; x: number; y: number } | null;
  isDragging(): boolean;
}

/**
 * A page whose dimensions were never parsed still needs a footprint on the board, or it collapses
 * to nothing and cannot be picked up. Mirrors `MIN_FOOTPRINT` in `src/board.ts` (#10).
 */
const MIN_FOOTPRINT = 512;

interface Page {
  id: string;
  name: string;
  el: HTMLElement;
  img: HTMLImageElement;
  chrome: HTMLElement;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function initBoard(container: HTMLElement): BoardController {
  const element = document.createElement('div');
  element.id = 'board';
  container.appendChild(element);

  let pages: Page[] = [];
  let selectedId: string | null = null;
  let liveId: string | null = null;
  let focusedId: string | null = null;
  let scale = 1;

  let drag: { page: Page; offsetX: number; offsetY: number; moved: boolean } | null = null;

  function position(page: Page) {
    page.el.style.left = `${page.x}px`;
    page.el.style.top = `${page.y}px`;
  }

  function buildPage(record: ImageRecord): Page {
    const el = document.createElement('div');
    el.className = 'board-page';
    el.dataset.id = record.id;

    const img = document.createElement('img');
    img.src = `/uploads/${record.filename}`;
    img.alt = record.original_name;
    img.draggable = false;
    el.appendChild(img);

    const chrome = document.createElement('div');
    chrome.className = 'board-page-chrome';
    const name = document.createElement('span');
    name.className = 'board-page-name';
    name.textContent = record.original_name;
    const badge = document.createElement('span');
    badge.className = 'board-page-live';
    badge.textContent = 'Live';
    chrome.append(name, badge);
    el.appendChild(chrome);

    element.appendChild(el);

    const page: Page = {
      id: record.id,
      name: record.original_name,
      el,
      img,
      chrome,
      x: record.board_x ?? 0,
      y: record.board_y ?? 0,
      width: record.width > 0 ? record.width : MIN_FOOTPRINT,
      height: record.height > 0 ? record.height : MIN_FOOTPRINT,
    };
    el.style.width = `${page.width}px`;
    el.style.height = `${page.height}px`;
    position(page);
    return page;
  }

  function applyState() {
    for (const page of pages) {
      page.el.classList.toggle('selected', page.id === selectedId);
      page.el.classList.toggle('live', page.id === liveId);
      page.el.classList.toggle('focused', page.id === focusedId);
    }
  }

  return {
    element,

    setPages(images) {
      // Rebuilt wholesale: an adventure holds a handful of pages, and a diff would only buy a
      // flicker-free upload at the cost of reconciling drag state against it. Only the page
      // elements go — the caller's canvas stack is a sibling in here and must survive.
      for (const page of pages) page.el.remove();
      pages = images.map(buildPage);
      applyState();
      this.applyScale(scale);
    },

    getWorldSize() {
      if (pages.length === 0) return { w: 0, h: 0 };
      let w = 0;
      let h = 0;
      for (const page of pages) {
        w = Math.max(w, page.x + page.width);
        h = Math.max(h, page.y + page.height);
      }
      return { w, h };
    },

    rectOf(id) {
      const page = pages.find((p) => p.id === id);
      return page ? { x: page.x, y: page.y, width: page.width, height: page.height } : null;
    },

    pageAt(boardX, boardY) {
      // Reverse order: later pages paint over earlier ones, so they win the hit test.
      for (let i = pages.length - 1; i >= 0; i--) {
        const p = pages[i];
        if (boardX >= p.x && boardX <= p.x + p.width && boardY >= p.y && boardY <= p.y + p.height) {
          return p.id;
        }
      }
      return null;
    },

    setSelected(id) {
      selectedId = id;
      applyState();
    },

    setLive(id) {
      liveId = id;
      applyState();
    },

    setFocused(id) {
      focusedId = id;
      applyState();
    },

    applyScale(next) {
      scale = next > 0 ? next : 1;
      const inverse = 1 / scale;
      for (const page of pages) {
        page.chrome.style.transform = `scale(${inverse})`;
        // An outline drawn in board units would vanish when zoomed out and swallow the page when
        // zoomed in. Two screen pixels, always.
        page.el.style.outlineWidth = `${2 * inverse}px`;
      }
    },

    beginDrag(id, boardX, boardY) {
      const page = pages.find((p) => p.id === id);
      if (!page) return;
      drag = { page, offsetX: boardX - page.x, offsetY: boardY - page.y, moved: false };
      page.el.classList.add('dragging');
    },

    dragTo(boardX, boardY) {
      if (!drag) return;
      // Clamped at the origin: the viewport's world runs from (0,0), so a page dragged negative
      // would sit outside every pan limit and become unreachable.
      drag.page.x = Math.max(0, boardX - drag.offsetX);
      drag.page.y = Math.max(0, boardY - drag.offsetY);
      drag.moved = true;
      position(drag.page);
    },

    endDrag() {
      if (!drag) return null;
      const { page, moved } = drag;
      page.el.classList.remove('dragging');
      drag = null;
      return moved ? { id: page.id, x: page.x, y: page.y } : null;
    },

    isDragging() {
      return drag !== null;
    },
  };
}
