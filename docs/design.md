# Nebeltisch — Design Intent

> **Scope of this file:** interface and interaction rules — layout, gestures, visual language.
> *Why the project exists* is in [project.md](project.md). *How it is built* is in [architecture.md](architecture.md).
> Sections marked **[not implemented]** describe intent that no code yet fulfils.

> The map IS the interface. Everything else gets out of the way.

---

## Core Principle

Full-canvas experience. Controls float at the edges — translucent, collapsible, Miro-style. GM and Player don't share a layout, but they share this visual language. The map dominates every pixel.

---

## Target Devices

| Device | Role | Input | Priority |
|--------|------|-------|----------|
| Desktop | GM (primary) | Mouse | High |
| Tablet | Player (primary), GM | Touch + stylus | High |
| Phone | Not a map device | — | — |

**The group's phones run the voice call, so they are unavailable for the map.** The tablet is the only device players actually use. Touch is a primary input mode, not a fallback: any interactive target must clear a screen-space minimum regardless of zoom (see Visual Language).

GM fog painting on a phone is not a goal. Tablet with stylus is.

---

## Gesture Map

| Gesture | Action |
|---------|--------|
| 1 finger / stylus | Interact — GM: paint fog; Player: drag token |
| 2-finger drag | Pan the map |
| Pinch | Zoom in/out |

No mode toggle for pan vs draw. The gesture itself disambiguates. ~100ms grace period before committing to draw, so a second finger can arrive for pan/zoom.

---

## Phases **[not implemented]**

No code distinguishes the two phases. Preparation currently happens before players join, which makes the distinction implicit rather than enforced — see the session model in [project.md](project.md).

### Prep Phase

The GM has not started the session yet. All panels are expanded. Map management (upload, reorder, delete) happens here. Players see nothing — or a waiting screen — until the GM activates a map.

### Play Phase

Controls collapse to minimal state. The map strip shows prev/next arrows for quick switching during play. Full map management is not needed live.

---

## Layout: GM

```
┌──────────────────────────────────────────────┐
│ [Adventure Name]    [●●●● +2]          [·]   │  ← topbar: name + avatar stack + status
│                                              │
│ ┃                                            │
│ ┃            F U L L   C A N V A S           │
│ ┃                                            │  ← brush size: vertical slider, left edge
│ ┃                                     [IMG]  │  ← map panel icon, right edge
│                                              │
│ [↩ ↪ Reveal | Fog]                          │  ← undo/redo + mode toggle, bottom-left
└──────────────────────────────────────────────┘
```

### Map Panel

- **Collapsed:** a small icon (image stack) on the right edge. Always accessible.
- **Expanded:** a right-side sheet slides out over the canvas. Contains:
  - Scrollable thumbnail list of all maps
  - Active map highlighted
  - Upload button
  - During play: prev/next arrows at top for quick switching
- Tap icon to open, tap icon or outside to close.
- The sheet overlays the canvas — does not push or resize it.

> Future idea: if the icon itself could show a tiny stack of map thumbnails (like layered cards), that would be a distinct visual feature worth exploring later.

### Player Presence (GM topbar)

Miro-style avatar stack in the GM topbar, right-aligned:
- Overlapping colored circles (player's chosen color + first initial letter).
- Green ring = online. No ring = offline (token persists, player disconnected).
- Overflow counter (`+N`) when more than ~4 players.
- Click a circle → popover with: player name, "Copy player link", "Remove player".
- "Remove player" deletes the token and the player's session. Player would need a new invite to rejoin.

Tokens are persistent — they belong to the adventure, not the WebSocket session. Disconnecting does not delete the token. Only the GM can remove a player.

### Controls

- **Mode toggle** — bottom-left floating pill. Two segments: Reveal / Fog. Always visible. 44pt minimum tap target.
- **Brush size** — vertical slider hugging the left edge, Procreate-style. Drag up = bigger, down = smaller. Shows radius preview on canvas while adjusting.
- **Brush preview** — color-coded circle under cursor/finger. Green tint = reveal, red tint = fog. Strongest mode indicator.
- **Topbar** — adventure name + player presence strip + connection status dot. Always visible but minimal.

### Collapse Behavior

Controls are collapsible, never auto-hiding. Each control group has an explicit collapse/expand interaction (tap icon, tap chevron). The user is always in control of what's visible. No timers, no fade-outs.

- **Always visible:** mode toggle, brush preview (these are too small to need collapsing)
- **Collapsible:** map panel, brush size slider, topbar details

---

## Layout: Player

```
┌──────────────────────────────────────────────┐
│ [● PlayerName]                               │  ← corner indicator
│                                              │
│            F U L L   C A N V A S             │
│                                              │
│            (drag your token)                 │
│                                              │
└──────────────────────────────────────────────┘
```

- Near-zero UI. Player name + color dot in corner.
- Token drag is the only interaction besides pan/zoom.
- No login, no registration. Player joins via share link, picks name + color. Same player can rejoin from any device — the link is the identity.

---

## Session & Token Identity

No player accounts. The share link is the session key. A player can open the same session on multiple devices simultaneously.

**Tokens are persistent.** Created when a player first joins, stored in the DB, and survive disconnects. When the same player link reconnects, the existing token is reused — no duplicate. The GM can remove a player (and their token) explicitly.

**Reconnection flow:**
1. Player opens link → WS connects with `playerLink`.
2. Server checks: does a token exist for this `(adventure_id, player_link)`?
3. Yes → reuse token, mark as online. No → create token.
4. Player disconnects → token stays, marked as offline.
5. GM clicks "Remove player" → token deleted, player would need new invite.

---

## Visual Language

| Property | Value | Why |
|----------|-------|-----|
| Background | `#0d0d1a` dark navy | Recedes, map pops |
| Controls | Translucent, `backdrop-filter: blur(8px)`, 60% opacity bg | Visible but not competing with map |
| Accent | `#4a4aff` blue-purple | Already established |
| Mode: Reveal | Green-tinted brush preview | Intuitive: green = go, clear |
| Mode: Fog | Red-tinted brush preview | Intuitive: red = stop, cover |
| Tap targets | 44pt minimum (Apple HIG) | Fat-finger safe |
| Transitions | 200ms ease-out for expand/collapse | Smooth but not sluggish |
| Control style | Rounded, floating, Miro-inspired | Lightweight, modern, unobtrusive |

---

## What This Is NOT

- Not a phone app. Phones carry the group's voice call and are not used for the map.
- Not adding features beyond what's in the PoC scope.
- Controls don't float over the canvas center. Edges and corners only.
- No auto-hide. Collapse is explicit, user-initiated.

---

## Resolved Decisions

- **Undo/redo** — two icon buttons next to the mode toggle (bottom-left cluster). Always visible when fog tool is active.
- **Player ping** — long-press gesture on canvas. No dedicated button.
- **Invite link** — accessible via player avatar popover ("Copy player link") in GM topbar.

## Open Questions

- **Map stack icon** — could the collapsed map panel icon show a tiny visual stack of the actual map thumbnails? Worth exploring as a polish item.
