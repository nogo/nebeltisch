# Nebeltisch — Idea list

> **Scope of this file:** unscheduled ideas only. Nothing here is committed, and nothing here is a source of truth.
>
> | Looking for | Read |
> |---|---|
> | Outcome, value, constraints, scope | [project.md](project.md) |
> | Stack, design decisions, principles | [architecture.md](architecture.md) |
> | Interface and interaction rules | [design.md](design.md) |
> | Current and planned work | GitHub issues |
>
> The former "Stack" and "Design Decisions" sections were removed on 2026-08-03: they were stale copies that contradicted `architecture.md`, including describing the fog mask as PNG when it is deflate-compressed.
>
> Ideas that have been taken seriously enough to specify have moved to GitHub issues. What remains is a holding pen.

---

## Out of scope, recorded for completeness

These conflict with the scope in [project.md](project.md) — a feature belonging to the *rules* of a game is out of scope. Listed so they are not re-proposed as if new.

- Dice roller — `/roll 3W20` chat with shared and whispered results
- Probe / Talent checks
- Initiative tracker
- Character portrait tokens, status marker icons

## Map and fog

- Fog shapes — rectangle and polygon reveal for whole rooms at once
- GM fog opacity slider — GM-only transparency to plan reveals through fog; players always see it opaque. Client-side only
- Grid overlay — toggleable hex or square grid, configurable cell size. DSA uses hex
- Ruler / distance tool — measured in Schritt, derived from grid scale
- Map annotations — GM-only text notes pinned to locations
- Map layers — background, middleground, foreground toggled independently
- Aventuria world map — preloaded, zoomable, fog persisting across sessions

## Session and data

- Session history — fog snapshots for rewind and branch
- Import / export — an adventure as a zip of maps, fog and tokens
- Audio ambience — GM links a sound that plays for everyone

## Done

- GM map tokens — monsters and NPCs placed below the fog layer, hidden until revealed
- Multiple adventures — now tracked as the GM account epic in GitHub issues
- Rename project — the project is Nebeltisch
