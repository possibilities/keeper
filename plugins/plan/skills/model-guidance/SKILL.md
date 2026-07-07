---
name: model-guidance
description: Author and refresh the selector policy config (plugins/plan/model-selector.yaml) — research each configured worker model, cache the raw signal under references/, distill it into the config's guidance blocks, and re-hash. Use when a model or effort is added to subagents.yaml, when a model alias is re-pointed to a newer version, or when the model-guidance drift gate fails.
argument-hint: "[blank to choose interactively · an axis value · missing · all]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Edit, Write, AskUserQuestion, Bash(shasum:*), Bash(bun plugins/plan/scripts/model-guidance-check.ts:*), WebSearch, WebFetch
---

# Model guidance

Own the content of `plugins/plan/model-selector.yaml` — the post-scaffold selector's policy
config. The config rides inside every selector brief, so it must stay short, concrete, and current;
this skill is how it gets authored and kept honest. The `selection-brief` verb and the orchestrators only
*read* the config — nothing regenerates it automatically. That is deliberate: model guidance is
researched judgment, and a human owns when it is refreshed.

The one section this skill never touches is the top-level `hand_tuned` block. That is human-owned
routing judgment — the binding sonnet-first burden-of-proof tie-break — hand-tuned directly by a
human, never authored or refreshed by a research pass. Leave it byte-untouched on every run; the
`efforts:`/`models:` guidance blocks and the `research:` map are this skill's scope.

The unit of work is one **axis value**. The `efforts:` and `models:` axes live in
`plugins/plan/subagents.yaml` (the single source of truth); this config must carry exactly one
guidance block per configured value and no block for a non-axis value. The drift gate enforces both
directions plus research-cache hash parity — keep it green.

## When to invoke

- A model or effort was added to `subagents.yaml` — backfill its guidance block (and, for a model,
  its research cache) here. The gate fails until you do.
- A model alias was re-pointed to a newer version — re-research it and re-distill.
- The drift gate (`bun plugins/plan/scripts/model-guidance-check.ts --check`) failed — reconcile
  the reported direction (missing block, extra block, missing research entry, or hash mismatch).

## Read the state envelope first

Every invocation starts by classifying what is already on disk:

```bash
bun plugins/plan/scripts/model-guidance-check.ts --state | jq .
```

It maps every configured axis value onto a fail-closed state — scope is *derived* from this, so you
never type a model name:

- **models** — `fresh` (a `researched` stamp WITH reference-hash parity, the only trustworthy
  state), `stale` (a `researched` stamp whose reference hash drifted), `stub` (a placeholder never
  actually researched), or `missing` (no guidance block, research entry, or reference file).
- **efforts** — each block is `present` or `missing`, and one shared `efforts_provenance` stamp
  (`researched` vs anything else → stub) covers the effort set as a whole. Treat the efforts axis as
  a single refresh unit named `efforts`: it is a **gap** when any effort block is missing OR the
  shared stamp is not `researched`. There is no per-effort research cache, so you cannot half-research
  it — one pass re-distills every band and re-stamps together.

A **gap** is any value that is not `fresh` — every `missing`, `stub`, or `stale` model, plus the
`efforts` unit when its stamp is not `researched`.

## Argument contract

- **blank** → the interactive state-driven flow below.
- **an axis value** (`opus`, `low`, …) → a scoped run on that one value, skipping the scope question.
  Validate the name against BOTH axes (efforts + models); on a miss, fail loud and list the configured
  values. If the named value is already `fresh`, confirm before spending a research pass on it.
- **`missing`** → non-interactive: fill every gap (each `missing`, `stub`, or `stale` value), no
  questions.
- **`all`** → wipe and re-research every value, behind exactly one confirm.

`missing` and `all` are reserved words, matched BEFORE the axis-value check — a future axis value must
never be named either one.

## The interactive flow (blank arg)

Read `--state`, then pick the lightest path the state allows — at most two `AskUserQuestion` calls,
often one, sometimes zero:

- **All fresh** (no gaps) → report the fresh table and ask one gentle question defaulting to
  *Nothing, exit*. Accepting the default is the whole flow: zero writes, no research.
- **Exactly one gap** → skip the menu; one *Fill `<value>` — proceed?* confirm, then research it.
- **Several gaps** → **Q1**, a single-select scope with the detected counts and names baked into the
  labels:
  1. *Fill gaps — N: `<names>`* — re-research only the non-fresh values, leaving fresh ones
     untouched. Listed first and recommended.
  2. *Refresh specific values…* — opens Q2.
  3. *Wipe & regenerate — git-recoverable* — re-research every value, fresh included. **Never** the
     default and never a multiSelect row.

  Choosing *Refresh specific* fires **Q2** as a SEPARATE `AskUserQuestion`: a multiSelect over the
  non-fresh values, each option's state in its description. `AskUserQuestion` caps four options per
  question, so when more than four values are non-fresh, drop the menu and list them as prose (at
  that scale *Fill gaps* or *Wipe* is the right scope anyway). An empty multiSelect is a cancel.

