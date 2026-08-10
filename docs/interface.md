# Nebeltisch — Interface

> **Scope of this file:** the interface as specified — gestures, controls, layout, visual language.
> The principles these follow from are in [design.md](design.md); when the two disagree, the principle wins.
> *Why the project exists* is in [project.md](project.md). *How it is built* is in [architecture.md](architecture.md).

Devices and their priority are in [project.md](project.md). Two consequences govern this file: touch is a primary input mode rather than a fallback, so every interactive target clears a screen-space minimum regardless of zoom; and the GM's stylus on a tablet is a first-class input, so anything drawn with the brush must work under a pen as well as a mouse.

---

## Gestures

| Gesture | Action |
|---------|--------|
| 1 finger / stylus | Interact — GM: drag the start marker, a token or a page, or paint fog once the brush is armed; Player: drag token |
| Tap the start marker | GM only: select it, revealing its lock menu |
| 2-finger drag | Pan |
| Pinch | Zoom in/out |
| Double-tap empty canvas | GM only: fit the board |

**One finger picks up the topmost thing under it: start marker, then token, then page.** A monster is dragged the same way whether or not the brush is out. Five screen pixels of travel separate a tap from a drag, so a tap that jitters still selects, and roughly 100ms of grace precedes committing to a stroke, so a second finger can arrive for pan/zoom.

**One deliberate exception, on the board.** One finger drags a page and paints nothing until a tool is armed. The topmost-thing rule still governs a single page under the finger; it cannot govern a board, where a stray finger would paint fog onto whichever page happened to be underneath — a far worse failure than an extra tap. Two fingers pan and pinch zooms whatever is armed, or a large page cannot be reached mid-stroke.

**The brush is armed by picking Reveal or Re-fog**, and disarmed by tapping the armed segment again — the same idiom the place-token button uses. Neither segment is active on load.

---

## The board

An adventure is a **board of pages**, and every page is a map. The board is the GM's home for an adventure — opening one opens its board, fitted to show every page at once. Pinch in until a page fills the screen and it is the GM canvas described below.

**The board is an infinite canvas, not a fitted page.** Pages float on it; they do not define it. Zoom runs a fixed 2%–400% whatever is on the board, and panning is unbounded in every direction, so adding a large page never changes how far the GM can pull back. A page may sit at a negative coordinate — the origin is not a corner.

The cost of no edges is that the GM can lose the pages, so **Fit** frames all of them: a toolbar button, and a double-tap on empty canvas. Empty canvas has no other meaning, and on a page the double-tap still belongs to the token layer.

A page's position means only what the GM means by it — village here, mill to the right, cellar below. Nothing in the system reads an order, an adjacency or a geography into it. One finger drags a page; the arrangement is saved on release and is the same on the next device.

**Selecting and presenting are different acts.** A tap selects: the page gains the canvas stack and its stored fog is drawn, and nobody else sees any of that. Only the selected page carries the canvas stack; every other page is the plain uploaded image, with no fog drawn over it.

### Acting on the selected page

**Present and Delete act on whichever page is selected, and both live in the toolbar.**

They were briefly a menu hanging over the page itself, which put each act next to the thing it acts on and read well on the fitted board. It broke the moment the GM zoomed in: a page's top edge is off screen exactly when the page fills it, so presenting meant zooming out first. **A control the GM needs regardless of where they are looking cannot be anchored to a place in the world** — anchoring it somewhere else on the page only changes which zoom level hides it, and clamping it into view would put a control over the middle of the map, which principle 2 forbids. Reverted 2026-08-10, after use.

The start marker's menu is not the same case and stays on the map: it is reached by finding the marker, so it is already where the eye is.

**Delete asks twice and never touches the live page.** The first press changes the button to *Delete page?*; only the second removes anything, and a page's fog, start point and monsters do not come back. Anything else the GM does puts it back to *Delete*. While the selected page is the one on the table the button is disabled and says *take it off the table first* — the server refuses it as well, so a second GM tab with a stale board cannot get around it.

