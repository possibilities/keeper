---
name: model-guidance
description: Author and refresh the selector policy config (plugins/plan/model-selector.yaml) and the cross-provider equivalence map (plugins/plan/provider-equivalence.yaml) — research each configured worker model, cache the raw research notes plus the vendor's own system card under references/, distill the notes into the config's guidance blocks, author/refresh the model's equivalence entries in both directions, and re-hash. Use when a model or effort is added to the host matrix's subagent_models, when a model's launch id is re-pointed to a newer version, or when the model-guidance drift gate fails.
argument-hint: "[blank to choose interactively · an axis value · missing · all]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Edit, Write, AskUserQuestion, Bash(shasum:*), Bash(bun plugins/plan/scripts/model-guidance-check.ts:*), WebSearch, WebFetch
---

# Model guidance

Own two committed artifacts: `plugins/plan/model-selector.yaml`, the post-scaffold selector's
policy config, and `plugins/plan/provider-equivalence.yaml`, the cross-provider worker-cell
equivalence map (ADR 0047). The config rides inside every selector brief, so it must stay short,
concrete, and current; the equivalence map is read at dispatch by the `worker_provider` pin to
translate an assigned cell into the pinned provider family. Both are researched judgment kept
honest by this skill. The `selection-brief` verb and the orchestrators only *read* the config, and
the dispatch-time translation seam only *reads* the equivalence map — nothing regenerates either
automatically. That is deliberate: model guidance is researched judgment, and a human owns when it
is refreshed.

