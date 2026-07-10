---
name: model-guidance
description: Author and refresh the selector policy config (plugins/plan/model-selector.yaml) — research each configured worker model, cache the raw research notes plus the vendor's own system card under references/, distill the notes into the config's guidance blocks, and re-hash both. Use when a model or effort is added to the host matrix's subagent_models, when a model's launch id is re-pointed to a newer version, or when the model-guidance drift gate fails.
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

The unit of work is one **axis value**. The `efforts:` axis and the `models:` axis live in the
required host matrix (`~/.config/keeper/matrix.yaml`'s `efforts:` and `subagent_models:` — the
single source of truth); this config must carry exactly one guidance block per configured value and
no block for a non-axis value. `--state` classifies coverage against that matrix; `--check` stays
fully offline and enforces research-cache hash parity — notes AND every declared vendor card — keep
both green.

## When to invoke

- A model or effort was added to the host matrix's `subagent_models` / `efforts:` — backfill its
  guidance block (and, for a model, its research cache and vendor card) here. The gate fails until
  you do; `--state` classifies the new model `missing` and the interactive flow offers to fill it.
- A model's launch id was re-pointed to a newer version upstream — re-research it and re-distill.
  This is the one staleness case the deterministic gate cannot see on its own; a human notices and
  triggers the re-research.
- The drift gate (`bun plugins/plan/scripts/model-guidance-check.ts --check`) failed — reconcile
  the reported direction (missing block, extra block, missing research entry, or a notes/card hash
  mismatch).

## Read the state envelope first

Every invocation starts by classifying what is already on disk:

```bash
bun plugins/plan/scripts/model-guidance-check.ts --state | jq .
```

It maps every configured axis value onto a fail-closed state — scope is *derived* from this, so you
never type a model name. Each `models.<model>` entry carries `state`, `hash_parity`, `card_present`,
`card_hash_parity`, and `reasons` — the last four are the stable jq contract, byte-aligned with
`plugins/plan/scripts/model-guidance-check.ts`:

- **state** — `fresh` (researched notes WITH hash parity AND a present, hash-matching card — the
  only trustworthy state), `stale` (researched notes whose notes hash drifted, OR notes fresh but
  the card's hash drifted), `stub` (notes never actually researched — card irrelevant below this
  gate), or `missing` (no guidance block, research entry, or notes file, OR notes researched-with-
  parity but no card resolves on disk — a declared-but-missing-file card reads exactly like no
  card).
- **card_present** — a card is declared AND its file resolves on disk; `card_hash_parity` —
  recorded-vs-actual card hash, `null` when no card is present.
- **reasons** — every contributing cause the model is not `fresh`, drawn exactly from `no-block`,
  `no-research-entry`, `no-notes-file`, `notes-not-researched`, `notes-hash-drift`, `no-card`,
  `card-hash-drift`; **empty exactly when `fresh`**.
- **efforts** — each block is `present` or `missing`, and one shared `efforts_provenance` stamp
  (`researched` vs anything else → stub) covers the effort set as a whole. Treat the efforts axis as
  a single refresh unit named `efforts`: it is a **gap** when any effort block is missing OR the
  shared stamp is not `researched`. There is no per-effort research cache, so you cannot half-research
  it — one pass re-distills every band and re-stamps together.

A **gap** is any model value that is not `fresh`, plus the `efforts` unit when its stamp is not
`researched`. A model whose `reasons` is exactly `[no-card]` is a **card-only gap** — its notes are
already `researched` with parity; see the card-fetch-only shortcut below.

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
- **Exactly one gap** → skip the menu; one *Fill `<value>` — proceed?* confirm, then research it. A
  card-only gap (`reasons` exactly `[no-card]`) confirms a card-fetch-only pass instead — its notes
  are already researched, so skip straight to step 2 of the pass below.
