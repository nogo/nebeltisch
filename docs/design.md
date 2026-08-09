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
| 1 finger / stylus | Interact — GM: drag the start marker or a page, or paint fog once the brush is armed; Player: drag token |
| Tap the start marker | GM only: select it, revealing its lock menu |
| 2-finger drag | Pan |
| Pinch | Zoom in/out |
| Double-tap empty canvas | GM only: fit the board |

The start marker takes precedence over the page beneath it, the same order the token layers already take. Five screen pixels of travel separate a tap from a drag, so a tap that jitters still selects.

No mode toggle for pan vs draw. The gesture itself disambiguates. ~100ms grace period before committing to draw, so a second finger can arrive for pan/zoom.

**One deliberate exception, on the board.** One finger drags a page and paints nothing until a tool is armed. The rule above still governs a single page under the finger; it cannot govern a board, where a stray finger would paint fog onto whichever page happened to be underneath — a far worse failure than an extra tap. Two fingers pan and pinch zooms whatever is armed, or a large page cannot be reached mid-stroke.

**The brush is armed by picking Reveal or Re-fog**, and disarmed by tapping the armed segment again — the same idiom the place-token button uses. Neither segment is active on load. A tap must travel five screen pixels before it counts as a drag, or no finger would ever select a page.

---

## Phases **[not implemented — #52]**

No code distinguishes the two phases; the board below exists and the phases over it do not. The controls do not collapse, and nothing is remembered about which phase the GM was in — see the session model in [project.md](project.md).

**A phase is a mode, not a stage.** Earlier drafts of this section described preparation as temporal — "the GM has not started the session yet". That was wrong about the real use case: the party talks in the tavern while the GM sets up the cellar, and comes back to it three times an evening. The GM switches between the two phases freely, including mid-session.

