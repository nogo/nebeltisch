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

- **Preparation happens before players join.** Upload a map, set its start point, place monster and NPC tokens, reveal an area around the start point.
- **Switching maps during play is traversal, not preparation.** Maps are connected spaces — a village, a mill, its floors, a cellar — and the party walks between them and back.
- Therefore the GM's canvas and the players' canvas are the same thing. There is no separate GM editing view.

### Authentication

No accounts today. The GM holds a password in a URL fragment; players hold an invite link. A GM account is planned so adventures can be managed across devices, and will not change how players join.

### Scope

**In:** maps, fog brush, undo/redo, player tokens, GM monster/NPC tokens, per-map start points, pings, pan/zoom, GM and player interfaces, Docker deployment.

**Out:** dice rolling, character sheets, initiative tracking, audio, rules automation, public/community hosting. Deferred ideas are tracked as GitHub issues; see [ROADMAP.md](ROADMAP.md) for older notes.

A feature that belongs to the *rules* of a game is out of scope. A feature that belongs to the *map* is a candidate.

## Naming

**Nebeltisch** — German for "fog table".

- Names the core mechanic (fog) and the object it creates (a table you sit around).
- Reads as a noun, in the target audience's language.
- Unclaimed in the RPG tooling space.
