---
name: issues
description: Manage the Nebeltisch backlog on the GitHub issue tracker — file a bug, story or idea, triage, groom, close, or report status. Use whenever work is captured, prioritised, split, or closed, and whenever someone says "file that", "open an issue", "what should I work on", "what's left", or asks about milestones, priorities or the backlog.
---

# Nebeltisch issue tracker

The tracker is the plan. `docs/` holds what is true; issues hold what is next.
`gh` is already authenticated against `nogo/nebeltisch`.

## The rule that everything else serves

**One issue, one outcome, observable at the table.**

A GM or a player must be able to look at the running app and say whether it is done. An issue whose
acceptance criteria name a function, a column or a file is written from the wrong side.

## Four types, exactly one per issue

| Type | Label | It answers | Template |
|---|---|---|---|
| Bug | `bug` | Something promises X and does Y | `.github/ISSUE_TEMPLATE/bug.yml` |
| User story | `user story` | This is going to be built | `.github/ISSUE_TEMPLATE/story.yml` |
| Idea | `wish` | Worth recording, not committed | `.github/ISSUE_TEMPLATE/idea.yml` |
| Chore | `chore` | Internal quality, no symptom at the table | `.github/ISSUE_TEMPLATE/chore.yml` |

**Bug and chore are separated by observability, not by size.** If a GM or a player would notice it,
it is a bug however internal the fix. If nobody at the table could ever see it, it is a chore
however serious. A chore must name what it lets through — one that cannot is a preference, and
preferences are closed.

**Read the matching template before writing the body.** It is the section list, and it is the
contract. The web form and this skill produce the same issue — the forms only fire in the browser,
so when creating with `gh` you supply the sections yourself.

An idea becomes a story when it is going to be built. Rewrite it as a story; do not promote it in
place — the sections are different and the idea's "why this is not scheduled" is now false.

### Modifier labels, added on top of the type

`security` · `documentation` · `epic` (an epic tracks children and closes when they do)

### Retired labels

`enhancement` predates the four types. **Never add it to an issue.** It was cleared from every open
issue on 2026-08-04 and survives only on closed ones, where it is history — do not delete the label
or that history goes with it.

## Titles

The title is the outcome, in lowercase prose, no trailing period.

- **Never prefix with the type.** No `Wish:`, `Story:`, `Bug:`, `Feature:`. The label says that.
  These were stripped on 2026-08-04; do not reintroduce them.
- **Bugs name the defect, not the fix.**
  `Undo destroys all fog painted before the current page load` — not `Fix undo`.
- **Stories name the outcome, not the mechanism.**
  `Mark a map start point, and gather the party there` — not `Add start_x/start_y columns`.
- A colon is fine when it separates a subject from its symptom:
  `GM cannot delete a map: endpoint exists, no UI calls it`.

## Priority

Exactly one, always set. It answers "when does this hurt", not "how hard is it".

| Label | Meaning |
|---|---|
| `P0` | Blocks the next session. The group cannot play. |
| `P1` | Next cycle. |
| `P2` | Before opening it to other GMs. |
| `P3` | Backlog. Every idea is P3 by definition. |

If a P0 exists, nothing else is being worked on.

## Milestones

Exactly one, always set. The milestone is *when*; the priority is *how much it hurts*.

| Milestone | Holds |
|---|---|
| `Next cycle` | P0/P1 defects and the stories being built now |
| `Hardening` | P2/P3 correctness, security and cleanup — before other GMs get it |
| `GM Account` | Everything blocked on there being accounts |
| `Wishes` | Every idea |
| `Session <date>` | Closed cycles. Historical; do not add to one |

A new dated milestone is created only when a cycle actually starts.

## Writing the body

Follow the template's sections in order. Beyond that:

- **Acceptance criteria are `- [ ]` checkboxes.** Group them under `###` headings once there is more
  than one group. Tick them as they land — a half-ticked story shows real progress and is the reason
  to prefer checkboxes over prose.
