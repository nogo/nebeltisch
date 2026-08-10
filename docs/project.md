# Nebeltisch — Project

> **Scope of this file:** outcome, value, constraints, naming. *Why* the project exists and what bounds it.
> Stack, structure and engineering rules live in [architecture.md](architecture.md). Design principles live in [design.md](design.md), and the interface they produce in [interface.md](interface.md).

**Nebeltisch is a self-hosted, shared map with fog of war for remote pen & paper RPG sessions.**

---

## Outcome

A GM and their players see the same map in a browser. The GM controls what is visible; each player controls one token.

| Actor | Can do |
|---|---|
| GM | Own an adventure and the pages in it, decide which page the table sees, and do every kind of map work — fog, tokens, start points — on any page, presented or not |
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

- **Preparation is an activity, not a stage.** Upload a page, set its start point, place monster and NPC tokens, reveal an area around the start point. Most of it happens before players join, but not all: the party talks in the tavern while the GM sets up the cellar, and comes back to it several times an evening. It is not a *mode* either — the GM never switches into it; see principle 6 in [design.md](design.md).
- **Switching maps during play is traversal, not preparation.** Maps are connected spaces — a village, a mill, its floors, a cellar — and the party walks between them and back.
- **The GM prepares on a board; the players see one page.** An adventure is a canvas of pages the GM pans and zooms, and the live table is a state of that board rather than a separate place. What holds the two apart is a single rule, enforced by the server rather than by the absence of a screen: **only the presented page reaches the players.** Everything else the GM does is stored and never leaves the server. See the `Only the presented page reaches the players` decision in [architecture.md](architecture.md).

### Authentication

No accounts today. The GM holds a password in a URL fragment; players hold an invite link. A GM account is planned so adventures can be managed across devices, and will not change how players join.

**GM is a relation, not a role.** There is one kind of account — a user — and you are the GM of an adventure because you own it. Registration is open, and the deployment stays behind HTTP basic auth until Nebeltisch is opened publicly; that gate decides who reaches the sign-up form.

**Player identity is untouched by this, deliberately.** Players keep joining by link with a name and a colour, with no account of any kind. GM authentication and player identity are separate problems, and only the first is needed to manage adventures — that seam is what keeps the project bounded, and community accounts stay out of scope behind it.

### Scope

**In:** the map and everything the table does to it — pages, the fog brush and its history, player tokens, GM monster and NPC tokens, party start points, pings, pan and zoom, the GM's board and what it presents, the two interfaces, and self-hosted deployment. GM accounts and an adventure dashboard are committed and not yet built.

**Out:** dice rolling, character sheets, initiative tracking, audio, rules automation, public/community hosting.

**The test:** a feature that belongs to the *rules* of a game is out of scope. A feature that belongs to the *map* is a candidate.

Two things this test does not settle, and both have been decided against once already: a **GM-side mode** on top of what the server already knows, and a **second kind of page** that the player client renders differently. Both are map features by the test above and were still wrong. Reach for principle 6 and principle 3 in [design.md](design.md) before either comes back.

What is planned, in progress or rejected lives in the issue tracker, not here.

## Naming

**Nebeltisch** — German for "fog table".

- Names the core mechanic (fog) and the object it creates (a table you sit around).
- Reads as a noun, in the target audience's language.
- Unclaimed in the RPG tooling space.
