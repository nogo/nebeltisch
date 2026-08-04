# Nebeltisch — Architecture

> **Scope of this file:** stack, structure, data model, design decisions and the principles that govern new code.
> *Why the project exists* is in [project.md](project.md). *How the interface behaves* is in [design.md](design.md).
> When a decision here is reversed, edit the decision in place and state what replaced it. Do not leave two answers.

---

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Bun | Raw `Bun.serve()`, no HTTP framework |
| Database | `bun:sqlite` | WAL mode, foreign keys on |
| Realtime | Bun native WebSocket pub/sub | One topic per adventure: `adventure:${id}` |
| Frontend | Vanilla TypeScript + HTML5 Canvas | Bundled by `bun build --splitting` |
| Deployment | Docker | One container, one volume at `DATA_DIR` |

**Runtime dependencies: none.** `@types/bun` is the only entry in `package.json`, and it is a devDependency. Adding a runtime dependency is a decision that needs justifying against [Principles](#principles).

## Module map

Server — `src/`

| Path | Responsibility |
|---|---|
| `index.ts` | The composition root: builds `ServerDeps`, runs `Bun.serve()`, routes `/ws` to the upgrade handler and everything else to `routes.ts`, flushes fog on SIGINT/SIGTERM |
| `deps.ts` | `ServerDeps` — the database, uploads directory and fog registry, built once and passed down |
| `routes.ts` | HTTP routing by path segments, static files, REST endpoints |
| `images.ts` | Image dimensions from file headers (PNG/JPEG/WebP). Pure parsing plus a repair path; used by both `routes.ts` and `fog/` |
| `types.ts` | Shared domain types: `FogMask`, `FogStroke`, `Adventure`, `ImageRecord`, `Token`, `WsData` |
| `db/database.ts` | Opens the database and applies the schema |
| `db/schema.ts` | DDL plus additive migrations |
| `db/adventures.ts`, `db/images.ts`, `db/tokens.ts` | Query functions, one file per table group |
| `fog/mask.ts` | Pure mask operations. No I/O, no database, no canvas |
| `fog/serialize.ts` | Mask binary format and persistence |
| `fog/session.ts` | Live fog state: mask cache, undo history, debounced saves, and their lifetime |
| `ws/handler.ts` | Connection lifecycle, message dispatch, token placement |
| `ws/messages.ts` | `ClientMessage` and `ServerMessage` unions — the wire contract |
| `ws/connections.ts` | In-memory registry of live sockets |

Client — `public/js/`

| Path | Responsibility |
|---|---|
| `gm.ts`, `player.ts` | Entry points; own all UI state for their role |
| `canvas.ts` | Map, fog and brush-preview canvases; fog compositing and mask decoding |
| `viewport.ts` | Pan, zoom, and pointer gesture disambiguation |
| `tokens.ts` | A token layer; hit testing and dragging |
| `ping.ts` | Ping layer; owns its own animation loop |
| `api.ts` | REST client |
| `websocket.ts` | WebSocket client with reconnect and backoff; typed against the server's message unions |

`test/` mirrors `src/`.

## Data model

```
adventures ──< images ──< token_positions >── tokens
     └────────────────< tokens
```

| Table | Key columns | Notes |
|---|---|---|
| `adventures` | `gm_password`, `player_link`, `active_image_id`, `token_size` | `active_image_id` is what players see |
| `images` | `filename`, `width`, `height`, `fog_mask` BLOB, `sort_order`, `start_x`, `start_y` | One fog mask per map. `start_*` null means "use map centre" |
| `tokens` | `token_type`, `player_link`, `image_id`, `x`, `y` | See token rules below |
| `token_positions` | `(token_id, image_id)` PK, `x`, `y` | Where each token last stood on each map |

### Token rules

| Kind | `token_type` | `image_id` | `player_link` |
|---|---|---|---|
| Player | `player` | NULL — exists on every map | `${playerLink}\|${playerName}` |
| Monster / NPC | `monster` / `npc` | Set — belongs to one map | NULL |

Player identity is the composite `playerLink|playerName`. Same link and same name reconnects to the same token; a different name creates a new one.

### Arrival and return

- **Start point governs arrival:** first entry to a map, and every late joiner.
- **`token_positions` governs return:** coming back restores where each player stood.

Both rules are specified in full, with acceptance criteria, in #36 — closed, so the criteria there are the record of what was actually built.

## Design decisions

Each decision states what was chosen, why, and what it commits the code to.

### No framework

`Bun.serve()` handles HTTP and WebSocket directly. Under a dozen REST routes do not justify a router dependency.
**Implication:** routing is manual path-segment matching in `routes.ts`. Adding routes means extending that chain.

### Fog mask is a `Uint8Array`

One byte per pixel: `255` fogged, `0` revealed. All reveal/re-fog logic is pure functions in `fog/mask.ts`.
**Implication:** fog is testable without a browser or a canvas, and `fog/mask.ts` must stay free of I/O.

### Fog persistence is a custom binary format, not PNG

8-byte header (width, height as `uint32` big-endian) followed by `Bun.deflateSync` of the mask, stored as a BLOB in `images.fog_mask`.
**Why:** a mostly-uniform mask deflates to a few kilobytes, and encoding a PNG server-side would need an image library — see the zero-dependency rule.
**Implication:** the client decodes with `DecompressionStream` in `canvas.ts`.

### Hybrid fog sync

Brush strokes stream over WebSocket for immediate feedback on every client. The authoritative mask lives in a server-side cache and is written to SQLite on a debounce.
**Implication:** late joiners and restarts read the persisted mask, not a replay of strokes.

### Fog state is keyed by map; its lifetime is scoped to the adventure

`fog/session.ts` holds one `FogSession` per image — mask, undo history, pending save — grouped under an `AdventureFog` per adventure, in a registry built once in `index.ts` and passed as `ServerDeps`.

**Why the two levels.** The mask belongs to a map. The *lifetime* cannot: nobody connects to a map, connections carry an `adventureId`, and traversal between a village, its mill and the cellar is the normal case, so a map the party may walk back into must stay resident.

Disposal is idle-triggered. When the last connection to an adventure leaves, a timer starts; a reconnect cancels it; expiry flushes every mask to SQLite and frees them. It is delayed rather than immediate because zero-connection moments happen constantly during play — page reload, tablet sleep, router blip — and undo history is memory-only, so instant disposal would silently empty the GM's undo stack on every refresh. `IDLE_DISPOSE_MS` is ten minutes; it is a comfort setting, not a correctness one, since disposal always persists first.

**Implication:** nothing about fog lives at module scope. New per-map state belongs on `FogSession` and inherits its eviction for free. Mutating a mask outside `applyStrokes` skips the debounced save.

### The server owns fog undo history

Undo history is a per-image stack of deflated mask snapshots in `ws/handler.ts`, not a stroke list in the browser.
**Why:** a client-held history is empty after a page reload, so undoing from it rebuilt the mask from nothing and erased the whole map. This was a real data-loss bug.
**Implication:** the client sends `fog:action:end`, `fog:undo` and `fog:redo`, and takes button state from `fog:history`. It holds no history of its own. Trimming the oldest snapshot limits how far undo reaches and never alters the mask.

### Canvas compositing for fog

`destination-out` to reveal, `source-over` to re-fog. The GM's fog canvas is made semi-transparent with CSS opacity so the stored alpha stays absolute.
**Implication:** never lower the fog canvas alpha in drawing operations — re-fogging would stack unevenly.

### Layered canvases

Map → GM tokens → fog → player tokens → pings, stacked in an image-sized wrapper that a CSS transform pans and zooms.
**Why:** GM tokens below the fog are hidden until the area is revealed, for free.
**Implication:** the wrapper is sized in image pixels, so layer contents are drawn in image coordinates.

### The client imports the wire contract; it does not restate it

`public/js/websocket.ts` imports `ClientMessage` and `ServerMessage` from `src/ws/messages.ts` with `import type`, and `on()` is generic over the union: `ws.on('map:switched', msg => …)` gives `msg` the exact `MapSwitchedMessage` shape.
**Why:** the client used to re-declare each payload inline at the call site — roughly thirty hand-written casts — and they drifted from the server without anything failing. `import type` is erased at build, so no server code enters the bundle.
**Implication:** a field the server does not send, and a `send()` of a message outside `ClientMessage`, are both compile errors. New wire messages must be added to the union before either side can use them, which is principle 4 extended across the boundary.

### REST DTOs are deliberately not shared

`Adventure` and `ImageRecord` in `public/js/api.ts` stay separate from the same-named row types in `src/types.ts`.
**Why:** those are database rows. The routes return whole rows today — that is the leak in #5 — so sharing them would make it the contract instead of a bug, and `fog_mask: Buffer` has no meaning in a browser.
**Implication:** the client types describe what a client is entitled to. When #5 is fixed the server response narrows to meet them, rather than the client widening to match the table.

### No CRDT

The GM is the only writer of fog. Each player writes only their own token. The server rejects anything else.
**Implication:** no conflict resolution anywhere. Preserve this invariant — shared write access to one object would invalidate the whole synchronisation model.

### One canvas, shared by GM and players

The GM's canvas *is* the players' canvas. There is no separate editing context.
**Why:** preparation happens before players join, so mid-session editing of an unseen map is not a requirement. Two contexts would let the GM paint fog onto the wrong map, unnoticed, mid-session.
**Implication:** GM edit operations target `adventures.active_image_id`. The per-map start point is the deliberate exception, since it must be settable during preparation without showing the map.

### Lightweight auth

The GM password travels in a URL fragment and is stored in plaintext; players authenticate with an invite link. No accounts.
**Implication:** this is adequate for a self-hosted group and insufficient for anything public. A GM account is planned and will not change how players join.

### Additive, idempotent migrations

Schema changes are `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS` statements wrapped in try/catch in `db/schema.ts`, run on every start.
**Why:** no migration tool, no version table, no deploy step.
**Implication:** columns may be added and tables created; they may not be renamed, dropped or retyped. Never write a destructive migration.

---

## Principles

Rules for new code. Where a change conflicts with one of these, the conflict is the thing to discuss.

**A principle is a rule, not a claim about the code.** Most were written the day something violated
them, and one is still violated today — it says so and names the issue. A principle marked
**[violated]** binds new code exactly as hard as the others; it just means the existing breach is
tracked rather than forgotten. When the issue closes, remove the marker.

### 1. The server is authoritative for anything that outlives a browser tab

Fog, tokens, positions, history. If state must survive a reload, the browser may cache it but must never be its source.
*This principle exists because undo violated it and destroyed a session's fog.*

### 2. Client optimism is for feedback, never for truth

Render the drag immediately, then reconcile with the server broadcast. Never let the optimistic value become the stored one.
*The GM saw monster tokens move for a month while no one else did, because the local render was mistaken for a working feature.*

### 3. Anything testable without a DOM is a pure function

`fog/mask.ts` and `scatterPositions` take values and return values. Keep new logic of that shape out of handlers and event listeners.

### 4. Every wire message belongs to the union

`ClientMessage` and `ServerMessage` in `ws/messages.ts` are the contract. A handler case whose type is absent from the union narrows to `never` and silently loses all type checking.
*Two message types shipped this way and their entire handler ran unchecked.*

**This is the one principle that enforces itself, on both sides.** `bun test` runs `tsc --noEmit` first over `src`, `test` and `public/js`, and the client imports the unions rather than restating them. A handler case with no union member, a client reading a field the server does not send, and a `send()` outside `ClientMessage` all fail the suite before a single test executes. The rule went unenforced for months precisely because nothing typechecked (#6, #7); do not remove that gate.

### 5. Touch targets have a screen-space floor

Hit tests computed in image coordinates shrink as the map zooms out. Any interactive target needs a minimum measured in screen pixels — 22px radius, per the 44pt guidance in design.md.
*A 20px token was an 8px tap target at fit zoom, which made the tablet unusable.*

### 6. Broadcast derived state; do not recompute it per client

If two clients could compute a value differently — a phase, a position, a mask — the server computes it once and sends the result.

### 7. Prefer the smallest change that fully solves the problem

No dependency without a strong reason. No abstraction before a second use. No refactor bundled into a fix.

### 8. Bound anything that grows

Caches keyed by id accumulate for the process lifetime unless evicted. New per-entity state needs an eviction path from the start — decided when the state is introduced, not bolted on later.

Fog was the case that proved it: masks, histories and save timers sat at module scope in `ws/handler.ts` with no eviction at all, so one 4000×3000 map was 12 MB resident forever. They now live on `FogSession`, whose lifetime is the adventure's — see the decision above.

### 9. Never trust a client-supplied array to be small **[violated — #12]**

`fog:stroke:batch` and similar messages carry unbounded arrays that are replayed server-side. Validate shape and cap length.

`parseMessage` still casts without checking any field, and neither `fog:stroke:batch` nor `fog:undo` is capped. Both paths are GM-authenticated, which bounds the blast radius to a GM degrading their own table — it does not make the arrays bounded.

### 10. Verify against reality before building on an assumption

Measure the actual data, read the actual file, run the actual query. Several hours have been spent on hypotheses that a single measurement falsified.
