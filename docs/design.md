# Nebeltisch — Design Principles

> **Scope of this file:** the aesthetic and the principles that govern every interface decision.
> The concrete gestures, controls and values they produce are in [interface.md](interface.md).
> *Why the project exists* is in [project.md](project.md). *How it is built* is in [architecture.md](architecture.md).

> The map IS the interface. Everything else gets out of the way.

---

## The aesthetic

**Full-canvas experience. Controls float at the edges — translucent, collapsible, Miro-style. GM and Player don't share a layout, but they share this visual language. The map dominates every pixel.**

That is the shape. What fills it is the name.

### Nebeltisch

A fog table: the thing a group sits around, where the map shows only what the party has walked into. The interface is built to *be* that table, not to be an application containing one.

**Everything but the map recedes into the dark.** The background is near-black navy so the map is the only lit thing on screen. Controls are translucent and backdrop-blurred, so they read as glass laid on the table rather than panels bolted to a window frame. No chrome bar, no borders that carry no information, no surface competing with the image the group is leaning over.

**The fog is the product, never decoration.** It is the mechanic, so it is also the atmosphere — the waiting screen is fog because nothing has been revealed yet, not because an empty state needed dressing. A player who watches it give way to a map has understood what they are using. Wherever the interface reaches for mood, the mood is already in the domain: fog, lamplight, a map on a dark table. It never has to be imported.

**Miro is the reference for the canvas, not for the mood.** Infinite space, rounded floating controls, pinch and pan as the primary navigation, no page edges in the chrome — all of that. But Miro is a bright office whiteboard, and this is a dark table with one lit map on it. Take the mechanics; leave the daylight.

---

## Principles

Rules for the next interface decision. Where a change conflicts with one, the conflict is the thing to discuss.

### 1. The map dominates every pixel

Full canvas. Chrome floats over the map; it never frames it, never resizes it, never takes a column beside it. A sheet slides over the canvas — it does not push it.

*A surface that would shrink the map is the wrong surface.*

### 2. Controls sit at the edges, in one place

One floating toolbar, bottom centre, holding every control for the role. Nothing floats over the middle of the map, and no control opens a second permanent surface somewhere else.

*A control that does not fit the toolbar is a control whose job has not been thought through.*

### 3. Subtract before adding

**Minimal here means subtracted, not styled to look sparse.** A new control must displace one, absorb one, or justify the pixel it costs. Before adding a surface, ask which existing gesture could carry the job instead.

*Every control this interface has lost was lost that way: zoom replaced the map list, the board replaced the thumbnail strip, dragging the marker replaced the button that created one. Brush size came off a left-edge slider and the map panel off the right edge, and the edges are now empty.*

### 4. Zoom is the navigation

Pinch out for the whole adventure, pinch in until a page fills the screen. No list, no thumbnail strip, no prev/next arrows, nothing that names a page in a sidebar.

*Spatial arrangement is the GM's memory of their own adventure. A list would replace it with an order the GM did not choose.*

### 5. Nothing disappears because time passed

No idle fade-outs, no auto-hide, no timers. Collapsing is user-initiated, and what the user collapsed stays collapsed.

*One exception, and it must keep the shape of that one: chrome may recede for exactly as long as a gesture the user is making, and return the instant it ends.*

### 6. No modes

The GM has one view and it does not change. Preparing and presenting are things done on that screen, not states switched between; pan and draw are told apart by the gesture, not by a toggle. Arming a tool changes what an empty patch of page does — never what the objects standing on it do.

*A GM-side mode is especially tempting and especially wrong where the server already holds the answer: which page is presented is a server fact, and a browser's opinion layered on top could only agree or disagree with it. Disagreeing is the failure.*

### 7. Touch is a primary input, so targets have a screen-space floor

The tablet is the only device the players actually use, and stylus on tablet is a first-class GM input — fog painting on a phone is not a goal. A hit test computed in map coordinates shrinks as the map zooms out, so every interactive target needs a minimum measured in screen pixels: 44pt, per Apple HIG.

*A 20px token was an 8px target at fit zoom, which made the tablet unusable.*

### 8. State reads on the object, not in a panel

What is selected, grabbed, locked or live says so where it is: the grabbed thing marks itself before it moves, the live page carries a badge, a locked marker's ring goes solid. Cues are placed to survive the hand making the gesture — a fingertip covers roughly 44pt, so anything drawn on the object is hidden by the finger holding it.

*Where two things must never be confused, they differ by shape, not only by colour.*

### 9. An act with an audience takes two steps

Anything the players see the moment it happens is select-then-press, never a single tap. During play the control that switches rooms sits next to the page the party is looking at.

*A mis-tap must not show the party somewhere they have not walked.*

### 10. The player's surface is near zero, and their view is bounded

A name, a colour dot, and the map. One page, no zooming out past it, no panning it off the edge.

*There is nothing beyond their page to find, so the freedom would only buy them a way to lose the map.*

### 11. GM and Player share a language, not a layout

Two roles, two layouts, one visual language: the same dark ground, the same translucent glass, the same tokens, the same gestures where a gesture exists for both. A player who sits down at the GM's screen should recognise the table, not learn a second product.

*The layouts diverge because the jobs do. Nothing else may diverge without a reason of that weight.*

---

## What this is not

- **Not a phone app.** Phones carry the group's voice call and are not used for the map.
- **Not a full VTT.** Scope is bounded in [project.md](project.md); a feature belonging to the rules of a game is out.
- **Not a bright canvas tool.** The Miro reference is about how a canvas behaves, not about how it looks. Nothing gets lighter than the map.
- **Never controls over the middle of the map.** The toolbar sits on the bottom edge, horizontally centred.
- **No idle auto-hide.** Nothing disappears because time passed — see principle 5 for the one gesture-linked exception.

---

## Applying these

The interface these produce is written out in [interface.md](interface.md). When the two disagree, the principle wins and the interface is the thing to change.
