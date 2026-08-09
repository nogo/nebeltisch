# Nebeltisch — Project

> **Scope of this file:** outcome, value, constraints, naming. *Why* the project exists and what bounds it.
> Stack, structure and engineering rules live in [architecture.md](architecture.md). Interface and interaction rules live in [design.md](design.md).

**Nebeltisch is a self-hosted, shared map with fog of war for remote pen & paper RPG sessions.**

---

## Outcome

A GM and their players see the same map in a browser. The GM controls what is visible; each player controls one token.

| Actor | Can do |
|---|---|
| GM | Create an adventure, upload maps, paint and un-paint fog with a round brush, undo/redo, place monster/NPC tokens, mark a per-map party start point, switch the active map, move any token, remove players, ping |
| Player | Join by link with a name and colour, move their own token, pan/zoom, ping |

Supporting properties:

- **Persistent.** Fog, tokens, maps and start points survive reloads, disconnects and server restarts.
- **Live.** Every change reaches every connected client over WebSocket without a refresh.
- **Self-hosted.** One container, one volume, no external services.

## Value

The group already has voice — a phone call carries the conversation. What a remote table lacks is the thing everyone leans over: **a map that only reveals what the party has seen.**

Nebeltisch supplies exactly that and nothing else.

- **Against a full VTT** (Roll20, Foundry): those solve dice, sheets, initiative and combat automation, which this group does on paper. Their map-and-fog is buried under everything else.
- **Against screen sharing:** players cannot move their own token, fog cannot be player-specific, and nothing persists between sessions.
- **Against nothing:** the GM describes rooms verbally and the party has no shared spatial picture.

The bet: a tool that does one job and stays out of the way beats a tool that does twenty jobs and demands setup.

## Constraints

### Audience

One GM and roughly three players, self-hosted by the GM, German-language RPG groups. Opinionated toward *Das Schwarze Auge* / Aventuria, but system-agnostic at the data layer — no rules, dice or stats are modelled.

### Devices

| Device | Role | Priority |
|---|---|---|
| Desktop + mouse | GM | Primary |
| Tablet + touch | Player, and GM when travelling | Primary |
| Phone | Not a map device | — |

**Phones run the group's voice call and are therefore unavailable for the map.** The tablet is the only player device in practice. Touch is not a secondary input mode.

### Session model

- **Preparation is a mode, not a stage.** Upload a page, set its start point, place monster and NPC tokens, reveal an area around the start point. Most of it happens before players join, but not all: the party talks in the tavern while the GM sets up the cellar, and comes back to it several times an evening.
- **Switching maps during play is traversal, not preparation.** Maps are connected spaces — a village, a mill, its floors, a cellar — and the party walks between them and back.
- **The GM prepares on a board; the players see one page.** An adventure is a canvas of pages the GM pans and zooms, and the live table is a state of that board rather than a separate place. What bounds the two apart is a single rule: **only the presented page reaches the players.** Everything else the GM does is stored and never leaves the server.

An earlier version of this document concluded the opposite — that the GM's canvas and the players' canvas are the same thing, and that no separate GM editing view should exist. That was protecting against the GM painting fog onto a map nobody is watching. The rule above protects against it better, because it is enforced by the server instead of by the absence of a screen. Superseded 2026-08-09; see #48 and the `One canvas` decision in [architecture.md](architecture.md).

### Authentication

No accounts today. The GM holds a password in a URL fragment; players hold an invite link. A GM account is planned so adventures can be managed across devices, and will not change how players join.

**GM is a relation, not a role.** There is one kind of account — a user — and you are the GM of an adventure because you own it. Registration is open, and the deployment stays behind HTTP basic auth until Nebeltisch is opened publicly; that gate decides who reaches the sign-up form.

**Player identity is untouched by this, deliberately.** Players keep joining by link with a name and a colour, with no account of any kind. GM authentication and player identity are separate problems, and only the first is needed to manage adventures — that seam is what keeps the project bounded, and community accounts stay out of scope behind it.

### Scope

**In:** maps, fog brush, undo/redo, player tokens, GM monster/NPC tokens, per-map start points, pings, pan/zoom, GM and player interfaces, Docker deployment. Committed on 2026-08-09 and not yet built: GM accounts and an adventure dashboard (#26), the preparation board (#48), and card pages carrying an image with no fog or tokens (#53).

**Out:** dice rolling, character sheets, initiative tracking, audio, rules automation, public/community hosting. Deferred ideas are tracked as GitHub issues.

A feature that belongs to the *rules* of a game is out of scope. A feature that belongs to the *map* is a candidate.

## Naming

**Nebeltisch** — German for "fog table".

- Names the core mechanic (fog) and the object it creates (a table you sit around).
- Reads as a noun, in the target audience's language.
- Unclaimed in the RPG tooling space.
