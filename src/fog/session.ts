import type { Database } from "bun:sqlite";
import type { FogMask, FogStroke } from "../types";
import { getImage } from "../db/images";
import { repairImageDimensions } from "../images";
import { createMask, applyStrokes } from "./mask";
import { saveFogMask, loadFogMask, serializeMask } from "./serialize";

/**
 * Fog state is keyed by **map**: one mask and one undo history per image.
 * Its **lifetime** is scoped to the adventure, because nobody connects to a map —
 * connections carry an `adventureId`, and traversal between a village, its mill and
 * the cellar is the normal case, so a map the party may walk back into stays resident.
 *
 * Resident *count* is capped on top of that, because preparation touches every page of a board in
 * one sitting and idle disposal never fires during one — see `MAX_RESIDENT_MASKS`.
 *
 * See docs/architecture.md, "Fog state is per map, its lifetime is per adventure".
 */

/** Writes coalesce while the GM keeps painting. */
const SAVE_DEBOUNCE_MS = 500;

/** Snapshots kept per map. Trimming the oldest only limits how far undo reaches. */
const MAX_FOG_HISTORY = 40;

/**
 * How long an adventure with no connections keeps its masks in memory.
 *
 * Disposal always flushes to SQLite first, so no fog is ever lost — the only thing
 * a shorter window costs is the GM's undo history, which is memory-only. Zero
 * connections happens constantly during normal play (page reload, tablet sleep,
 * router blip), and every one of those reconnects within seconds. Ten minutes
 * covers those without pinning a finished session's memory for the week.
 */
const IDLE_DISPOSE_MS = 10 * 60 * 1000;

/**
 * How many of an adventure's masks stay resident at once.
 *
 * Preparation changed what grows here (principle 8). Play touches one or two pages an evening, and
 * idle disposal is per adventure — it frees nothing while a sitting is in progress. Preparing an
 * adventure invites touching *every* page in that one sitting, so the count of resident masks is
 * now bounded by the size of the board rather than by how many rooms the party walked through.
 *
 * Eight is chosen against the production adventures: six pages between 512×512 and 1536×1122, so a
 * whole one stays resident and the cap never bites during play. A 4K page is 12 MB of mask before
 * undo snapshots, which is where the ceiling matters — eight of those is the worst case, and a
 * thirty-page board no longer has one.
 *
 * Eviction is least-recently-opened and always flushes first, so nothing is lost but that page's
 * undo history, which is memory-only by design.
 */
const MAX_RESIDENT_MASKS = 8;

export interface FogHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

export interface FogSession {
  readonly imageId: string;
  /** Applies strokes to the mask and schedules the debounced persist. */
  applyStrokes(strokes: FogStroke[]): void;
  /** Records a completed brush action for undo. */
  commit(): void;
  /** Steps back one action. False when there is nothing to undo. */
  undo(): boolean;
  /** Steps forward one action. False when there is nothing to redo. */
  redo(): boolean;
  historyState(): FogHistoryState;
  toBase64(): Promise<string>;
  /** The live mask. For reads only — mutating it bypasses the persist schedule. */
  readMask(): FogMask;
  flush(): Promise<void>;
}

export interface AdventureFog {
  /**
   * Loads or creates the session for a map, with its history baseline seeded.
   * Opening past `MAX_RESIDENT_MASKS` flushes and drops the coldest map.
   */
  open(imageId: string): Promise<FogSession>;
  /** The already-open session for a map, or undefined. Never loads. */
  peek(imageId: string): FogSession | undefined;
  /** Undo availability for a map, open or not. */
  historyState(imageId: string): FogHistoryState;
  /** A connection arrived. Cancels any pending idle disposal. */
  retain(): void;
  /** A connection left. Schedules idle disposal once the count reaches zero. */
  release(): void;
  /** Flushes and drops one map — for image deletion. */
  evict(imageId: string): Promise<void>;
  /** Persists every pending save for this adventure, and no other. */
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

export interface FogRegistry {
  forAdventure(adventureId: string): AdventureFog;
  /** Persists every pending save in this registry. The shutdown path. */
  flushAll(): Promise<void>;
}

function createFogSession(db: Database, imageId: string, mask: FogMask): FogSession {
  // The last undo entry is always the current state, so the stack holds at least
  // the baseline and `length <= 1` means there is nothing to step back to.
  const undoStack: Uint8Array<ArrayBuffer>[] = [Bun.deflateSync(mask.data)];
  const redoStack: Uint8Array<ArrayBuffer>[] = [];
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveFogMask(db, imageId, mask).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  }

  function restore(snapshot: Uint8Array<ArrayBuffer>): void {
    mask.data.set(Bun.inflateSync(snapshot));
    scheduleSave();
  }

  return {
    imageId,

    applyStrokes(strokes) {
      applyStrokes(mask, strokes);
      scheduleSave();
    },

    commit() {
      undoStack.push(Bun.deflateSync(mask.data));
      while (undoStack.length > MAX_FOG_HISTORY + 1) undoStack.shift();
      redoStack.length = 0;
    },

    undo() {
      if (undoStack.length <= 1) return false;
      redoStack.push(undoStack.pop()!);
      restore(undoStack[undoStack.length - 1]);
      return true;
    },

    redo() {
      const snapshot = redoStack.pop();
      if (!snapshot) return false;
      undoStack.push(snapshot);
      restore(snapshot);
      return true;
    },

    historyState() {
      return { canUndo: undoStack.length > 1, canRedo: redoStack.length > 0 };
    },

    async toBase64() {
      return (await serializeMask(mask)).toString("base64");
    },

    readMask() {
      return mask;
    },

    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      await saveFogMask(db, imageId, mask);
    },
  };
}

