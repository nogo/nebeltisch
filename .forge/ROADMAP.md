# Fog of War — Roadmap

## What
A collaborative tabletop tool for remote pen & paper RPGs. GM creates an adventure, uploads map images (each with its own fog layer), reveals/re-fogs areas with a round brush, and controls which map players see. Players join via share link, pick name + color, and move their own token on the active map.

## Stack
- **Runtime:** Bun (no framework — raw `Bun.serve()`)
- **Database:** bun:sqlite with WAL mode
- **WebSocket:** Bun native pub/sub
- **Frontend:** Vanilla TypeScript + HTML5 Canvas
- **Deployment:** Docker

## Design Decisions
- **No framework.** Bun.serve() handles HTTP + WS. 5 REST routes don't justify a dependency.
- **Fog sync: hybrid.** Stream brush strokes over WS for instant feedback. Persist fog mask as PNG on server for late joiners and restarts.
- **Fog mask = Uint8Array.** Pure functions for reveal/re-fog — testable without browser canvas.
- **Canvas compositing.** `destination-out` to reveal, `source-over` to re-fog.
- **No CRDT.** GM is sole fog writer, each player owns only their token. No conflict resolution needed.
- **Auth: lightweight.** GM link with password, player share link with name+color on join. No accounts.

## Status
- [x] Discovery complete
- [x] wu-01: Initialize project and server skeleton
- [x] wu-02: Image upload and adventure API
- [x] wu-03: Fog mask data model and persistence
- [x] wu-04: WebSocket layer and real-time sync
- [x] wu-05: GM frontend with canvas fog
- [x] wu-06: Player frontend and token system
- [x] wu-07: Docker and deployment
- [x] wu-08: Fix fog mask persistence on reload
- [x] wu-09: (reserved)
- [ ] wu-10: Add pan and zoom with touch gestures
- [ ] wu-11: Make tokens persistent and add player management
- [ ] wu-12: Redesign GM and Player UI with floating controls
- [ ] wu-13: Redesign home page with matching visual language
- [ ] wu-14: Add undo and redo for fog strokes
- [ ] wu-15: Add player ping marker

## Future Improvements
- **GM fog opacity slider** — adjustable transparency (0–100%) on the fog layer, GM-only. Lets the GM peek through fog to plan reveals. Players always see fully opaque fog. Pure client-side, no server changes needed.
- **GM map tokens** — GM can place tokens (monsters, NPCs, treasure, traps) on the map below the fog layer. Hidden until fog is revealed. Rendered between map and fog canvas.
- **Rename project** — pick final name (Nebeltisch is a candidate).

## Maybe (post-PoC)
- Fog shapes — rectangle and polygon reveal for entire rooms
- Grid overlay — toggleable hex or square grid, configurable cell size (DSA uses hex)
- Ruler/distance tool — measure in Schritt based on grid scale
- Map annotations — GM-only text notes pinned to locations
- Dice roller — integrated `/roll 3W20` chat with shared/whispered results
- Character portrait tokens — upload image instead of colored circle
- Status markers — condition icons (wounded, poisoned) snapped to tokens
- Multiple adventures — GM dashboard
- Session history — fog snapshots for rewind/branch
- Map layers — background, middleground, foreground independently toggleable
- Initiative tracker — ordered token list for combat rounds
- Audio ambience — GM links ambient sound that plays for all
- Import/export — adventure as zip (maps + fog + tokens)
- Aventuria world map — preloaded, zoomable, persistent fog across sessions
- Probe/Talent checks — quick 3W20 talent check without full character sheet