Wipe is destructive-by-scope: never a default, never auto-selected, and a non-interactive context
(the `missing` arg, an axis-value arg) never falls through into it.

## The research → cache → distill → re-hash pass

For each model in scope on the `subagents.yaml` `models:` axis:

1. **Research** the current capability signal — web (the model's own capability/behavior docs) plus
   in-repo worker experience. Focus on what a worker cares about: strengths, failure modes, and
   when to pick this tier over another.
2. **Cache** the raw research as a provenance-headed markdown at `references/<model>.md`. The first
   comment block is the provenance header — `model_id`, `resolves_to`, `researched` date, `status`,
   `method`, and `sources`. This file is the review point: depth and citations live here, never in
   the config.
3. **Distill** into `model-selector.yaml`:
   - `models.<model>` — a short behavioral block (strengths, weaknesses, when-to-pick). Prompt-sized;
     raw research stays in `references/`.
   - `efforts.<effort>` — for each configured effort in scope, concrete worker-facing advice on when
     to route a task to that band (difficulty and blast radius, not line count). When you refresh the
     efforts set, also author its provenance: `efforts_provenance.last_reviewed` (today) and
     `efforts_provenance.status`.
4. **Re-hash.** Recompute each touched reference file's sha256 and update `research.<model>.sha256`:
   ```bash
   shasum -a 256 plugins/plan/skills/model-guidance/references/<model>.md
   ```
   Then set `research.<model>.reference` to the path relative to the plan plugin root
   (`skills/model-guidance/references/<model>.md`).

## Status-stamp discipline

This skill is the ONLY writer of `status: researched` — both a model reference header's provenance
`status` and `efforts_provenance.status`. Stamp `researched` on a value ONLY after a real
research → cache → distill → re-hash pass on it. Any placeholder written just to keep the drift gate
green stamps `status: stub`; a stub reference still needs a valid header and a matching hash so the
gate passes, but it must never claim to be researched.

Freshness moves one way by hand. If you know a model alias has been re-pointed to a newer version
than the cache's `resolves_to` records — the deterministic gate cannot see an alias re-point — treat
the `fresh` value as `stale` and re-research it. Never the reverse: never stamp `researched` on
guidance you did not actually research to make a value read `fresh`.

## Verify

Run the drift gate and confirm it passes:

```bash
bun plugins/plan/scripts/model-guidance-check.ts --check
```

It asserts config↔axes coverage (both directions, for efforts and models) and config↔research-cache
hash parity (every configured model has a research entry whose recorded hash matches the file on
disk). The fast test suite (`plugins/plan/test/consistency-model-selector.test.ts`) asserts the same
check in-process, so a red gate is a red suite. Note the gate checks hash parity and coverage, not
freshness: a `stub`-stamped value with a matching hash passes `--check` but reads as a gap in
`--state`.

## Commit the pass

A pass that wrote anything ends with a commit, in the same turn the gate goes green — never hand
the tree back dirty or punt the commit to the human. (The all-fresh zero-write exit has nothing to
commit and skips this.) Commit via `keeper commit-work`, the standard commit seam (lint matrix +
commit + push in one call), never raw `git commit`:

```bash
keeper commit-work --preview-files
keeper commit-work "docs(plan): <what was researched or refreshed>"
```

The commit scope is exactly the pass's artifacts: `model-selector.yaml`, each touched
`references/<model>.md`, and any test that pins the on-disk guidance state. Unrelated dirty files
(concurrent workers often leave some) stay out — when the preview shows `commit-work` would sweep
in files outside the pass or miss one of its artifacts, fall back to plain git with explicit paths
(`git add <path> …`, never `-A` / `.`), then `git commit` + `git push`. On a `lint_failed`
envelope: fix the named files, re-stage, re-invoke `keeper commit-work` with the same message —
never bare `git commit` or `--no-verify` after a lint failure. Any other failure envelope surfaces
verbatim to the human.

## Cadence

The gate enforces hash *parity*, not *freshness* — a stale-but-consistent cache passes. Re-run the
research when the trigger fires: the `models:` axis changes, or a model alias is re-pointed to a
newer version. The provenance header in each `references/<model>.md` records when it was last done.

## Keep the blocks short

Every efforts:/models: block is loaded into the selector brief on every run. Distilled bands stay
a few sentences; if you find yourself pasting research prose, it belongs in `references/`, not the
config. Density over volume: each clause should change how the selector routes a task.
