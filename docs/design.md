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
| 1 finger / stylus | Interact — GM: drag the start marker, a token or a page, or paint fog once the brush is armed; Player: drag token |
| Tap the start marker | GM only: select it, revealing its lock menu |
| 2-finger drag | Pan |
| Pinch | Zoom in/out |
| Double-tap empty canvas | GM only: fit the board |

**One finger picks up the topmost thing under it: start marker, then token, then page.** Arming a tool changes what an empty patch of page does, never what the things standing on it do — a monster is dragged the same way whether or not the brush is out. Five screen pixels of travel separate a tap from a drag, so a tap that jitters still selects.

No mode toggle for pan vs draw. The gesture itself disambiguates. ~100ms grace period before committing to draw, so a second finger can arrive for pan/zoom.

**One deliberate exception, on the board.** One finger drags a page and paints nothing until a tool is armed. The rule above still governs a single page under the finger; it cannot govern a board, where a stray finger would paint fog onto whichever page happened to be underneath — a far worse failure than an extra tap. Two fingers pan and pinch zooms whatever is armed, or a large page cannot be reached mid-stroke.

**The brush is armed by picking Reveal or Re-fog**, and disarmed by tapping the armed segment again — the same idiom the place-token button uses. Neither segment is active on load. A tap must travel five screen pixels before it counts as a drag, or no finger would ever select a page.

---

## There is no phase

**The GM has one view, and it does not change.** The board is always the board, every control stays on the toolbar, and preparing and presenting are things the GM does on that one screen rather than modes it switches between.

