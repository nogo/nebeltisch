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
┌──────────────────────────────────────────────────────┐
│ [Adventure Name]                    [●●] [link] [·]  │  ← topbar
│                                                      │
│                                                      │
│              F U L L   C A N V A S                   │
│                                                      │
│                                                      │
│      [↩ ↪ │ Reveal Re-fog │ ●50 │ 20 │ 1 │ ▣ ⚑ ◉]   │  ← one toolbar, bottom centre
└──────────────────────────────────────────────────────┘
```

Every GM control lives in a single floating toolbar at the bottom centre. Earlier drafts of this document placed the brush size on a vertical left-edge slider and the map panel behind a right-edge icon; both were consolidated into the toolbar and the edges are now empty.

### Toolbar

Left to right, separated into groups:

| Control | Behaviour |
|---|---|
| Undo / redo | Hidden entirely when there is no history for the active map |
| Reveal / Re-fog | Segmented pill. The active segment is the mode indicator |
| Brush size | Button showing the current radius; opens a popup slider. Also `Shift`+scroll on the canvas |
| Token size | Button showing the current radius; opens a popup slider. Applies to every token, for everyone |
| Players | Button showing the count; opens the players sheet |
| Maps | Opens the maps sheet |
| Start point | Arms a mode: the next tap on the canvas sets the party start point for the active map |
| Place token | Arms a mode: the next tap opens a small form to place a monster or NPC |

### Sheets

The players sheet and the maps sheet slide over the canvas and never resize it. Tap the button again, or outside the sheet, to close.

- **Maps sheet** — scrollable thumbnails, active map highlighted, upload button, and a flag button per map for setting that map's start point without activating it.
- **Players sheet** — the roster, and "Copy invite link".

### Player Presence (GM topbar)

Coloured circles, right-aligned, showing each player's colour and first initial. Green ring = online; no ring = offline, meaning the token persists but the player is disconnected. Hovering shows the name.

The avatars are **display only**. Player actions — copying the invite link, removing a player — live in the players sheet, not in a popover on the avatar.

Tokens are persistent: they belong to the adventure, not the WebSocket session. Disconnecting never deletes a token. Only the GM can remove a player, which deletes their token and requires a new invite to rejoin.

### Fog opacity differs by role

The GM's fog layer is rendered at 85% opacity so the map is dimly readable underneath; players see it fully opaque. This is a fixed value, applied as CSS opacity so the stored mask keeps absolute alpha.

### Mode indication

The active segment of the Reveal / Re-fog pill is currently the only mode indicator. The brush preview is a plain white circle.

**[not implemented]** The preview should be colour-coded — green tint to reveal, red tint to re-fog — under the cursor or finger. On a tablet the toolbar is far from where the hand is working, so tinting the preview would put the mode where the eye already is. This remains the intent.

### Collapse Behaviour

Controls are collapsible, and collapsing is user-initiated. No timers, no idle fade-outs, nothing disappears because time passed.

One exception, and it is deliberate: **the toolbar dims to 15% while a brush stroke is in progress** and returns the instant the stroke ends or the pointer moves over it. That is not auto-hide — it is caused directly by the user's own gesture, lasts exactly as long as that gesture, and keeps the toolbar from competing with the stroke being painted at the bottom of the map.

- **Always visible:** toolbar, brush preview
- **Opened and closed explicitly:** maps sheet, players sheet, brush and token size popups
- **Conditional:** undo/redo, hidden when there is no history

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

- Near-zero UI. Player name + colour dot in the top-left corner. Nothing else.
- Dragging their own token and long-pressing to ping are the only interactions besides pan/zoom.
- No login, no registration. The player joins via the share link and picks a name and colour.

---

## Session & Token Identity

No player accounts. The share link is the session key, and a player can open the same session on several devices at once.

**Identity is the link *and* the name**, stored as the composite `playerLink|playerName`. Rejoining with the same link and the same name returns the same token from any device.

> **Consequence:** typing a different name on the same link creates a *second* token and abandons the first, along with its position. This has happened in real use. It is the current design, not a bug, but it is a sharp edge — a player who types "Imion" one week and "Imion Dragentod" the next is two players as far as the system is concerned.

**Tokens are persistent.** Created on first join, stored in the database, and they survive disconnects.

**Reconnection flow:**
1. Player opens the link → WebSocket connects with `playerLink` and `playerName`.
2. Server looks for a token matching `(adventure_id, playerLink|playerName)`.
3. Found → reuse it and mark online. Not found → create one, placed at the active map's start point.
4. Player disconnects → the token stays, marked offline.
5. GM removes the player → token deleted; a new invite is needed to rejoin.

---

## Visual Language

| Property | Value | Why |
|----------|-------|-----|
| Background | `#0d0d1a` dark navy | Recedes, map pops |
| Controls | Translucent, `backdrop-filter: blur(8px)`, 60% opacity bg | Visible but not competing with map |
| Accent | `#4a4aff` blue-purple | Already established |
| Start point marker | `#ffb020` gold, flag glyph on a dashed ring | Must not read as a token. Tokens are coloured circles, so the marker differs by **shape**, not only colour |
| Mode: Reveal | Green-tinted brush preview **[not implemented]** | Intuitive: green = go, clear |
| Mode: Fog | Red-tinted brush preview **[not implemented]** | Intuitive: red = stop, cover |
| Tap targets | 44pt minimum (Apple HIG), including hit tests | A target computed in image coordinates shrinks as the map zooms out; it needs a screen-space floor |
| Transitions | 200ms ease-out for expand/collapse | Smooth but not sluggish |
| Control style | Rounded, floating, Miro-inspired | Lightweight, modern, unobtrusive |

---

## What This Is NOT

- Not a phone app. Phones carry the group's voice call and are not used for the map.
- Not a full VTT. Scope is defined in [project.md](project.md); a feature belonging to the rules of a game is out of scope.
- Controls never float over the middle of the map. The toolbar sits on the bottom edge, horizontally centred.
- No idle auto-hide. Nothing disappears because time passed — see Collapse Behaviour for the one gesture-linked exception.

---

## Resolved Decisions

- **Undo/redo** — two icon buttons next to the mode toggle (bottom-left cluster). Always visible when fog tool is active.
- **Player ping** — long-press gesture on canvas. No dedicated button.
- **Invite link** — accessible via player avatar popover ("Copy player link") in GM topbar.

## Open Questions

- **Map stack icon** — could the collapsed map panel icon show a tiny visual stack of the actual map thumbnails? Worth exploring as a polish item.