function createAdventureFog(
  db: Database,
  uploadsDir: string | undefined,
  idleDisposeMs: number,
  maxResident: number,
  onDisposed: () => void
): AdventureFog {
  // Insertion order is the LRU order: every hit re-inserts, so the oldest key is the coldest map.
  const ready = new Map<string, FogSession>();
  // Keyed on the in-flight promise, not the result: `load` awaits, so two callers
  // arriving together would otherwise each build a mask and one set of strokes
  // would land on the object the other overwrote.
  const opening = new Map<string, Promise<FogSession>>();
  let connections = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  async function load(imageId: string): Promise<FogSession> {
    const loaded = await loadFogMask(db, imageId);
    if (loaded) return createFogSession(db, imageId, loaded);

    let image = getImage(db, imageId);
    if (!image) throw new Error(`Image ${imageId} not found`);
    if ((image.width === 0 || image.height === 0) && uploadsDir) {
      repairImageDimensions(db, imageId, uploadsDir);
      image = getImage(db, imageId) ?? image;
    }
    if (image.width === 0 || image.height === 0) {
      throw new Error(`Image ${imageId} has unknown dimensions; skipping fog mask`);
    }
    return createFogSession(db, imageId, createMask(image.width, image.height));
  }

  function cancelIdle(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  /** Re-inserts a session at the hot end of the LRU order. */
  function touch(imageId: string, session: FogSession): FogSession {
    ready.delete(imageId);
    ready.set(imageId, session);
    return session;
  }

  /** Flushes and drops the coldest maps until the resident count is back under the cap. */
  function trimResident(): void {
    while (ready.size > maxResident) {
      const coldest = ready.keys().next();
      if (coldest.done) return;
      void self.evict(coldest.value).catch(() => {});
    }
  }

  const self: AdventureFog = {
    open(imageId) {
      const open = ready.get(imageId);
      if (open) return Promise.resolve(touch(imageId, open));

      const inFlight = opening.get(imageId);
      if (inFlight) return inFlight;

      const promise = load(imageId)
        .then((session) => {
          opening.delete(imageId);
          ready.set(imageId, session);
          // Bounded here rather than on release: preparation keeps opening maps without ever
          // leaving the adventure, so idle disposal is not the eviction path that applies.
          trimResident();
          return session;
        })
        .catch((err) => {
          // Dropped so a later call can retry — a map whose dimensions were
          // unreadable now may be repairable after the next upload.
          opening.delete(imageId);
          throw err;
        });
      opening.set(imageId, promise);
      return promise;
    },

    peek(imageId) {
      const session = ready.get(imageId);
      return session ? touch(imageId, session) : undefined;
    },

    historyState(imageId) {
      return ready.get(imageId)?.historyState() ?? { canUndo: false, canRedo: false };
    },

    retain() {
      connections++;
      cancelIdle();
    },

    release() {
      connections = Math.max(0, connections - 1);
      if (connections > 0) return;
      cancelIdle();
      idleTimer = setTimeout(() => {
        idleTimer = null;
        void self.dispose();
      }, idleDisposeMs);
      // A table that ended must never hold the process open.
      idleTimer.unref?.();
    },

    async evict(imageId) {
      const session = ready.get(imageId);
      if (!session) {
        opening.delete(imageId);
        return;
      }
      ready.delete(imageId);
      await session.flush();
    },

    async flush() {
      await Promise.all([...ready.values()].map((session) => session.flush()));
    },

    async dispose() {
      cancelIdle();
      const sessions = [...ready.values()];
      ready.clear();
      opening.clear();
      await Promise.all(sessions.map((session) => session.flush()));
      onDisposed();
    },
  };

  return self;
}

export interface FogRegistryOptions {
  /** Overrides the idle grace period. Tests use a few milliseconds. */
  idleDisposeMs?: number;
  /** Overrides how many masks per adventure stay resident. Tests use one or two. */
  maxResidentMasks?: number;
}

export function createFogRegistry(
  db: Database,
  uploadsDir?: string,
  options: FogRegistryOptions = {}
): FogRegistry {
  const idleDisposeMs = options.idleDisposeMs ?? IDLE_DISPOSE_MS;
  const maxResident = Math.max(1, options.maxResidentMasks ?? MAX_RESIDENT_MASKS);
  const adventures = new Map<string, AdventureFog>();

  return {
    forAdventure(adventureId) {
      let fog = adventures.get(adventureId);
      if (!fog) {
        fog = createAdventureFog(db, uploadsDir, idleDisposeMs, maxResident, () =>
          adventures.delete(adventureId)
        );
        adventures.set(adventureId, fog);
      }
      return fog;
    },

    async flushAll() {
      await Promise.all([...adventures.values()].map((fog) => fog.flush()));
    },
  };
}