**Switching phase changes nothing a player can see.** What the players see is decided by which page is presented and by nothing else. The phase is a GM affordance; it never reaches the server (#52).

### The board

An adventure is a **board of pages**, and a page is either a *map* or a *card* (cards are #53, not built). The board is the GM's home for an adventure — opening one opens its board, fitted to show every page at once.

**Zoom is the navigation.** Pinch out for the whole adventure; pinch in until a page fills the screen, at which point it is the GM canvas described below. There is no map list, no thumbnail strip and no prev/next arrows — the maps sheet has retired, and so has the map panel.

**The board is an infinite canvas, not a fitted page.** Pages float on it; they do not define it. Zoom runs a fixed 2%–400% whatever is on the board, and panning is unbounded in every direction, so adding a large page never changes how far the GM can pull back. A page may sit at a negative coordinate — the origin is not a corner.

The cost of no edges is that the GM can lose the pages, so **Fit** frames all of them: a toolbar button, and a double-tap on empty canvas. Empty canvas has no other meaning, and on a page the double-tap still belongs to the token layer.

A page's position on the board means only what the GM means by it — village here, mill to the right, cellar below. Nothing in the system reads an order, an adjacency or a geography into it. One finger drags a page; the arrangement is saved on release and is the same on the next device.

**A player's viewport is bounded, and stays that way.** One page, no zooming out past it filling the screen, no panning it off the edge. There is nothing beyond it to find, so the freedom would only buy them a way to lose the map.

**Selecting and presenting are different acts.** A tap selects: the page gains the canvas stack and its stored fog is drawn. Nobody else sees any of that. Presenting is the second, explicit action — see Play Phase below.

### The start point

**Every map shows where the party will land**, including one nobody has set up: the marker sits at the map centre, which is where the server sends them anyway. There is no button, nothing to create and nothing to clear.

**It is moved by dragging it**, like a token under the finger, and the position is saved on release. **Tap it to select**, and a small menu appears beside it with Lock and Unlock. A locked marker cannot be dragged — the ring goes solid so the state reads at a glance — and it still selects, or there would be no way to unlock it. The lock is stored per map, so it is the same on the next device, and it starts unlocked.

Players never see the marker, on any map, presented or not.

Only the selected page carries the canvas stack; every other page is the plain uploaded image, with no fog drawn over it.

### Prep Phase **[not implemented — #52]**

All panels are expanded. Pages are uploaded, named and arranged here, and any page can be prepared — fog, monster and NPC tokens, start point — whether or not it is the one on the table (#51).

**Everything the GM can do to the live page, they can do to a page in prep**, and nobody sees it: reveal and re-fog, place and remove monsters and NPCs, drag them, set the start point, and undo and redo, which run per page so stepping back on the room being prepared never touches the one on the table. What keeps it invisible is a server rule, not this screen — see *Only the presented page reaches the players* in [architecture.md](architecture.md).

**The live page keeps its badge while another is being prepared**, so the GM can always see what the table is looking at. The page under the canvas stack is the one being worked on; the badge is the one being watched, and they are routinely not the same page.

**The party is not drawn on a page in preparation.** Player tokens stand on whatever is presented and pings point at what is on the table, so both layers belong to the live page only. Monsters and NPCs belong to a page and follow the selection. Player tokens are not positioned during prep at all — arrival is governed by the start point.

Only the phases themselves are still missing here (#52); everything above is built.

Players see the presented page, or the waiting state, and nothing of this.

### Play Phase

Controls collapse to what is used live **[not implemented — #52]**. The presented page carries the canvas stack and the fog brush paints it directly.

**Presenting is deliberate, never a single tap.** Select a page, then press Present: during play the tap that switches rooms sits next to the live page, and a mis-tap must not show the party somewhere they have not walked. The live page carries a visible badge that stays the same size at every zoom level, so the GM always knows what the table is looking at.

When no page has been presented, the board says so and the players wait on a blank screen. Replacing that blank screen with an opening card is #53.

### Cards **[not implemented]**

A card is an image page and nothing else — no fog, no tokens, no start point (#53). **A card is fitted, not explored:** it fills the viewport letterboxed, with no pan, no zoom and no pings. A card is a screen; a map is a space. Presenting one is how a session opens, and how the waiting state stops being a blank screen.

Intro and outro are not types — they are where the GM puts the card on the board.

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
| Undo / redo | Steps the *selected* page's history, which is not always the live one. Hidden entirely when that page has none |
| Reveal / Re-fog | Segmented pill. Picking a segment arms the brush; tapping the armed one disarms it |
| Brush size | Button showing the current radius; opens a popup slider. Also `Shift`+scroll on the canvas |
| Token size | Button showing the current radius; opens a popup slider. Applies to every token, for everyone |
| Players | Button showing the count; opens the players sheet |
| Upload | Adds a page; it lands on a free spot on the board |
| Place token | Arms a mode: the next tap opens a small form to place a monster or NPC |
| Fit | Frames every page. Same as double-tapping empty canvas |
| Present | Shows the selected page to the table. Disabled when it is already live |

The fog and token controls dim only while no page is loaded under the canvas stack. Selecting a page the party is not looking at leaves every one of them live — preparing that page is what the board is for (#51).

### Sheets

The players sheet slides over the canvas and never resizes it. Tap the button again, or outside the sheet, to close. It holds the roster and "Copy invite link".

The maps sheet is gone. It listed maps, activated one on tap, and carried a flag button per map for setting a start point without activating it; the board and the marker do all three, and nothing should reintroduce a list of pages beside it.

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
- **Opened and closed explicitly:** players sheet, brush and token size popups
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
| Start point marker | `#ffb020` gold, flag glyph on a dashed ring; solid ring when locked | Must not read as a token. Tokens are coloured circles, so the marker differs by **shape**, not only colour |
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

- ~~**Map stack icon** — could the collapsed map panel icon show a tiny visual stack of the actual map thumbnails?~~ Moot as of 2026-08-09: the board shows the actual pages at actual size, and the map panel it would have decorated retired with the maps sheet.