- **Cross-reference with `#n`.** GitHub links it both ways for free. When a bug was found while
  building a story, say so in both.
- **Date anything from a session.** `Raised 2026-08-03`, `Refined with the GM after testing in
  production`. Relative dates rot.
- **Record the cause, never guess it.** Architecture principle 10: verify against reality before
  building on an assumption. An empty Cause section is honest; a wrong one costs hours.
- **Re-verify before acting on an old issue.** Run the command, grep the file, read the line. Line
  numbers in a body rot; comment the corrected ones rather than trusting them. On 2026-08-04 a full
  pass found three issues whose stated blocker had already shipped and one whose body was half
  wrong — none of that was visible without running the code.
- **Quote the principle a bug broke.** `docs/architecture.md` lists ten, and most were written
  because something in this tracker violated them.
- **Out of scope is load-bearing.** It is what makes a story closable. Per `docs/project.md`, a
  feature belonging to the rules of a game is out of scope; a feature belonging to the map is a
  candidate.

Write bodies to a file and pass `--body-file`. Heredocs mangle backticks and `$`.

## Commands

```bash
# Create — write the body to a scratch file first
gh issue create --title "…" --body-file /tmp/issue.md \
  --label bug --label P1 --milestone "Next cycle"

# The backlog, most urgent first
gh issue list --state open --json number,title,labels,milestone \
  --jq 'sort_by(.labels|map(.name)|map(select(startswith("P")))|first)
        | .[] | "\(.number)\t\(.labels|map(.name)|join(","))\t\(.title)"'

# One milestone
gh issue list --milestone "Next cycle" --state open

# Retitle, relabel, remilestone
gh issue edit 42 --title "…" --add-label P1 --remove-label P2 --milestone "Next cycle"

# Close, always with the reason
gh issue close 42 --comment "Fixed in <sha>. <what changed, one line>"
gh issue close 42 --reason "not planned" --comment "<why>"
```

## Triage — a new report

1. **Is it already there?** `gh issue list --state all --search "<keywords>"`. Comment on the
   existing issue rather than opening a near-duplicate.
2. **Is it in scope?** Rules of a game → close as not planned, citing `docs/project.md`. Map → continue.
3. **Bug, story or idea?** Something that already promises otherwise is a bug, even when the fix
   looks like a feature.
4. **One outcome, or several?** Several → open the story, then split. See below.
5. **Small and unspecified?** A one-liner belongs in the idea backlog #41, not in its own issue.
   Split it out when it is taken seriously enough to specify.
6. Label type + priority, set the milestone, write the body from the template.

## Splitting

A story that cannot be closed in one sitting becomes an `epic` plus children. Real examples: #36
spawned #35, #37, #38, #39 as its bugs surfaced in play.

Each child is independently closable and carries its own priority — children are often more urgent
than the parent. The epic closes when they do.

Split when the story is *taken*, not when it is filed. Splitting a P3 idea into five issues is five
issues nobody reads.

## Closing

- Close from the commit that fixed it, and name the sha in the comment.
- Tick the acceptance criteria first. Untickable criteria mean it is not closed.
- **A story closes only when its acceptance criteria are ticked or explicitly dropped.** Dropped
  ones move to Out of scope with a sentence saying why.
- Close as `not planned` for anything out of scope, and say which line of `docs/project.md` decided it.
- If the fix established an invariant, add it to the principles in `docs/architecture.md`. That list
  is the tracker's residue — every entry is a bug that already happened.
- **If the issue is named in a `[violated — #n]` marker there, remove the marker.** Principles 4, 8
  and 9 carry one today. A principle that still advertises a breach after the breach is fixed is the
  same failure as a doc that never mentioned it.

## What does not belong in an issue

- Anything already true of the code. That is `docs/architecture.md`.
- Anything about why the project exists or what bounds it. That is `docs/project.md`.
- Interface and interaction rules. That is `docs/design.md`, where unbuilt intent is marked
  **[not implemented]** rather than filed.

When a doc and an issue disagree, the doc is wrong or the issue is stale. Fix one; never leave both.
