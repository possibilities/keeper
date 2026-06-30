## Description

**Size:** S
**Files:** plugins/keeper/skills/handoff/SKILL.md, plugins/plan/skills/defer/SKILL.md

Reword two hand-authored-static skill descriptions (and handoff's body) so
any imperative use of "handoff" routes to `keeper:handoff` instead of
mis-routing to `plan:defer`. The frontmatter `description` is the
load-bearing surface — it is the only text the model sees when choosing a
skill. Both files are hand-authored static (no `.tmpl`, no
`.managed-file-dont-edit` sidecar) — edit in place.

### Approach

1. **Replace the handoff frontmatter `description`** (`plugins/keeper/skills/handoff/SKILL.md`, the `description: >-` block) with this verified wording (913 chars / 923 bytes, ≤1024 — keep it under the cap if you adjust):

   > Hand a piece of work off to a fresh fire-and-forget claude worker via `keeper handoff` (one call; a keeperd worker boots it inline in your tmux session). Use whenever the human imperatively says "handoff" — "hand this off", "send a handoff", "handoff to/in the <repo> project" (cross-repo is just `--dir`, still a handoff), "create handoffs", "spawn someone to investigate X" — or otherwise wants to pass a contextful task to a separate worker and walk away, even when they never say "keeper". This passes LIVE work to a worker; it is NOT authoring a markdown handoff DOCUMENT (a `.md` write-up) — for a written doc, just write the file. NOT for capturing/queuing a follow-up to track on the board (that is `plan:defer` — scaffolds an epic, dispatches no worker), NOT a plan-id launch (`keeper:dispatch` — `work::fn-N.M` / `close::fn-N`), NOT messaging a running agent (`keeper:bus`), NOT planning (`/plan:plan`).

   Key moves vs the current text: center the trigger on imperative "handoff" with "send a handoff" and "handoff to/in the <repo> project" as named variants; advertise cross-repo as `--dir` (still a handoff); add the reciprocal `plan:defer` negative clause keyed on action-type (dispatch-a-worker vs scaffold-a-board-epic), NOT now-vs-later (the misfire string itself reads later-flavored); trim the old mechanics sentence to stay under the char cap; keep the dispatch / bus / plan negatives and the `.md`-document carve-out intact.

2. **Replace the defer frontmatter `description`** (`plugins/plan/skills/defer/SKILL.md`, the `description: >-` block) with this verified wording (432 chars):

   > Capture the conversation's currently actionable work as a single normal-priority plan epic (no queue jump). Use when the human says "defer", "save for later", "put on the list", or wants a small follow-up tracked without interrupting current work. NOT for "send a handoff" / "handoff to <repo>" or otherwise dispatching live work to a separate worker — that is `keeper:handoff` (defer only scaffolds a board epic, spawns no worker).

   This only ADDS a reciprocal near-miss; defer's claimed scope is unchanged, so `plugins/plan/README.md`'s defer taxonomy row stays accurate (no edit there). Do not introduce the literal token `queue_jump` (the existing "no queue jump" with a space is fine).

3. **Update handoff's body for consistency** (`## When this fires` list and the `**Near-miss exclusions**` list, around lines 38–61):
   - Add one cross-repo trigger example to `## When this fires`, e.g. *"Send a handoff in the arthack project to work on it."* — a handoff launched in another repo via `--dir`; a cross-repo target is not a reason to defer.
   - Add one `plan:defer` near-miss bullet to the exclusions: a temporal "when done…" or cross-repo framing does NOT downgrade a handoff to a defer — when the human says "handoff" or wants a worker to work on it, it is THIS skill; `/plan:defer` only tracks a follow-up on the board and dispatches no worker.
   - Leave the existing "write a handoff doc → just write the file" carve-out bullet intact.

4. **Verify**: handoff description ≤1024 chars (see epic Quick commands); `cd plugins/plan && bun test` green (the defer consistency test checks `name: defer`, mutating-verb presence, fenced `keeper plan <verb>` resolution, and absence of the `queue_jump` literal — the description edit must not trip these); all new prose forward-facing (no provenance/dates/fn-ids, no "now also triggers…").

### Investigation targets

**Required** (read before coding):
- plugins/keeper/skills/handoff/SKILL.md:3-15 — current frontmatter description (edit target)
- plugins/keeper/skills/handoff/SKILL.md:38-61 — `## When this fires` + `**Near-miss exclusions**` body (edit target); carve-out to preserve at :53-55
- plugins/keeper/skills/handoff/SKILL.md:82-85,113 — `--dir` capability (factual basis for the cross-repo trigger signal)
- plugins/plan/skills/defer/SKILL.md:3-7 — current frontmatter description (no near-miss clause — the reciprocal gap)
- plugins/plan/test/consistency-skills.test.ts — defer gates (name, no `queue_jump`, fenced `keeper plan` verb resolution); confirm the edit stays green

**Optional** (reference as needed):
- plugins/keeper/skills/dispatch/SKILL.md:3-15 — house pattern for reciprocal `NOT for X (that is Y)` negative clauses

## Acceptance

- [ ] handoff frontmatter description triggers on imperative "handoff", "send a handoff", and "handoff to/in the <repo> project"; advertises cross-repo via `--dir`; carries a reciprocal negative clause naming `plan:defer` distinguished by action-type; ≤1024 chars
- [ ] defer frontmatter description carries a reciprocal near-miss naming `keeper:handoff` for send-a-handoff / dispatch-live-work intent; defer's claimed scope unchanged; no `queue_jump` literal introduced
- [ ] handoff body `## When this fires` gains a cross-repo handoff example and the near-miss list gains a `plan:defer` exclusion; the markdown-document carve-out preserved in both frontmatter and body
- [ ] `cd plugins/plan && bun test` green
- [ ] all edited/added prose is forward-facing (no provenance, dates, or fn-ids)

## Done summary

## Evidence
