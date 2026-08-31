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
| Tap a token | Opens the menu on it — what *this* client may do to *that* token. Tapping it again closes it |
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
│ [Adventure Name ▾]            [●●●] [◉ ON AIR] [·]   │  ← topbar
│                                                      │
│                                                      │
│              F U L L   C A N V A S                   │
│                                                      │
│                                                      │
│  [↩ ↪ │ Reveal Re-fog ●50 │ ◈ │ ⬆ ⛶ │ ▣ ✕]         │  ← toolbar, bottom centre
└──────────────────────────────────────────────────────┘
```

**Two strips, split by scope** (principle 2). The toolbar holds every act on the map; the topbar holds the adventure and the people at it. The left and right edges are empty and stay that way.

### Toolbar

Left to right, grouped by **what each control acts on**:

| Group | Control | Behaviour |
|---|---|---|
| The selected page | Undo / redo | Steps the *selected* page's history, which is not always the live one. Hidden entirely when that page has none |
| | Reveal / Re-fog | Segmented pill. Picking a segment arms the brush; tapping the armed one disarms it |
| | Brush size | Button showing the current radius; opens a popover slider. Also `Shift`+scroll on the canvas |
| | Place token | Arms a mode: the next tap opens a small form to place a monster or NPC |
| The board | Upload | Adds a page; it lands on a free spot on the board |
| | Fit | Frames every page. Same as double-tapping empty canvas |
| The fight | Clear resolved | Takes every answered attack off the table, with the count of what is still open beside it. Absent while there is no fight; disabled while nothing is answered, and it can never reach an open declaration |
| The table | Present | Puts the selected page on the table. Reads **Unpresent** when that page is already the live one, and takes it off. Disabled only when no page is selected |
| | Delete | Removes the selected page and everything on it, on a second press. Disabled while that page is the live one |

**The fight group exists only while there is one.** It is the one toolbar control that comes and goes with what is on the map, because a count of nothing and a button with nothing to clear are two controls costing pixels between fights. Everything else about a fight is reached by tapping the token it concerns — this is on the toolbar because it is the only act that is about *all* of them.

**Brush size sits inside the fog group, not behind its own separator.** It is a property of the armed brush and says nothing when no brush is armed.

The fog and place-token controls dim only while no page is loaded under the canvas stack. Selecting a page the party is not looking at leaves every one of them live — preparing that page is what the board is for.

### Topbar

| Control | Behaviour |
|---|---|
| Adventure name | Opens the settings popover, which holds the token size slider. Renaming belongs here and is not built yet |
| Presence avatars | Open the players popover: the roster, remove-player, and "Copy invite link" |
| On-air lamp | Display only. Lit while a page is on the table, dark while it is empty |
| Connection dot | Display only |

**The on-air lamp is the GM's half of the waiting screen**, and it replaced a line of text in the middle of the board that covered the map exactly where the work happens. A lamp says the same thing from the corner and says it in both directions — dark is a state, not a missing thing — and it is lit in the same colour as the live page's own badge, so board and topbar agree. It is about the *table*, so it stays lit while the GM prepares a page the party cannot see.

**Token size is a setting, not a tool.** It is one value for the whole adventure — it applies to every token, monster and player alike, for everyone — and the GM sets it once while looking at a map. The server has always agreed: it lives on `adventures` and broadcasts as `settings:updated`.

**There is no separate share button.** Copying the invite link is one item in the players popover, which is where the question "who is at this table" is already being answered. It costs one extra tap on an act performed once per player, ever.

**Renaming is the settings popover's second item, and it is not built.** It needs a database write, a message and a broadcast — the adventure's name is on the players' waiting screen, so a rename that does not reach them leaves the old name sitting there — which makes it its own piece of work rather than part of moving controls around. When it lands it will exist here *and* on the coming adventure dashboard, and neither is a duplicate: the dashboard renames an adventure the GM is not inside, the popover renames the one they are looking at.

### Popovers

A panel hangs off the control that opened it — the settings and players popovers under the topbar, the brush size popover over the toolbar — and none of them covers the middle of the map. Tap the trigger again, or outside, to close.

**They stay small enough to see past**, because each describes something on the map behind it. This replaced a full-width players sheet with a backdrop, which hid the roster's own map; see principle 2.

Not to be confused with the anchored menus in `anchored-menu.ts`, which hang off a point in the *transformed world* — beside a page or the start marker — and therefore counter-scale and opt out of the viewport's pointer capture. Topbar and toolbar popovers are screen chrome and need neither.

There is no popover or panel that lists pages, and nothing should introduce one — zoom is the navigation.

### Player presence (GM topbar)

Coloured circles, right-aligned, showing each player's colour and first initial. Green ring = online; no ring = offline, meaning the token persists but the player is disconnected. Hovering shows the name.

**The avatars are the players control.** Tapping them opens the roster popover directly beneath, where removing a player and copying the invite link live. They were previously display-only, with a separate players button in the toolbar carrying the count and a third button carrying the invite link — three controls for one question. The count is now the number of dots, which holds at the three-or-so players this is built for.

**An empty roster still draws one avatar**, a dashed outline with a `+`, and the popover behind it reads *No players yet* above the invite link. The strip is the only way to that link, and nobody has joined at the moment the GM most wants it — an empty strip would be a control that disappears exactly when it is needed.

In the popover, online is the row dot's green ring and offline dims it, the same way the avatars say it. The words *online* and *offline* were dropped with the sheet: they did not fit a narrow popover and stated in text what the dot beside them already showed.

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

- **Always visible:** topbar, toolbar, brush preview
- **Opened and closed explicitly:** the settings, players and brush size popovers
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
- Dragging their own token, long-pressing to ping, and tapping a token for the one menu a player has.
- **That menu holds what this player has to say and nothing else.** On a monster: declare an attack, take one back, send the damage rolled. On their own token: answer the attack aimed at them. On anything else it finds nothing to offer and does not open — a menu offering nothing is not a menu.
- No login, no registration. The player joins via the share link and picks a name and colour.
- The viewport is bounded to the one page: no zooming out past it filling the screen, no panning it off the edge.

**The share link is the session key**, and a player may open the same session on several devices at once — same link and same name reach the same token, wherever they open it.

**The sharp edge that follows:** identity is the link *and* the name, so typing a *different* name on the same link creates a second token and abandons the first, along with its position. A player who types "Imion" one week and "Imion Dragentod" the next is two players as far as the system is concerned. This has happened in real use. It is the current design — see *Token rules* in [architecture.md](architecture.md).

---

## Visual language

**Colour is identity; shape is state.** A token's colour says whose it is and nothing else ever borrows it — what happened to that token, and what is aimed at it, are said with shape, fill and glyph. Where two things must never be confused, they differ by shape (principle 8 in [design.md](design.md)).

| Property | Value | Why |
|----------|-------|-----|
| Background | `#0d0d1a` dark navy | Recedes, map pops |
| Controls | Translucent, `backdrop-filter: blur(8px)`, 60% opacity bg | Visible but not competing with map |
| Accent | `#4a4aff` blue-purple | Established |
| Start point marker | `#ffb020` gold, flag glyph on a dashed ring; solid ring when locked | Must not read as a token. Tokens are coloured circles, so the marker differs by **shape**, not only colour |
| Token state | Unconscious: a bar through the token. Dead: a cross. Alive: neither. Opacity drops with the state; the glyph is drawn at full strength over it | Colour is the only thing on the map that says *whose* token this is, so state may never spend it. Shape says what happened; the fade alone is a guess at fight zoom |
| Declaration pip | A dot on the target's ring, in the **attacker's** colour, in arrival order. Open: solid. Parried: hollow, the colour reduced to a ring. Not parried: solid with a hole punched in it. The damage number fills that hole once it is sent | Three pips on one orc are three named people, with no lines drawn across a map where tokens already overlap. The GM's own attacks carry a fixed colour, having no attacking token to take one from |
| Owing an input | The thing you owe breathes, on your screen and nobody else's: the token when it owes an answer, the pip when it owes a number | A pulse means *act*, not *look*. One that means look is noise in a fight, and one on somebody else's obligation is noise on every screen but theirs |
| Mode: Reveal | Green-tinted brush preview | Intuitive: green = go, clear |
| Mode: Fog | Red-tinted brush preview | Intuitive: red = stop, cover |
| Tap targets | 44pt minimum (Apple HIG), including hit tests | A target computed in image coordinates shrinks as the map zooms out; it needs a screen-space floor |
| Transitions | 200ms ease-out for expand/collapse | Smooth but not sluggish |
| Control style | Rounded, floating, Miro-inspired | Lightweight, modern, unobtrusive |
