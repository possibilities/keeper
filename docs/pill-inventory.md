# Pill inventory & lossless consolidation — `keeper board` and `keeper jobs`

Scope: the two real-time TUIs `keeper board` (epics view, `cli/board.ts`) and
`keeper jobs` (jobs view, `cli/jobs.ts`), sharing render primitives in
`src/board-render.ts` and the readiness verdict vocabulary in
`src/readiness.ts`. Goal: inventory every pill and every state it can hold,
then consolidate **as hard as possible with zero loss of any information a
viewer (human or agent) can currently discern from the screen.**

---

## Part 0 — Method and the losslessness contract

A "pill" is a `[token]` bracket group. Coloring is applied by
`colorizePillsInLine` purely by matching the inner token string. The
consolidation below is governed by one invariant:

> **Losslessness.** After consolidation, every distinct underlying state that
> the *current* TUI lets a viewer distinguish must still be distinguishable.
> A pill may only be removed/merged if its value is recoverable from what
> remains on screen.

Three removal transforms are provably lossless, in increasing aggressiveness:

- **T1 — Omit-default.** Each pill has exactly one resting/default value
  (already rendered uncolored today). Render the pill only for non-default
  values; **absence ≡ the default.** Lossless given a one-line legend stating
  the convention. Requires the viewer to know a *single uniform rule*.
- **T2 — Drop-constant.** A pill that is constant for the view's fixed filter
  carries zero bits. Recoverable by knowing the view. Lossless.
- **T3 — Drop-when-the-verdict-text-already-says-it.** When an adjacent
  readiness verdict's *own text* names the state (e.g. `[blocked:job-rejected]`
  contains the word "rejected"), the separate `[rejected]` pill is redundant.
  Lossless for a human, because the word is on screen.

A fourth transform — dropping a pill because the readiness *algorithm* implies
its value (e.g. `job-pending` ⇒ `worker_phase=done`, where "done" is **not** in
the verdict text) — is lossless for an **agent that holds the predicate rules**
but **not for a human merely looking**. It is called out separately as
**T4 (agent-only)** and is *not* part of the recommended human-lossless config.

Two hazards the design must avoid:

- **Positional ambiguity.** Today `[runtime_status] [worker_phase] [approval]`
  are decoded *by position*. `runtime_status=done` and `worker_phase=done` both
  render the bare word `[done]`. Once defaults are omitted and order is no
  longer fixed, two `[done]` pills become indistinguishable → information loss.
  Fix: label the rare survivor (`[worker-done]`), never rely on position.
- **Token collision.** `runtime_status=blocked` renders `[blocked]`, which reads
  next to the verdict `[blocked:<reason>]`. They are different facts (planctl's
  manual block flag vs. computed readiness). They remain distinguishable (the
  verdict always carries `:<reason>`), but the bare `[blocked]` is flagged for
  an optional `[rt:blocked]` relabel.

---

## Part 1 — Color audit (answering "does color carry hidden state?")

`colorizePillsInLine` (`src/board-render.ts`) is a pure `string → string` map:
it matches `[token]`, looks `token` up in `PILL_COLORS`, and falls back through
prefix branches (`blocked:*`, `failed:*`, `awaiting:*`, `task-repo:*`,
`dead-letter:*`, `running:*`, plus two more-specific overrides). **Every branch
keys on the token text itself.** Consequences:

- **No color is the sole carrier of any state.** Color is a deterministic
  function of text already on screen. Strip all color and zero bits are lost.
- The two "special" recolors are still text-redundant:
  - `running:sub-agent-stale` → yellow (others blue): the word **stale** is in
    the token.
  - `blocked:dep-on-epic-dangling` → red (other blocks yellow): the word
    **dangling** is in the token.

**Verdict: nothing to fix in color.** Color stays as pure emphasis for human
scanability; the consolidation reasons entirely on text. (After T1, almost
every *remaining* pill is non-default and therefore colored — the
"signal-by-color" intent is realized as a side effect, not a dependency.)