### The start point

**Every map shows where the party will land**, including one nobody has set up: the marker sits at the map centre, which is where the server sends them anyway. There is no button, nothing to create and nothing to clear.

**It is moved by dragging it**, like a token under the finger, and the position is saved on release. **Tap it to select**, and a small menu appears beside it with Lock and Unlock. A locked marker cannot be dragged — the ring goes solid so the state reads at a glance — and it still selects, or there would be no way to unlock it. The lock is stored per map, so it is the same on the next device, and it starts unlocked.

Players never see the marker, on any map, presented or not.

### Preparing

Pages are uploaded, named and arranged here, and any page can be prepared — fog, monster and NPC tokens, start point — whether or not it is the one on the table.

**Everything the GM can do to the live page, they can do to a page in prep**, and nobody sees it: reveal and re-fog, place and remove monsters and NPCs, drag them, set the start point, and undo and redo, which run per page so stepping back on the room being prepared never touches the one on the table. What keeps it invisible is a server rule, not this screen — see *Only the presented page reaches the players* in [architecture.md](architecture.md).

**The live page keeps its badge while another is being prepared**, so the GM can always see what the table is looking at. The page under the canvas stack is the one being worked on; the badge is the one being watched, and they are routinely not the same page.

**The party is not drawn on a page in preparation.** Player tokens stand on whatever is presented and pings point at what is on the table, so both layers belong to the live page only. Monsters and NPCs belong to a page and follow the selection. Player tokens are not positioned during prep at all — arrival is governed by the start point.

Players see the presented page, or the waiting screen, and nothing of this.

### Presenting

**Presenting is deliberate, never a single tap.** Select a page, then press Present. The live page carries a visible badge that stays the same size at every zoom level, so the GM always knows what the table is looking at.

**Presenting frames the page on the GM's board.** They pressed Present on a page; landing on it is the answer to the gesture. It moves the camera and nothing else — no control changes, no page becomes unreachable, and zooming back out to prepare another page is the same gesture it always was.

**A page can be taken off the table again.** With the live page selected the button reads Unpresent, and pressing it empties the table: the players return to the waiting screen and the GM keeps the page, the view and everything prepared on it. Selecting the live page is what reaches the control, so taking a page off is the same select-then-press that put it there.

**Nothing moves when the table empties.** Player tokens stay where they stand, because `token_positions` is what decides where the party is when a page comes back — a token that walked somewhere returns there, and only a token that has never stood on that page arrives at the start point. Unpresenting is therefore free to undo: it is about what the table shows, not about where anyone is.

### The waiting screen

Until a page is presented — and again whenever the GM takes one off — a player sees the **adventure's name** over drifting fog, and one line: *The fog has not lifted yet.* The GM sees the same state from the other side, as an unlit on-air lamp in the topbar.

**Naming the adventure is the whole point.** A blank screen cannot tell a player who joined too early apart from a player whose connection is broken; the adventure's own name answers that without the GM having to say anything. The name carries it alone — a greeting above it would only compete with the one word that answers the question.

**The fog is the mechanic, not decoration.** Nebeltisch is a table where the map shows only what the party has seen, so a screen before anything is presented is not an empty state needing dressing — nothing has been revealed yet, so there is fog. The name sits in a soft clearing, the shape the GM's brush makes, which is the one place the fog is gone. A player who then watches it give way to a map has understood the product.

**It moves, and it is never interactive.** The drift is atmosphere; the fog answers to nobody. Letting a player part it with a finger was considered and rejected: players never paint fog in this application, and teaching a gesture on the one screen where they are paying full attention, which does nothing for the rest of the session, is a lie. Motion stops entirely under `prefers-reduced-motion`, because it says nothing a player needs.

**Its cost is bounded deliberately**, since this runs on the tablet — see *The waiting screen's fog is bounded by construction* in [architecture.md](architecture.md).

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