The one section this skill never touches on its own is the top-level `hand_tuned` block. That is
human-owned routing judgment — the binding model-axis tie-break — never authored or refreshed by a
research pass. Leave it byte-untouched on every run; the `efforts:`/`models:` guidance blocks and
the `research:` map are this skill's scope. When the human dictates a `hand_tuned` change through a
session, transcribing their policy is in-bounds — and reconcile the surfaces that restate the
family split in the same pass (`usage:`, the `plan:model-selector` agent prompt, and the
consistency test's pinned phrasing) so no selector brief ships a self-contradiction.

The unit of work is one **axis value**. The `efforts:` axis and the `models:` axis live in the
required host matrix (`~/.config/keeper/matrix.yaml`'s `efforts:` and `subagent_models:` — the
single source of truth); the config must carry exactly one guidance block per configured value and
no block for a non-axis value, and the equivalence map must carry, in the direction each
dispatchable `{model, effort}` cell's family requires, exactly one entry per cell targeting the
opposite family — never a same-family target. `--state` classifies coverage against that matrix for
both artifacts; `--check` stays fully offline and enforces research-cache hash parity (notes AND
every declared vendor card) plus the equivalence map's own structural well-formedness — keep all
green.

## When to invoke

- A model or effort was added to the host matrix's `subagent_models` / `efforts:` — backfill its
  guidance block (and, for a model, its research cache, vendor card, and both-direction
  equivalence entries) here. The gate fails until you do; `--state` classifies the new model
  `missing` and reports its now-unmapped dispatchable cells as equivalence gaps; the interactive
  flow offers to fill both together.
- A model's launch id was re-pointed to a newer version upstream — re-research it, re-distill, and
  re-author its equivalence entries in both directions. This is the one staleness case the
  deterministic gate cannot see on its own; a human notices and triggers the re-research. The
  re-point stales the affected equivalence entries exactly as it stales the notes — never leave a
  re-pointed model's old entries in place on the assumption they still hold.
- The drift gate (`bun plugins/plan/scripts/model-guidance-check.ts --check`) failed — reconcile
  the reported direction (missing block, extra block, missing research entry, a notes/card hash
  mismatch, or a malformed/non-total/same-family equivalence entry).

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

The same envelope carries an `equivalence` field (`total`, `gaps`, `dangling_targets`) — the
cross-provider map's own state, classified alongside the guidance blocks. An **equivalence gap** is
a dispatchable cell absent from the direction its family requires; a **dangling target** is an
authored entry whose target no longer resolves on the live matrix (a `target-not-on-host` or
`target-effort-not-on-host` reason). Treat both as gaps on the model they belong to: a matrix axis
change that adds a cell, or drops one a target relied on, surfaces here even when the model's own
guidance block is already `fresh` — the interactive flow below offers to fill it alongside any
notes/card gap on that model.

## Argument contract

- **blank** → the interactive state-driven flow below.
- **an axis value** (`opus`, `low`, …) → a scoped run on that one value, skipping the scope question.
  Validate the name against BOTH axes (efforts + models); on a miss, fail loud and list the configured
  values. If the named value is already `fresh` and carries no equivalence gap, confirm before
  spending a research pass on it.
- **`missing`** → non-interactive: fill every gap (each `missing`, `stub`, or `stale` guidance value,
  plus any model with an equivalence gap or dangling target), no questions.
- **`all`** → wipe and re-research every value, behind exactly one confirm.

`missing` and `all` are reserved words, matched BEFORE the axis-value check — a future axis value must
never be named either one.

## The interactive flow (blank arg)

Read `--state`, then pick the lightest path the state allows — at most two `AskUserQuestion` calls,
often one, sometimes zero:

- **All fresh** (no guidance gap, no equivalence gap, no dangling target) → report the fresh table
  and ask one gentle question defaulting to *Nothing, exit*. Accepting the default is the whole
  flow: zero writes, no research.
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
   when to pick this tier over another. With several models in scope, research may fan out (one
   subagent per vendor family, the notes/card formats pasted into each prompt); distillation stays
   single-writer in this session so when-to-pick reads fleet-relative.
2. **Fetch the vendor's own system card.** Record TWO URLs as you go — the durable discovery URL
   (the vendor's stable index/landing page) and the resolved artifact URL actually fetched (vendor
   CDN/PDF paths are content-addressed and rot, so the discovery URL is what a future re-research
   pass re-resolves from). Cards are PDF-first — treat PDF extraction as the primary conversion
   path, markdown-only in the tree. A bot-gated landing page is normal: record it as the discovery
   URL anyway, fetch the artifact wherever it actually serves (vendor safety hubs often serve the
   PDF directly), and fall back to an archived snapshot honestly noted in the card header when
   nothing serves live. A card-only gap (a model whose `--state` `reasons` is exactly
   `[no-card]`) needs only this step and step 3's card half — its notes are already researched, skip
   straight here.
3. **Cache both.**
   - The raw research notes as a provenance-headed markdown at `references/<model>.md`. The first
     comment block is the provenance header — `model_id`, `resolves_to`, `researched` date, `status`,
     `method`, and `sources`. The header must survive the strict YAML loader `--state` parses it
     with: keep every value a plain scalar — after any `: `, never open with a `"` (a quoted scalar
     with trailing text kills the whole header) and never add a second `: ` inside one entry; join
     clauses with an em-dash instead. A header that fails to parse classifies the value `stub`
     silently. This file is the review point: depth and citations live here, never in the config.
   - The converted card as provenance-headed markdown at `references/cards/<model>.md`, distinct
     from the notes file (the gate rejects a card path equal to its notes reference as a copy-paste
     error). Its header records both URLs from step 2, the converter used, and — optionally, as a
     cheap re-research signal — the fetch's ETag/Last-Modified. Retain the vendor's copyright notice
     in the cached body. Keep the file size-bounded: it is a converted capability doc, not a mirror
     of the full PDF.
4. **Distill** into `model-selector.yaml`:
   - `models.<model>` — a short behavioral block (strengths, weaknesses, when-to-pick). Prompt-sized;
     raw research stays in `references/`. Write when-to-pick fleet-relative (against the sibling
     tiers, all in one sitting) and capability-shaped: the fast suite's forbidden-word guard rejects
     cost/provider/harness words in every skill-authored block (`hand_tuned` alone is exempt).
     Routing posture — which family or tier is the default — lives in `hand_tuned`; blocks and notes
     name it, never restate it.
   - `efforts.<effort>` — for each configured effort in scope, concrete worker-facing advice on when
     to route a task to that band (difficulty and blast radius, not line count). When you refresh the
     efforts set, also author its provenance: `efforts_provenance.last_reviewed` (today) and
     `efforts_provenance.status`.
5. **Author/refresh equivalence entries** in `provider-equivalence.yaml`, in BOTH directions, for
   every `{model, effort}` cell just distilled: a claude-native model gains or refreshes its
   `claude_to_codex` entries (one per effort, each targeting its most-equivalent codex-served cell),
   a codex-served model its `codex_to_claude` entries (targeting the most-equivalent claude-native
   cell) — targets are restricted to the worker-cell eligibility list, and a target must never be
   same-family with its source. Base the call on the freshly distilled behavioral blocks for both
   sides of the pairing, not on names or price. When a cell has several defensible targets and no
   single one clearly dominates, flag it as **contested**: surface it to the human via
   `AskUserQuestion` instead of silently picking one, and note the tie in the entry's surrounding
   commit message. A re-pointed launch id (the "When to invoke" re-point case) stales its affected
   equivalence entries exactly as it stales the notes — re-author them in this step, never leave the
   old target in place.
6. **Re-hash.** Recompute each touched reference file's sha256 and update the matching config field —
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
present. It asserts (a) structural validation (the config coerces — a malformed section fails loud),
(b) research-cache hash parity: every configured research entry's notes reference AND any declared
vendor card both exist on disk and their recorded sha256 matches the file, presence + hash only —
the gate never parses either file's provenance header, and (c) the equivalence map's own structural
well-formedness: no same-family target, every target model a source model of the opposite
direction, every source model covering all five canonical efforts, no duplicate source cell. The
fast test suite (`plugins/plan/test/consistency-model-selector.test.ts` and
`plugins/plan/test/consistency-provider-equivalence.test.ts`) asserts the same checks in-process, so
a red gate is a red suite. Note the gate checks hash parity and structural well-formedness, not
freshness or host coverage: a `stub`-stamped value with a matching hash passes `--check` but reads
as a gap in `--state`, and axis coverage against the host matrix — for both the guidance blocks and
the equivalence map's totality/dangling-target check — is a `--state` concern, not `--check`'s.
After a research pass, also re-run `--state` and confirm every value in scope classifies `fresh`
with `equivalence.total: true` — researched notes that come back `stub` mean the provenance header
failed to parse (see the plain-scalar rule above), which `--check` cannot see.

## Commit the pass

A pass that wrote anything ends with a commit, in the same turn the gate goes green — never hand
the tree back dirty or punt the commit to the human. (The all-fresh zero-write exit has nothing to
commit and skips this.) Commit via `keeper commit-work`, the standard commit seam (lint matrix +
commit + push in one call), never raw `git commit`:

```bash
keeper commit-work --preview-files
keeper commit-work "docs(plan): <what was researched or refreshed>"
```

The commit scope is exactly the pass's artifacts: `model-selector.yaml`,
`provider-equivalence.yaml`, each touched `references/<model>.md` and
`references/cards/<model>.md`, and any test that pins the on-disk guidance state. Unrelated dirty
files
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