The one place a fact is carried by **neither text nor color** today is the epic
dep-summary pill: a *satisfied* dep and a *blocked-incomplete* dep both render
`#N`. That is a pre-existing **text gap**, addressed as an enhancement in
Part 6 — it is not a color issue and not a consolidation.

---

## Part 2 — Full pill inventory (every pill, every state)

### `keeper board`

| # | Pill | Position | Value domain | Default | Color (token→bucket) |
|---|------|----------|--------------|---------|----------------------|
| B1 | epic-deps | epic header | group `[#N,…]`; each ref `#N` / `<proj>::#N` / `?#N` | — (omitted when empty) | uncolored |
| B2 | validated | epic header | `validated` / `unvalidated` | `unvalidated` | green / — |
| B3 | slotted-after-closer | epic header | present / absent | absent | cyan |
| B4 | readiness (epic) | epic header | see §Verdict | — | varies |
| B5 | link role | creator/refiner line | `creator` / `refiner` | — | uncolored |
| B6 | link state | creator/refiner line | `working`/`stopped`/`ended`/`killed` | `stopped` | blue / faded / — / red |
| B7 | failed | creator/refiner line | `rate_limit` `authentication_failed` `billing_error` `server_error` `invalid_request` `unknown` | absent | red |
| B8 | awaiting | continuation line | `ask_user_question` / `permission` / `elicitation` | absent | yellow |
| B9 | task-deps | task line | `[#N,#M]` | — (omitted when empty) | uncolored |
| B10 | runtime_status | task line | `todo` / `in_progress` / `done` / `blocked` | `todo` | — / cyan / green / yellow |
| B11 | worker_phase | task line | `open` / `done` | `open` | — / green |
| B12 | approval | task line | `approved` / `rejected` / `pending` | `pending` | green / red / — |
| B13 | readiness (task) | task id line | see §Verdict | — | varies |
| B14 | task-repo | task id line | `<basename>` (only on divergence) | absent | yellow |
| B15 | close status | close row | epic `status` — **always `open`** on board | `open` | uncolored |
| B16 | close approval | close row | `pending` / `rejected` (never `approved`*) | `pending` | — / red |
| B17 | readiness (close) | close id line | see §Verdict (incl. `epic-no-tasks`) | — | varies |
| B18 | subagent status | nested line | `running`/`ok`/`failed`/`unknown`/`superseded` | `ok`† | blue/green/red/—/faded |

\* board filter is `approval != 'approved'`, so the close row's approval is
never `approved` on this view.
† no schema default is `ok`; `ok` is chosen as the render-time "resting success"
value to omit (see T1 application).

### `keeper jobs`

| # | Pill | Position | Value domain | Default | Color |
|---|------|----------|--------------|---------|-------|
| J1 | role | job row | `planner` / `worker` / `closer` | — (omitted when no `plan_verb`) | uncolored |
| J2 | state | job row | `working`/`stopped`/`ended`/`killed` | `stopped` | blue/faded/—/red |
| J3 | failed | job row | (same 6 as B7) | absent | red |
| J4 | awaiting | continuation line | (same 3 as B8) | absent | yellow |
| J5 | backend-coords | expanded | `[<tab> p<pane>]` / `[<tab>]` / `[p<pane>]` | absent | uncolored |
| J6 | monitor kind | expanded | `monitor` / `bash-bg` / `ambient` | — | uncolored |
| J7 | monitor status | expanded | optional `[status]` — **projection never populates it today** | absent | varies |
| J8 | subagent status | expanded | (same as B18) | `ok` | varies |
| J9 | dead-letter | banner | `[dead-letter:N]`, N≥1 | absent (N=0) | yellow |

### §Verdict — the shared readiness pill (richest, ~26 strings)

`formatPill` (`src/readiness.ts`):

