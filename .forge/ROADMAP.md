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
- [ ] wu-01: Initialize project and server skeleton
- [ ] wu-02: Image upload and adventure API
- [ ] wu-03: Fog mask data model and persistence
- [ ] wu-04: WebSocket layer and real-time sync
- [ ] wu-05: GM frontend with canvas fog
- [ ] wu-06: Player frontend and token system
- [ ] wu-07: Docker and deployment
