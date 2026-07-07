---
name: matt-upgrade
description: >-
  Review upstream mattpocock/skills against the matt plugin's pin and the
  ~/docs/matt-skills-adoption.md ledger — report forked-skill drift, triage
  new upstream items, and flag watching items that moved. Analyzes and
  proposes only; a re-sync or adoption always routes to the plan tooling.
  Use when the human says "/matt-upgrade", wants to check for upstream
  Matt-skills changes, or asks whether anything from mattpocock/skills is
  worth adopting.
disable-model-invocation: true
argument-hint: "(optional) a bucket or skill name to focus on — defaults to a full triage"
---

# Matt Upgrade — sync-check against upstream skills

Review `mattpocock/skills` against the matt plugin's pin and the adoption ledger, and report what's worth re-syncing, adopting, or still watching. This is **analysis only** — its one write is a clustered ledger update landed on the human's word; any actual re-sync or adoption is out of contract and routes to the plan tooling. One run, one report, then you wait.

`$ARGUMENTS`, when non-empty, narrows the report to one bucket (`drift` / `new` / `watching`) or one named skill; empty runs the full triage. Either way, start at step 1.

## 1. Read the ledger (the scope)

Read `~/docs/matt-skills-adoption.md` first — its `## Pin`, `## Adopted`, `## Rejected`, `## Watching`, and `## Sync log` sections are the only state this skill has, and every verdict below is anchored to them so a settled call is never re-litigated without real cause.

**No ledger on disk** → say so plainly and stop. Never fabricate one or triage against an assumed baseline.

## 2. Acquire the upstream delta

The pin's local checkout lives at `/Users/mike/src/mattpocock--skills`.

- **Checkout present** (the common case): `cd` there and `git fetch origin` — depth-limited is fine, this only needs history back to the ledger's pinned sha. Resolve the upstream default branch dynamically (`git symbolic-ref refs/remotes/origin/HEAD` after fetch, or `git remote show origin`) rather than assuming a name.
- **Checkout absent**: clone `https://github.com/mattpocock/skills.git` into a scratch/temp directory instead — this session's scratchpad if one is available, otherwise a plain temp dir — and say in the report that the canonical checkout is missing. Never mint the persistent path yourself.
- **Fetch fails (offline)**: degrade — report from the ledger plus whatever the existing checkout already has on disk, and say plainly that the live fetch failed. Never error out.

Diff the ledger's pinned sha against upstream HEAD. Prefer the human-readable delta — `CHANGELOG.md` and new `.changeset/*` entries — over raw commit ranges; fall back to commit ranges only where changesets don't cover a change.

## 3. Triage three buckets

Anchor every verdict to the ledger — don't re-open a Rejected item without a concrete reason upstream changed, and don't re-propose an Adopted one.

- **Drift in the forked skills.** Every skill under `~/code/arthack/claude/matt/skills/*/SKILL.md` carrying an `upstream-path` frontmatter key is in scope (a new-build addition carries no such key and stays out of scope). For each: did its upstream path change since the pin? Recommend re-sync or not, in one line — a re-sync re-applies the fork transform documented in `~/code/arthack/claude/matt/README.md` and is a reviewed dependency bump and supply-chain surface, never an auto-merge; point at that transform, don't restate it.
- **New upstream items absent from the ledger.** Walk upstream `skills/` for anything with no matching entry in Adopted, Rejected, or Watching. Weigh each against keeper's existing coverage — the ledger's own Adopted/Rejected reasoning is the precedent for "already covered" — and recommend adopt / watch / skip with a one-line reason each.
- **Watching items that moved.** For every `## Watching` entry, check whether upstream state changed enough to earn a verdict move — an in-progress skill graduating, a referenced file meaningfully revised.

## 4. Report, then propose one clustered update

In chat: the delta summary (pinned sha → upstream HEAD, what changed) first, then each bucket's verdicts with recommendations.

Close with **one clustered ledger update**, offered as a single preview — the new `## Sync log` line plus any verdict moves (a Watching item promoted or dropped, a new item filed into a bucket) — and land it only on the human's explicit yes. The only file this skill ever edits is the ledger `.md` body; `~/docs/matt-skills-adoption.yaml` is a hook-owned sidecar and is never touched directly.

**A recommendation to act is never executed here.** When the human wants to act on one, route it — `/plan:plan` for multi-step work such as a forked skill's re-sync, `plan:defer` for a single bounded follow-up. This skill's only landed artifact, ever, is the ledger update above.

## Idempotent re-run

Same pinned sha, same upstream HEAD → the same triage, but say so plainly: note the delta is unchanged since the last `## Sync log` line rather than re-narrating a first-run-style report.