- `[ready]`
- `[completed]`
- `[running:<kind>]` — `job-running` / `sub-agent-running` / `sub-agent-stale` / `planner-running`
- `[blocked:<reason>]` — `job-rejected`, `job-pending`, `epic-not-validated`,
  `git-uncommitted`, `git-orphans`, `dep-on-task <id>`, `dep-on-epic <id>`,
  `dep-on-epic-dangling <id>`, `single-task-per-epic`, `single-task-per-root`,
  `epic-no-tasks`, `unknown`

---

## Part 3 — The recoverability ledger (the proof core)

What the readiness verdict pins about a task's `(worker_phase, approval,
runtime_status)`, derived from the first-match predicate order in
`evaluateTask` / `evaluateCloseRow`. `✓` = pinned by the verdict; `—` = not
pinned (independent information that must stay visible).

| Verdict | worker_phase | approval | runtime_status | "in verdict text"? |
|---------|:---:|:---:|:---:|---|
| `completed` | ✓ `done` | ✓ `approved` | — | semantic (completed ≡ done+approved) |
| `blocked:job-rejected` | — | ✓ `rejected` | — | **text** ("rejected") |
| `blocked:job-pending` | ✓ `done` | ✓ `pending` | — | "pending" in text; **"done" not** |
| `blocked:git-uncommitted`/`git-orphans` | ✓ `done` | ✓ `pending`¹ | — | neither in text |
| `running:job-running` | — | `≠rejected` | — | no |
| `running:sub-agent-running`/`-stale` | — | `≠rejected` | — | no |
| `running:planner-running` | — | — | — | no |
| `blocked:epic-not-validated` | — | — | — | masks everything (ranks #2) |
| `blocked:dep-on-task`/`dep-on-epic`/`-dangling` | ✓ `open`² | `≠rejected` | — | no |
| `blocked:single-task-per-epic`/`-root` | ✓ `open`² | `≠rejected` | — | no |
| `ready` | ✓ `open`² | `≠rejected` | — | no |

¹ Proof `git-*` ⇒ `approval=pending`: predicates 5/6 (above 6.5) already
excluded `working`/sub-running, so at 6.5 `¬working ∧ ¬sub`. With
`worker_phase=done` (the 6.5 gate), if `approval=approved` then predicate 1
(`completed`) would have fired first. Predicate 4 excluded `rejected`. ∴
`approval=pending`.
² Proof dep/ready/mutex ⇒ `worker_phase=open`: if `worker_phase=done`, then with
`¬working ∧ ¬sub` (5/6 cleared) predicate 1/6.5/7 would have fired before
reaching 8+. ∴ reaching those verdicts forces `worker_phase=open`.

**Three load-bearing conclusions:**

1. **`runtime_status` is never pinned by any verdict** (no predicate reads it).
   It is fully independent — keep it (omit `todo`). Its `blocked` value is the
   *only* on-screen source of planctl's manual block flag.
2. **`worker_phase=done` is independent only in 4 verdict classes**
   (`job-running`, `sub-agent-*`, `planner-running`, `epic-not-validated`).
   Everywhere else it is pinned or provably `open`.
3. **`approval` is pinned (or in-text) in the terminal verdicts**
   (`completed`/`job-rejected`/`job-pending`); elsewhere only `≠rejected` is
   known, so a non-default `approved`/`rejected` value must stay visible.

---

## Part 4 — The revised, maximally-consolidated render spec

Conventions (state once, in a footer legend on each TUI):

> Pills show **only non-resting states.** No `[approval]` pill ⇒ pending. No
> `[runtime]` pill ⇒ todo. No worker/validated/awaiting/failed pill ⇒ that
> condition is absent. No `[state]` pill ⇒ a session at rest (`stopped`).

### Board — epic header

```
({dir}) {num} {title} [#deps…]?  [validated]?  [slotted-after-closer]?  <verdict-inline-or-own-line>
```

- **B1 epic-deps** — keep (carries specific upstream ids + dangling marker not
  in the verdict). *Enhancement (Part 6): color each ref by satisfied/blocked.*
- **B2 validated** — **T1**: render `[validated]` only when validated; drop
  `[unvalidated]` (absence ≡ unvalidated). Reinforced by the verdict
  (`epic-not-validated` covers the visible case).
- **B3 slotted-after-closer** — keep (structural fact in no other pill).
- **B4 verdict** — keep (anchor).

### Board — creator/refiner link lines

```
{title} [creator|refiner] [working|ended|killed]?  [failed:<kind>]?
    [awaiting:<kind>]?
```

- **B5 role** — keep (3-way provenance, no default).
- **B6 state** — **T1**: drop `[stopped]` (absence ≡ stopped). Show
  `working`/`ended`/`killed`. (When `failed:*` is present, state was forced to
  `stopped` by the reducer, so it's already absent — no interaction.)
- **B7 failed**, **B8 awaiting** — keep (each is a distinct, default-absent
  signal; not derivable from anything else).

### Board — task line  ← the biggest win

```
{n}. {title} [#deps]?  [in_progress|done|blocked]?  [worker-done]?  [approved|rejected]?
    [{id}] <verdict>  [task-repo:<base>]?
```

- **B9 task-deps** — keep.
- **B10 runtime_status** — **T1**: drop `[todo]`; show `in_progress`/`done`/
  `blocked`. (Optionally relabel the manual block as `[rt:blocked]` to
  disambiguate from the verdict `[blocked:*]`.)
- **B11 worker_phase** — **T1 + de-ambiguate**: never render `[open]`; render
  the survivor as the labeled **`[worker-done]`** (never bare `[done]`, to avoid
  collision with runtime `[done]`), and only in the 4 classes where it is *not*
  pinned by the verdict (`job-running`, `sub-agent-*`, `planner-running`,
  `epic-not-validated`). In `completed`/`job-pending`/`git-*` the verdict pins
  it → omit. This preserves the genuinely surprising "administratively done but
  still churning / not yet validated" signal and nothing else.
- **B12 approval** — **T1 + T3**: never render `[pending]`. Render
  `[rejected]` only when verdict ≠ `job-rejected` (i.e. the
  `epic-not-validated`-masked case); render `[approved]` only when verdict ≠
  `completed`. In the common terminal verdicts the word is already on screen.
- **B13 verdict**, **B14 task-repo** — keep.

**Typical waiting task:** `5. Title [#3] [todo] [open] [pending]` + `[id]
[blocked:dep-on-task fn-x.3]` (**5 pills**) → `5. Title [#3]` + `[id]
[blocked:dep-on-task fn-x.3]` (**2 pills**).

**Completed task:** `[done] [done] [approved]` + `[completed]` (**4 pills**) →
`[done]` (runtime, not pinned) + `[completed]` (**2 pills**).

### Board — close row  ← collapses to almost nothing

```
X. Quality audit and close  [rejected]?
    [{id}] <verdict>
```

- **B15 close status** — **T2**: board filter is `status='open'`, so this pill
  is the constant `[open]`. **Drop it** on the board. (A custom-filtered view
  that surfaces non-open epics must restore it; note in code.)
- **B16 close approval** — **T1 + T3**: never `approved` on the board (filter),
  drop `pending` (default), so only `[rejected]` survives — and only when the
  verdict isn't already `job-rejected`. In practice the close row becomes just
  the title + `[id] <verdict>`.
- **B17 verdict** — keep (it is where `epic-no-tasks` lives).

### Board — subagent nested lines

```
{type}{(×N, N stuck)}?: {desc} [running|failed|unknown|superseded]?
```

- **B18 status** — **T1**: drop `[ok]` (absence ≡ ok); show the four
  non-resting states. The `(×N)` / `N stuck` annotations stay (textual, unique).

### Jobs — job row + expanded region

```
({cwd}) {title} [{role}]?  [working|ended|killed]?  [failed:<kind>]?
    [awaiting:<kind>]?
  ── expanded ──
    [<tab> p<pane>]?
    [{kind}] {label}            (monitor; status slot dropped)
    {type}(…)?: {desc} [running|failed|unknown|superseded]?
```

- **J1 role**, **J3 failed**, **J4 awaiting**, **J5 backend-coords** — keep.
- **J2 state** — **T1**: drop `[stopped]`.
- **J6 monitor kind** — keep.
- **J7 monitor status** — **drop the dead slot** until the projection actually
  populates `status` (today it never does — rendering an always-empty optional
  is pure latent noise; restore when `monitors[].status` lands).
- **J8 subagent status** — **T1**: drop `[ok]`.
- **J9 dead-letter banner** — keep (already default-absent at N=0).

---

## Part 5 — Net effect

| Surface | Pills, typical row, before | after | removed |
|---|---|---|---|
| Epic header (validated, no closer-slot) | 2–3 | 1–2 | `unvalidated` |
| Task, waiting (`todo/open/pending`, dep-blocked) | 5 | 2 | runtime+worker+approval defaults |
| Task, completed | 4 | 2 | worker+approval (pinned by `completed`) |
| Task, in-flight (`in_progress/open/pending`, running) | 4 | 2 | worker+approval defaults |
| Close row | 3 | 1 | constant `open` + default approval |
| Subagent line (ok) | 1 | 0 | `ok` default |
| Jobs row, idle worker (`stopped`) | 2 | 1 | `stopped` default |

No row loses a discernible bit: every dropped pill is either the unique default
(absence-encoded, T1), a fixed-filter constant (T2), or a value whose word is
already in the adjacent verdict (T3). The two ambiguity hazards are closed by
labeling (`worker-done`, optional `rt:blocked`).

**Pills that look redundant but are NOT consolidated (kept, with reason):**

- `runtime_status` vs verdict — verdict never reads runtime_status; fully
  independent (esp. the manual `blocked` flag).
- `worker-done` under running/unvalidated — the only on-screen evidence that the
  worker administratively finished while the session is still live.
- epic-deps / task-deps vs `dep-on-*` verdict — the verdict names only the
  *first* blocking upstream; the dep pills carry the full list + dangling marker.
- `[awaiting:ask_user_question]` vs `[awaiting:permission]` — distinct fold arms
  (input-request vs permission-prompt), same label by design; both kept.
- jobs `[state]` vs board `[running:*]` — never co-occur in one view;
  complementary, not duplicate.

**Explicitly out (agent-only, not recommended for the human-facing config):**

- **T4** drops `[worker-done]` even under `job-pending`/`git-*` (the algorithm
  pins it, but the word "done" is not on screen). Lossless for an agent holding
  the predicate rules; lossy for a human looking. If a consumer is purely
  programmatic, T4 removes the last `worker-done` renders too.

---

## Part 6 — Separately: the one genuine information *gap* (enhancement, not consolidation)

The epic header dep-summary renders satisfied and blocked-incomplete deps
identically (`#N`); "is this dependency met?" is on screen **nowhere** (not
text, not color) except indirectly via the verdict's *first* blocker. This is a
pre-existing loss, surfaced by the audit. Lossless-consolidation does not touch
it, but the cheapest fix is textual: mark unmet deps, e.g. `#N` (met) vs `!#N`
(blocked-incomplete) vs `?#N` (dangling, already present). Flagged here so it
isn't conflated with the color question — it is a missing *fact*, not redundant
emphasis.

---

## Appendix — source map

- Render entry points: `cli/board.ts`, `cli/jobs.ts`
- Shared primitives + colorizer: `src/board-render.ts`
  (`colorizePillsInLine`, `PILL_COLORS`, the pill-seg helpers)
- Verdict vocabulary + predicate pipeline: `src/readiness.ts`
  (`formatPill`, `evaluateTask`, `evaluateCloseRow`, `rollupEpicHeader`)
- State enums: `src/types.ts` (`JobLinkEntry`, `ProjectedJob`, `Task`,
  subagent `status`), `src/reducer.ts` (lifecycle state machine header comment)