Two earlier drafts got this wrong in opposite directions. The first described preparation as temporal — "the GM has not started the session yet" — which the real use case contradicts: the party talks in the tavern while the GM sets up the cellar, and comes back to it three times an evening. The second turned that correction into a *mode*, with a phase switch, a collapsing toolbar and a remembered phase (#52). That was a mode invented to describe a difference the GM does not experience.

**What actually separates the two is one fact, and the server owns it: which page is presented.** Everything else the GM does — arranging pages, painting fog on a room nobody is watching, placing monsters — is stored and reaches nobody. A GM affordance layered on top of that could only ever agree or disagree with it, and disagreeing is the failure. Superseded 2026-08-10; #52 was closed rather than built.

The one thing presenting does to the GM's own screen is frame the page they just put on the table. It is a camera move, not a mode: the board stays reachable, and zooming back out to prepare another page is the same gesture it always was.

### The board

An adventure is a **board of pages**, and every page is a map. The board is the GM's home for an adventure — opening one opens its board, fitted to show every page at once.

**Zoom is the navigation.** Pinch out for the whole adventure; pinch in until a page fills the screen, at which point it is the GM canvas described below. There is no map list, no thumbnail strip and no prev/next arrows — the maps sheet has retired, and so has the map panel.

**The board is an infinite canvas, not a fitted page.** Pages float on it; they do not define it. Zoom runs a fixed 2%–400% whatever is on the board, and panning is unbounded in every direction, so adding a large page never changes how far the GM can pull back. A page may sit at a negative coordinate — the origin is not a corner.

The cost of no edges is that the GM can lose the pages, so **Fit** frames all of them: a toolbar button, and a double-tap on empty canvas. Empty canvas has no other meaning, and on a page the double-tap still belongs to the token layer.

A page's position on the board means only what the GM means by it — village here, mill to the right, cellar below. Nothing in the system reads an order, an adjacency or a geography into it. One finger drags a page; the arrangement is saved on release and is the same on the next device.

**A player's viewport is bounded, and stays that way.** One page, no zooming out past it filling the screen, no panning it off the edge. There is nothing beyond it to find, so the freedom would only buy them a way to lose the map.

**Selecting and presenting are different acts.** A tap selects: the page gains the canvas stack and its stored fog is drawn. Nobody else sees any of that. Presenting is the second, explicit action — see *Presenting* below.

### The start point

**Every map shows where the party will land**, including one nobody has set up: the marker sits at the map centre, which is where the server sends them anyway. There is no button, nothing to create and nothing to clear.

**It is moved by dragging it**, like a token under the finger, and the position is saved on release. **Tap it to select**, and a small menu appears beside it with Lock and Unlock. A locked marker cannot be dragged — the ring goes solid so the state reads at a glance — and it still selects, or there would be no way to unlock it. The lock is stored per map, so it is the same on the next device, and it starts unlocked.

Players never see the marker, on any map, presented or not.

Only the selected page carries the canvas stack; every other page is the plain uploaded image, with no fog drawn over it.

### Preparing

Pages are uploaded, named and arranged here, and any page can be prepared — fog, monster and NPC tokens, start point — whether or not it is the one on the table (#51).

**Everything the GM can do to the live page, they can do to a page in prep**, and nobody sees it: reveal and re-fog, place and remove monsters and NPCs, drag them, set the start point, and undo and redo, which run per page so stepping back on the room being prepared never touches the one on the table. What keeps it invisible is a server rule, not this screen — see *Only the presented page reaches the players* in [architecture.md](architecture.md).

**The live page keeps its badge while another is being prepared**, so the GM can always see what the table is looking at. The page under the canvas stack is the one being worked on; the badge is the one being watched, and they are routinely not the same page.

**The party is not drawn on a page in preparation.** Player tokens stand on whatever is presented and pings point at what is on the table, so both layers belong to the live page only. Monsters and NPCs belong to a page and follow the selection. Player tokens are not positioned during prep at all — arrival is governed by the start point.

Players see the presented page, or the waiting screen, and nothing of this.

### Presenting

**Presenting is deliberate, never a single tap.** Select a page, then press Present: during play the tap that switches rooms sits next to the live page, and a mis-tap must not show the party somewhere they have not walked. The live page carries a visible badge that stays the same size at every zoom level, so the GM always knows what the table is looking at.

**Presenting frames the page on the GM's board.** They pressed Present on a page; landing on it is the answer to the gesture. It moves the camera and nothing else — no control changes, no page becomes unreachable.

**A page can be taken off the table again.** Selecting the live page turns Present into Unpresent, and pressing it empties the table: the players return to the waiting screen and the GM keeps the page, the view and everything prepared on it. Selecting the live page is what reaches the control, so taking a page off is the same select-then-press that put it there.

**Nothing moves when the table empties.** Player tokens stay where they stand, because `token_positions` is what decides where the party is when a page comes back — a token that walked somewhere returns there, and only a token that has never stood on that page arrives at the start point. Unpresenting is therefore free to undo: it is about what the table shows, not about where anyone is.

### The waiting screen

Until a page is presented — and again whenever the GM takes one off — a player sees the **adventure's name** over drifting fog, and one line: *The fog has not lifted yet.* The GM sees the same state from the other side, as a hint on the board.

**Naming the adventure is the whole point.** A blank screen cannot tell a player who joined too early apart from a player whose connection is broken; the adventure's own name answers that without the GM having to say anything. The name carries it alone — an earlier draft greeted the player above it, and the greeting only competed with the one word that answers the question.

**The fog is the mechanic, not decoration.** Nebeltisch is a table where the map shows only what the party has seen, so a screen before anything is presented is not an empty state needing dressing — nothing has been revealed yet, so there is fog. The name sits in a soft clearing, the shape the GM's brush makes, which is the one place the fog is gone. A player who then watches it give way to a map has understood the product.

**It moves, and it is never interactive.** The drift is atmosphere; the fog answers to nobody. Letting a player part it with a finger was considered and rejected: players never paint fog in this application, and teaching a gesture on the one screen where they are paying full attention, which does nothing for the rest of the session, is a lie. Motion stops entirely under `prefers-reduced-motion`, because it says nothing a player needs.

**The cost is bounded deliberately**, since this runs on the tablet: the noise is baked once into a seamless tile and every frame is three tiled fills of it, capped at 30fps and rendered at pixel ratio 1 — fog is soft gradients, so device resolution buys nothing visible. The loop exists only while the screen does, and is dropped while the tab is hidden; players sit in a voice call and switch apps constantly. A veil still running behind a presented map would cost exactly as much as one being looked at (#20).

An earlier draft filled this state with an uploadable *card* — a page carrying an image and nothing else, presented as an intro or an outro (#53). It bought a title screen at the cost of a second kind of page: a schema column, a wire field, a fog session that must not be allocated, and a player client that renders one page kind fitted and the other explorable. The waiting screen delivers the outcome the card existed for and stays a screen rather than becoming a page. Superseded 2026-08-10.

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
| Present | Puts the selected page on the table. Reads **Unpresent** when the selected page is already the live one, and takes it off. Disabled only when no page is selected |

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

### What you picked up

A one-finger drag can land on the start marker, a token or a page, and until the thing moves, nothing else says which one you got. So **the grabbed object marks itself the moment it is grabbed**, before any movement: a token draws a white halo ring, the start marker brightens its landing ring, a page dims to 75%.

The cue is placed to survive the hand making the gesture. A fingertip covers roughly 44pt, so anything drawn on the object itself is hidden by the finger holding it — the token's halo therefore sits 14 **screen** pixels outside the token at every zoom, and the marker brightens its whole landing ring rather than its flag. A halo, not a bigger token: the drawn radius is the party's footprint and must not appear to change while being moved.

A locked start marker shows it too. The grab did register; the lock is why nothing follows.

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