- **Several gaps** → **Q1**, a single-select scope with the detected counts and names baked into the
  labels. The gap-row label is adaptive: when every gap is missing-class (`state: missing` — never
  researched at all, no partial cache to preserve) it reads *Fill new values — N: `<names>`*;
  otherwise (any `stub` or `stale` value in the mix) it reads *Fill gaps — N: `<names>`*.
  1. *Fill new values — N: `<names>`* / *Fill gaps — N: `<names>`* (adaptive label above) —
     re-research only the non-fresh values, leaving fresh ones untouched. Listed first and
     recommended.
  2. *Refresh specific values…* — opens Q2.
  3. *Wipe & regenerate — git-recoverable* — re-research every value, fresh included. **Never** the
     default and never a multiSelect row.

  In every gap-listing view (Q1's labels, Q2's per-option descriptions, the state table), name each
  gap's WHY straight from its `reasons` array rather than restating raw state — a bare `stale` tells
  a human nothing about which hash drifted.

  Choosing *Refresh specific* fires **Q2** as a SEPARATE `AskUserQuestion`: a multiSelect over the
  non-fresh values, each option's state in its description. `AskUserQuestion` caps four options per
  question, so when more than four values are non-fresh, drop the menu and list them as prose (at
  that scale *Fill gaps* or *Wipe* is the right scope anyway). An empty multiSelect is a cancel.

Wipe is destructive-by-scope: never a default, never auto-selected, and a non-interactive context
(the `missing` arg, an axis-value arg) never falls through into it.

## The research → fetch card → cache both → distill → re-hash pass

For each model in scope on the host matrix's `subagent_models:` axis:

1. **Research** the current capability signal — web (the model's own capability/behavior docs) plus
   in-repo worker experience. Focus on what a worker cares about: strengths, failure modes, and
   when to pick this tier over another.
2. **Fetch the vendor's own system card.** Record TWO URLs as you go — the durable discovery URL
   (the vendor's stable index/landing page) and the resolved artifact URL actually fetched (vendor
   CDN/PDF paths are content-addressed and rot, so the discovery URL is what a future re-research
   pass re-resolves from). Cards are PDF-first — treat PDF extraction as the primary conversion
   path, markdown-only in the tree. A card-only gap (a model whose `--state` `reasons` is exactly
   `[no-card]`) needs only this step and step 3's card half — its notes are already researched, skip
   straight here.
3. **Cache both.**
   - The raw research notes as a provenance-headed markdown at `references/<model>.md`. The first
     comment block is the provenance header — `model_id`, `resolves_to`, `researched` date, `status`,
     `method`, and `sources`. This file is the review point: depth and citations live here, never in
     the config.
   - The converted card as provenance-headed markdown at `references/cards/<model>.md`, distinct
     from the notes file (the gate rejects a card path equal to its notes reference as a copy-paste
     error). Its header records both URLs from step 2, the converter used, and — optionally, as a
     cheap re-research signal — the fetch's ETag/Last-Modified. Retain the vendor's copyright notice
     in the cached body. Keep the file size-bounded: it is a converted capability doc, not a mirror
     of the full PDF.
4. **Distill** into `model-selector.yaml`:
   - `models.<model>` — a short behavioral block (strengths, weaknesses, when-to-pick). Prompt-sized;
     raw research stays in `references/`.
   - `efforts.<effort>` — for each configured effort in scope, concrete worker-facing advice on when
     to route a task to that band (difficulty and blast radius, not line count). When you refresh the
     efforts set, also author its provenance: `efforts_provenance.last_reviewed` (today) and
     `efforts_provenance.status`.
5. **Re-hash.** Recompute each touched reference file's sha256 and update the matching config field —
   `research.<model>.sha256` for the notes, `research.<model>.card.sha256` for the card:
   ```bash
   shasum -a 256 plugins/plan/skills/model-guidance/references/<model>.md
   shasum -a 256 plugins/plan/skills/model-guidance/references/cards/<model>.md
   ```
   Set `research.<model>.reference` and `research.<model>.card.reference` to their paths relative to
   the plan plugin root (`skills/model-guidance/references/<model>.md` and
   `skills/model-guidance/references/cards/<model>.md`). The gate hashes only the committed markdown,
   never upstream bytes, and never parses either file's provenance header — presence + hash only.

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

`--check` is fully offline and HOST-BLIND — no axis read, so it stays green with no host matrix
present. It asserts (a) structural validation (the config coerces — a malformed section fails loud)
and (b) research-cache hash parity: every configured research entry's notes reference AND any
declared vendor card both exist on disk and their recorded sha256 matches the file, presence + hash
only — the gate never parses either file's provenance header. The fast test suite
(`plugins/plan/test/consistency-model-selector.test.ts`) asserts the same check in-process, so a red
gate is a red suite. Note the gate checks hash parity, not freshness: a `stub`-stamped value with a
matching hash passes `--check` but reads as a gap in `--state`, and axis coverage against the host
matrix is a `--state` concern, not `--check`'s.

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
`references/<model>.md` and `references/cards/<model>.md`, and any test that pins the on-disk
guidance state. Unrelated dirty files
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
