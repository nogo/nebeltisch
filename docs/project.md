# Project

## Goal
A collaborative tabletop tool for remote pen & paper RPGs. The GM creates an adventure, uploads map images (each with its own fog layer), reveals or re-fogs areas with a round brush, and controls which map players see. Players join via a share link, pick a name and color, and move their own token on the active map.

The project is opinionated toward German-language RPGs (e.g. *Das Schwarze Auge* / Aventuria — Schritt, W20, hex grids), but is system-agnostic at the data layer.

## Stack
- **Runtime:** Bun (no framework — raw `Bun.serve()`)
- **Database:** `bun:sqlite` with WAL mode
- **WebSocket:** Bun native pub/sub
- **Frontend:** Vanilla TypeScript + HTML5 Canvas
- **Deployment:** Docker

## Design decisions
- **No framework.** `Bun.serve()` handles HTTP + WS; a handful of REST routes don't justify a dependency.
- **Hybrid fog sync.** Brush strokes stream over WebSocket for instant feedback; the fog mask is persisted as PNG on the server for late joiners and restarts.
- **Fog mask = `Uint8Array`.** Pure functions for reveal/re-fog — testable without a browser canvas.
- **Canvas compositing.** `destination-out` to reveal, `source-over` to re-fog.
- **No CRDT.** GM is the sole fog writer; each player owns only their own token. No conflict resolution required.
- **Lightweight auth.** GM link with password, player share link with name+color on join. No accounts.

## Scope
In scope: maps, fog brush, undo/redo, player tokens, pings, pan/zoom, GM/player UIs, Docker deploy.

Out of scope (for now): dice rolling, character sheets, initiative, audio, multi-adventure dashboard, session history. See `.forge/ROADMAP.md` for the deferred list.

## Naming
The project is called **Nebeltisch** — German for "fog table". It ties cleanly to the DSA/Aventuria audience and reads as a noun (a thing you sit around). Distinctive, unclaimed in the RPG-tooling space, and matches the target audience's language.