Every GM control lives in a single floating toolbar at the bottom centre. The edges are otherwise empty and stay that way.

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
| Present | Puts the selected page on the table. Reads **Unpresent** when that page is already the live one, and takes it off. Disabled only when no page is selected |
| Delete | Removes the selected page and everything on it, on a second press. Disabled while that page is the live one |

The fog and token controls dim only while no page is loaded under the canvas stack. Selecting a page the party is not looking at leaves every one of them live — preparing that page is what the board is for.

### Sheets

The players sheet slides over the canvas and never resizes it. Tap the button again, or outside the sheet, to close. It holds the roster and "Copy invite link".

There is no sheet or panel that lists pages, and nothing should introduce one — zoom is the navigation.

### Player presence (GM topbar)

Coloured circles, right-aligned, showing each player's colour and first initial. Green ring = online; no ring = offline, meaning the token persists but the player is disconnected. Hovering shows the name.

The avatars are **display only**. Player actions — copying the invite link, removing a player — live in the players sheet, not in a popover on the avatar.

Tokens are persistent: they belong to the adventure, not the WebSocket session. Disconnecting never deletes a token. Only the GM can remove a player, which deletes their token and requires a new invite to rejoin.

### Fog opacity differs by role

The GM's fog layer is rendered at 85% opacity so the map is dimly readable underneath; players see it fully opaque. This is a fixed value, applied as CSS opacity so the stored mask keeps absolute alpha.

### Mode indication

The active segment of the Reveal / Re-fog pill says which way the brush paints. The brush preview should carry it too — green tint to reveal, red tint to re-fog, under the cursor or finger — because on a tablet the toolbar is far from where the hand is working, and the mode belongs where the eye already is.

### What you picked up

A one-finger drag can land on the start marker, a token or a page, and until the thing moves, nothing else says which one you got. So **the grabbed object marks itself the moment it is grabbed**, before any movement: a token draws a white halo ring, the start marker brightens its landing ring, a page dims to 75%.

The cue is placed to survive the hand making the gesture. The token's halo sits 14 **screen** pixels outside the token at every zoom, and the marker brightens its whole landing ring rather than its flag. A halo, not a bigger token: the drawn radius is the party's footprint and must not appear to change while being moved.

A locked start marker shows it too. The grab did register; the lock is why nothing follows.

### Collapse behaviour

Controls are collapsible, and collapsing is user-initiated. No timers, no idle fade-outs.

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
- The viewport is bounded to the one page: no zooming out past it filling the screen, no panning it off the edge.

**The share link is the session key**, and a player may open the same session on several devices at once — same link and same name reach the same token, wherever they open it.

**The sharp edge that follows:** identity is the link *and* the name, so typing a *different* name on the same link creates a second token and abandons the first, along with its position. A player who types "Imion" one week and "Imion Dragentod" the next is two players as far as the system is concerned. This has happened in real use. It is the current design — see *Token rules* in [architecture.md](architecture.md).

---

## Visual language

| Property | Value | Why |
|----------|-------|-----|
| Background | `#0d0d1a` dark navy | Recedes, map pops |
| Controls | Translucent, `backdrop-filter: blur(8px)`, 60% opacity bg | Visible but not competing with map |
| Accent | `#4a4aff` blue-purple | Established |
| Start point marker | `#ffb020` gold, flag glyph on a dashed ring; solid ring when locked | Must not read as a token. Tokens are coloured circles, so the marker differs by **shape**, not only colour |
| Mode: Reveal | Green-tinted brush preview | Intuitive: green = go, clear |
| Mode: Fog | Red-tinted brush preview | Intuitive: red = stop, cover |
| Tap targets | 44pt minimum (Apple HIG), including hit tests | A target computed in image coordinates shrinks as the map zooms out; it needs a screen-space floor |
| Transitions | 200ms ease-out for expand/collapse | Smooth but not sluggish |
| Control style | Rounded, floating, Miro-inspired | Lightweight, modern, unobtrusive |
