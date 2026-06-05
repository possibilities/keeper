---
name: close
description: >-
  Close a planctl epic — spawn quality-auditor, spawn classifier, parse
  <VERDICT_JSON>, branch on fatal, then run the audit INLINE (vet/cull/merge
  → scaffold follow-up → validate) before the irreversible epic close. Slash-only
  entry; no auto-invoke from free text. Use when the human types `/plan:close
  <epic_id>` once every task in the epic is `done`.
argument-hint: "<epic_id> [instructions]"
allowed-tools: Bash(planctl:*), Bash(keeper:*), Bash(git rev-parse:*), Bash(git log:*), Bash(git status:*), Bash(git show:*), Bash(git diff:*), Read, Task
disable-model-invocation: true
---

# Close

Single-identity orchestrator for the epic-close phase. One closer, not a closer + a co-equal auditor: the closer spawns the `quality-auditor` over the epic's commit set, feeds its output to the `classifier` agent, parses the structured `<VERDICT_JSON>` verdict, branches on `fatal` (the only ship-block signal), and then — if the verdict carries actionable non-fatal findings — runs the audit's vet/cull/merge + follow-up scaffold INLINE, BEFORE the irreversible `epic close` mutation. There is no separate `/plan:audit` session, no auditor persona, no auto-audit dispatcher.

The human types `/plan:close <epic_id>` once every task in the epic is `done`.

The classifier's `fatal` flag is the only ship-block signal; the bar is a show-stopper for real users in production. Tolerable defects and non-show-stopper user impact are not fatal — they flow into the inline audit's vet/cull/merge and (when they survive the cull) into a scaffolded follow-up epic.

**Saga ordering.** The audit work that materializes a follow-up epic (scaffold + validate) is reversible and runs FIRST; `epic close` is the irreversible mutation and runs LAST. Each verb auto-commits its own scope inline at `emit()`, so successful returns mean the state commit has already landed; a crash before close leaves the source epic OPEN and the skill re-runnable — the Phase 7 idempotency guard is the only thing preventing a duplicate follow-up on re-run.

**Session-name format**: `/plan:close <epic_id>` invocations land a session named `close::<epic_id>` (slug-shortcut branch in `apps/hookctl/lib/session_naming.py`). Canonical doc: `apps/hookctl/CLAUDE.md` (§ Session naming).

---

## Phase 1 — Input handling

Validate `$ARGUMENTS` before any shell interpolation (injection guard).
Accepted pattern: `^fn-\d+(-[a-z0-9-]+)?$`

- **Empty `$ARGUMENTS`:** ask *"which epic should I close? pass the epic id (`fn-N-slug`)."* Wait for reply, re-enter Phase 1.
- **`$ARGUMENTS` matches `^fn-\d+(-[a-z0-9-]+)?\.\d+`** (task id): error — *"`close` operates on epics only. pass the parent epic id (`fn-N-slug`)."* Stop.
- **`$ARGUMENTS` matches `^fn-\d+(-[a-z0-9-]+)?$`** (epic id): capture `epic_id`, proceed to Phase 2.
- **Otherwise:** error — *"invalid id format. pass an epic id like `fn-7-add-auth`."* Stop.

---

## Phase 2 — Re-anchor and confirm readiness

One read-only call fetches everything this skill needs to confirm readiness and brief the subagents. `close-preflight` is invokable from any cwd — pass `--project` when the skill knows the project path, or omit it to fall back on the verb's cwd-walk:

```bash
planctl close-preflight <epic_id>
# or, when the project path is known up front:
planctl close-preflight <epic_id> --project <abs-path>
```

The skill ran from an arbitrary cwd at Phase 1, so the no-`--project` form is the default. The verb resolves the owning planctl project via its existing cwd-walk and returns `primary_repo` in the envelope — same shape as `claim`.

The success envelope carries five fields:

- `primary_repo` — the resolved primary repo (absolute path).
- `tasks` — `[{id, title, status}, ...]`, ordinal-ordered.
- `all_done` — `true` iff every task is `status: done`.
- `commit_groups` — `[{repo, shas: [...]}, ...]`, the auditor's commit set. The verb shells `keeper find-task-commit` per task and groups by repo, **failing loud on the first failure** rather than truncating. Empty array is legal — the auditor handles it.
- `snippet_context` — the `promptctl render-spec <epic_id> --format human` prose blob both the `quality-auditor` and `classifier` subagents read as-is.

**`cd` into `primary_repo`** before any subsequent git operations or follow-up planctl mutating verbs (Phase 8 `scaffold`, Phase 10 `epic close`). All `.planctl/` state for this epic lives there. If the `cd` fails, stop: *"BLOCKED: TOOLING_FAILURE — primary_repo `<path>` does not exist or is not accessible."*

**Confirm readiness.** If `all_done` is `false`, list the non-done tasks from `tasks` and stop:
*"epic `<epic_id>` has open tasks (<csv of non-done task ids>). work them individually before closing."*

**Pin the commit set** as `COMMIT_GROUPS` (the `commit_groups` field verbatim).

**Pin the snippet context** as `BUNDLE_CONTEXT` (the `snippet_context` field verbatim). Empty string is legal: the epic has no curated substrate set (`epic.snippets` / `epic.bundles` both empty). On a `{success: false, ...}` envelope with `error.code` `SNIPPET_RENDER_FAILED` (or `COMMIT_LOOKUP_FAILED`), surface the error verbatim and stop — the human investigates before subagents spawn.

Pass the `## Snippet context` block to both spawned subagents (Phase 3 quality-auditor, Phase 4 classifier) — it's pre-rendered curated context the planner curated at epic time. Empty `BUNDLE_CONTEXT` → omit the section from the subagent brief entirely (no blank header). The same context is carried into the Phase 6.2 vet decisions and Phase 8 follow-up task-spec authoring so the follow-up epic inherits the source's substrate vocabulary.

---

## Phase 3 — Audit (discovery)

Spawn the quality-auditor via Task. Prepend a `## Snippet context` section at the top of the prompt when `BUNDLE_CONTEXT` (Phase 2) is non-empty; omit the section entirely when empty:

```
Task(
    subagent_type="quality-auditor",
    model="claude-opus-4-5",
    description="Audit <epic_id>",
    prompt="""## Snippet context
<BUNDLE_CONTEXT verbatim, omitted entirely when empty>

EPIC_ID: <epic_id>

--- COMMIT_GROUPS ---
<COMMIT_GROUPS JSON>"""
)
```

Pin the Task return value verbatim as `AUDITOR_REPORT`.

**Transient-failure retry (backoff, not once-then-stop).** The auditor is the expensive, overload-prone step, and the audit runs INLINE — a dropped spawn blocks the whole close, so a "retry once" policy hands a transient API blip back to the human as a dead close. When the Task call fails with no markdown body returned (harness drop, model unavailable, `API Error: 529 Overloaded`), retry with increasing backoff: re-spawn immediately once, then on continued failure sleep `60s → 180s → 600s` between attempts (up to ~5 attempts total). Surface a one-line status to the human before each backoff sleep (*"auditor hit a transient 529; backing off Ns before retry M of 5"*) so a long outage is visible, not silent. Stop only after the backoff budget is exhausted — *"BLOCKED: TOOLING_FAILURE — quality-auditor unreachable after 5 attempts over ~15 min (last error: <verbatim>). Re-run `/plan:close <epic_id>` once the API recovers; the Phase 7 guard makes re-run safe."* Do NOT attempt to classify without a real audit report. A non-transient Task failure (e.g. a returned error body that is not an overload/availability blip) stops immediately — backoff is for transient unavailability only.

---

## Phase 4 — Classify

Spawn the classifier agent via Task. Prepend the same `## Snippet context` section from Phase 2 when `BUNDLE_CONTEXT` is non-empty; omit when empty:

```
Task(
    subagent_type="classifier",
    model="claude-sonnet-4-6",
    description="Classify findings for <epic_id>",
    prompt="""## Snippet context
<BUNDLE_CONTEXT verbatim, omitted entirely when empty>

EPIC_ID: <epic_id>
PRIMARY_REPO: <primary_repo>

--- AUDITOR REPORT ---
<AUDITOR_REPORT verbatim>
--- END AUDITOR REPORT ---"""
)
```

Pin the full Task return value as `CLASSIFIER_OUTPUT`.

---

## Phase 5 — Parse verdict

Extract the verdict block from `CLASSIFIER_OUTPUT`.

**Extraction regex — non-greedy, DOTALL, last-match-wins:**

```python
import re
matches = re.findall(
    r"<VERDICT_JSON>(.*?)</VERDICT_JSON>",
    classifier_output,
    re.DOTALL,
)
raw_json = matches[-1].strip() if matches else None
```

Last-match-wins defends against the classifier emitting an example block mid-prose before the real final block. `<VERDICT_JSON>` is reserved — the classifier's system prompt forbids it in prose; last-match is defense-in-depth.

Strip any markdown code fences before parsing:

```python
raw_json = re.sub(r"^```[a-z]*\n?(.*?)(?:\n```)?$", r"\1", raw_json, flags=re.DOTALL).strip()
```

Normalize Unicode lookalikes to ASCII before parsing. Sonnet occasionally stylizes punctuation when the surrounding prose is heavy on em dashes / smart quotes — drift can leak into the JSON and break `json.loads`. Map the most common offenders to their ASCII equivalents:

```python
raw_json = raw_json.translate(str.maketrans({
    "，": ",",   # fullwidth comma
    "：": ":",   # fullwidth colon
    "“": '"',   # left double quote
    "”": '"',   # right double quote
    "‘": "'",   # left single quote
    "’": "'",   # right single quote
}))
```

This is defense-in-depth — the classifier system prompt is the primary mitigation. Em dashes (`—`) inside JSON string values are valid UTF-8 and are intentionally NOT remapped.

**Re-classify recovery (try before giving up).** All three failure modes below — missing `<VERDICT_JSON>` block, `json.JSONDecodeError`, schema-validation failure — are *classifier-output* defects, not epic defects: the model emitted malformed or schema-incomplete JSON (e.g. dropping the schema-required `suggested_fix` key). The expensive, overload-prone auditor step already succeeded and `AUDITOR_REPORT` is still pinned in working memory, so re-running just the classifier is cheap. Before marking the epic `needs_work`, re-spawn the Phase 4 classifier **in-session** over the same pinned `AUDITOR_REPORT`, up to **2 retries**, appending an explicit conformance reminder to the prompt:

```
SCHEMA REMINDER: emit exactly one <VERDICT_JSON>...</VERDICT_JSON> block as the
LAST thing in your reply. It MUST be valid JSON that validates against the Finding
schema — every finding object MUST include all required keys, including
`suggested_fix`. Do not wrap it in prose or code fences.
```

Re-parse each re-spawn's output through the same extract → strip → normalize → `json.loads` → schema-validate pipeline. On the first attempt that parses and validates, pin it as `verdict` and continue to Phase 6. Only after the 2-retry budget is exhausted do you fall through to the `needs_work` arms below.

**On missing block, `json.JSONDecodeError`, or schema validation failure — after re-classify recovery is exhausted** (validate with `jsonschema.Draft202012Validator` against `apps/planctl/skills/close/classifier/schema.json`; use `jsonschema.exceptions.best_match()` for the schema-error message): halt without closing. No status stamp is written — the epic simply stays open (the absence of a `closer_done_at` stamp is the signal).

Log the specific failure verbatim — one of *"verdict parse failed: no `<VERDICT_JSON>` block found in classifier output (3 attempts)"*, *"verdict JSON parse failed after 3 attempts: <error>"*, or *"verdict schema validation failed after 3 attempts: <best_match error message>"* — and stop. Note this is a classifier-output defect, not an epic defect: re-running `/plan:close <epic_id>` re-runs the audit from scratch (the Phase 7 guard makes re-run safe), but if the classifier keeps emitting malformed output its agent prompt / schema-conformance instructions are the thing to fix.

Pin the parsed object as `verdict`.

---

## Phase 6 — Fatal check (ship-block gate)

```python
if verdict["fatal"]:
    ...
```

Halt without closing. No status stamp is written — the epic stays open (the absence of a `closer_done_at` stamp is the signal).

Log: *"fatal finding: <verdict['fatal_reason']>"* and stop. Do NOT run `epic close`. Do NOT scaffold a follow-up. Fire NO commit seam. This is the only ship-block path.

`fatal: false` falls through to the inline audit (Phase 6.1).

---

## Phase 6.1 — Findings branch

`fatal: false`. The skill drives every subsequent decision off the **in-memory** `verdict` object — there is no persistence step and no re-read source.

**Findings branch.** Inspect the in-memory `verdict`:

- **Non-fatal findings present** (`verdict["tier_1"]` OR `verdict["tier_2"]` OR `verdict["tier_3"]` non-empty): run the inline audit, Phase 6.2 → Phase 7 → Phase 8.
- **No findings** (all three tier arrays empty): skip straight to Phase 10 (close). No follow-up.

---

## Phase 6.2 — Vet (claim → evidence → verdict)

For each finding in `verdict["tier_1"] + verdict["tier_2"] + verdict["tier_3"]` (in source order; tier label is input, not consensus), drive the verdict in three explicit steps. State each step inline as you go — the human sees the reasoning train, not just the verdict. The same scrutiny applies to all three tiers.

### Cull discipline

If you can leave the code alone (with or without a code comment), cull. Keep only when the issue has concrete user impact, breaks the spec's happy path, or would surprise the next reader. The classifier already filtered — its bar is high; yours is higher. Treat its tiering as input, not consensus: you may cull a tier-1 finding or keep a tier-3 one, justified on its own evidence. When in doubt, cull.

### 6.2a. Claim

Restate the finding's claim in one sentence. Use the finding's `summary` and `severity_reason` as input.

### 6.2b. Evidence path

State the evidence that would prove or refute it: file:line, behavior to reproduce, or a missing artifact.

- If the finding's `affected_paths` already cite a verifiable target, use them. Read the cited file:line via the `Read` tool when needed.
- If the verdict hinges on context not in the finding (e.g. how the `quality-auditor` reasoned in raw form about a related concern), re-read the pinned `AUDITOR_REPORT` (it's already in working memory from Phase 3 — no fetch needed). The closer ran the auditor itself this turn; there is no cross-session lazy fetch.

### 6.2c. Verdict

Issue exactly one of:

- `kept` — finding stands; will spawn a task in Phase 8.
- `culled` — drop with one-line rationale.
- `merged-into-<other-fid>` — same root cause as another finding; folded into that finding's task.

Track the verdicts in working memory as a list of `(source_fid, action, rationale)` tuples. The Phase 8 audit-decisions table writes from this list verbatim.

### Clarifying-question budget — at most ONE across the whole audit

Same explainer-then-question discipline as `/plan:plan` Phase 1.7:

0. **Triviality floor (apply before asking):** is there only one viable answer? is the question color, not load-bearing on a verdict? If yes, resolve internally and surface as a fait accompli with one-line rationale (`"going with X (Y wasn't viable because Z) — flip if you'd rather"`).
1. Write a short explainer paragraph: the tradeoff you're weighing, why the answer matters, what each direction implies. Then ask the question. No lists, no batching.
2. Wait for the human's answer before advancing the verdict for the affected finding.

The budget is ONE question across the whole run, only when the answer would flip a verdict. If no question qualifies, proceed without asking. `skip` and `pass` are valid answers.

---

## Phase 6.3 — Cluster & title

After every finding has a verdict, partition the verdict list:

- `kept_or_merged` — findings with action `kept` or `merged-into-<id>`.
- `culled` — findings with action `culled`.

**Empty-cull path:** if `kept_or_merged` is empty (every finding got culled), do NOT scaffold a follow-up. Print the cull table to the human (Source | Rationale, two columns), then proceed to Phase 10 (close) — same terminal path as the no-findings case. Emit, before closing:

```
All findings culled from `<epic_id>`. No followup epic created.
```

Otherwise, cluster the surviving findings by **type-of-work** (bug fix vs refactor vs docs vs test-coverage vs perf etc.).

**Always one epic. Splitting is highly discouraged.** If there is significant additional followup work that genuinely cannot share a spec doc, defer the second epic to a later cycle rather than splitting now. Split only as a true exception, when you can name two findings that genuinely cannot share a spec doc AND the second epic is too important to defer — divergent acceptance criteria, divergent reviewer audiences, or one is a hot-path fix and the other a docs sweep that would dilute the spec's center of gravity. When splitting, write the rationale into the new epic body's `## Why split` section per epic.

**Title rule:** `<verb> <area-of-change>`, themed by the surviving work, NOT by the originating epic.

**Anti-rule (verbatim discipline):** Do not include any source epic id in the title. The follow-up epic is its own first-class container. The originating epic id appears in the new body's `## Audit decisions` table (as the `Source` rationale text where relevant), not the title.

State the cluster decision back to the human in one short paragraph before advancing — counts per cluster, chosen titles, and the split rationale (or "single epic — all surviving findings share <type-of-work>").

---

## Phase 7 — Idempotency guard (re-run safety)

The saga runs scaffold-then-close; a crash after scaffold but before `epic close` leaves the source OPEN and the skill re-runnable. BEFORE scaffolding (Phase 8), check whether a follow-up already exists so a re-run never double-creates.

```bash
planctl epic followup-of <epic_id>
```

The verb scans open epics for the first one whose `depends_on_epics` contains the source and returns a single envelope — no client-side scan over the whole epics list. Read the envelope's `found` flag:

- `{"found": false, ...}` → no prior follow-up. Proceed to Phase 8 (scaffold).
- `{"found": true, "epic_id": "<id>", "actual_tasks": <int>, ...}` → a follow-up already exists. Compare `actual_tasks` against the **expected count** in working memory (one task per surviving cluster from Phase 6.3) — the guard tests a **completeness invariant, not bare existence**, so a half-built follow-up from a crashed run must not be adopted as done:

  - **`actual_tasks == expected_clusters`** → a prior run already scaffolded the follow-up. Pin the envelope's `epic_id` as `new_epic_id`, SKIP Phase 8, and proceed to Phase 10 (close).
  - **`actual_tasks < expected_clusters`** → PARTIAL (a crashed mid-scaffold run). Do NOT silently adopt or double-create. Surface it and stop for the human:

    ```
    Partial follow-up `<found_epic_id>` already depends on `<epic_id>` (expected
    <N> tasks, found <M>). A prior `/plan:close` crashed mid-scaffold. Inspect and
    either complete or delete it, then re-run `/plan:close <epic_id>`.
    ```

    Stop. Fire no close, no seam.

---

## Phase 8 — Scaffold the follow-up tree (one call)

The whole follow-up tree — epic + N four-section task specs + intra-task ordinal deps + the source-link dep — lands in a single `planctl scaffold --file <plan.yaml>` call. Scaffold mints the globally-unique `fn-N` and writes the entire tree transactionally; there is no hand-fired `epic create` → `set-plan` → per-task `task create` sequence.

The **cognitive** sub-steps that decide *what goes in the YAML*: derive the epic title (Phase 6.3), assemble the epic spec body (Overview / Acceptance / Audit decisions / [Why split] / Out of scope), cluster surviving findings into tasks (default: one task per cluster of findings sharing file-touch overlap or theme; a single task can hold multiple touchups and land as one commit — don't reflexively split one-per-finding), assemble each task's full four-section spec, and declare intra-task deps as 1-based ordinals into the task list.

**Assemble the YAML.** Mirror `planctl scaffold --agent-help` exactly:

```yaml
epic:
  title: <chosen title from Phase 6.3>
  depends_on_epics: [<epic_id>]   # the source-link: provenance + lineage in watch / dashctl
  spec: |
    ## Overview

    <2–3 sentence summary of the work surviving audit and why it matters,
    themed by type-of-work, not by the originating epic.>

    ## Acceptance

    - [ ] high-level criterion 1
    - [ ] high-level criterion 2

    ## Audit decisions

    | Source | Action | Task | Rationale |
    |--------|--------|------|-----------|
    | f-001  | kept   | .1 | <one-line rationale citing evidence path> |
    | f-002  | culled | —  | <one-line rationale, e.g. "Unsupported by available evidence — no occurrences in current code"> |
    | f-003  | merged-into-f-001 | .1 | <one-line rationale; MUST name both source ids> |

    ## Why split

    <only if split — name the two findings that cannot share a spec doc and
    why. Omit this section entirely on a single-epic follow-up.>

    ## Out of scope

    - <items the audit explicitly declined to cover>
    - <items deferred to a later epic>
tasks:
  - title: <3–6 word task title>
    tier: <medium|high|xhigh|max>   # required — scaffold errors `tier_invalid` if absent
    # deps: [1]   # optional, 1-based ordinals into this task list
    # target_repo: <abs path>   # optional, absolute path (~ expanded); omit to default
    #                             to primary_repo; epic.touched_repos auto-derives,
    #                             never hand-set. See `planctl scaffold --agent-help`.
    spec: |
      ## Description

      <cite the originating finding id(s) and quote the evidence path used in
      Phase 6.2 — every task is traceable back to the auditor's claim. For merged
      findings name BOTH source fids; for multi-touchup tasks list all bundled
      finding ids and the file-touch overlap or theme that justified bundling.>

      ## Acceptance

      - [ ] criterion 1

      ## Done summary

      ## Evidence
```

`depends_on_epics: [<epic_id>]` is the source-link — scaffold validates the id (epic-id shape, on-disk existence under the cwd-first-then-global resolver, fn-600) upfront and writes it onto the new epic record. The source-link source-epic almost always lives in the same project as the follow-up (the closer's `primary_repo`), but the resolver also accepts a source in another project under the configured `roots` — the existence check passes either way, and the readiness gate hard-gates the follow-up until the source reaches runtime `complete`. The source is still OPEN at this point (close runs in Phase 10), which is valid: the dep just needs the source to exist on disk. It's a durable trace from the new epic back to its origin. Full contract: `apps/planctl/docs/reference/cross-project-epic-deps.md`.

Each task `spec` is the **full four-section block** (`## Description` / `## Acceptance` / `## Done summary` / `## Evidence`) — scaffold runs `ensure_valid_task_spec` on every spec, so all four headings must be present exactly once. Merged findings fold into the task of their merge target — do NOT create a separate task for a merged-into row. Intra-task deps are declared as 1-based ordinals via the optional `deps:` list (omit for the flat case — most follow-up epics have no intra-epic deps).

**Audit-decisions table schema rules** (locked, must hold for every row):

- Columns are exactly `Source | Action | Task | Rationale`. No reorder, no extra columns.
- `Action` is one of `kept`, `culled`, or `merged-into-<id>` (verbatim, no other values).
- `Task` cell is a **bare ordinal** (`.1`, `.2`) for `kept` / `merged-into-...` rows, and `—` (em dash) for `culled` rows. The cell is a bare `.M` (not `<epic_id>.M`) because scaffold mints the epic id atomically — the body is authored before the id exists. A `merged-into-...` row points its `Task` cell at the **same ordinal** as its merge target (multiple `Source` rows → one ordinal).
- Every `merged-into-<id>` row's `Rationale` MUST name BOTH the source fid (column 1) and the target fid (in `merged-into-<id>`). Silently merging without naming both is forbidden.

**Fire scaffold.** Pipe the assembled YAML on stdin in a single transactional call — no tmp file, no Write tool round trip:

```bash
planctl scaffold --file - <<'YAML_EOF'
<assembled follow-up plan YAML verbatim>
YAML_EOF
```

The quoted heredoc delimiter (`'YAML_EOF'`) disables all shell expansion so finding prose and spec markdown pass through byte-intact. The 1 MiB stdin byte cap matches the file-path code path.

Capture `epic_id` from the success envelope → `new_epic_id`. Scaffold's inline integrity check (filesystem-repo existence, four-section task specs, dep graph, source-link existence) already covers the follow-up — no trailing `validate --epic` call is needed; scaffold stamps `last_validated_at` inline on a successful mint. On a `{success: false, ...}` envelope (codes `bad_yaml` / `spec_invalid` / `ref_invalid` / `dep_invalid` / `dep_cycle` / `epic_dep_invalid` / `id_collision`), surface the error verbatim and stop — no writes landed; **do not retry.** The human inspects and re-runs after fixing. (A re-run is safe: the Phase 7 guard sees no follow-up and re-scaffolds.)

Proceed to Phase 10.

---

## Phase 10 — Close epic (irreversible)

The reversible audit work is done (or there were no findings). Close the source — the FINAL irreversible mutation:

```bash
planctl epic close <epic_id>
```

Never pass `--force`. `epic close` stamps `closer_done_at`; the epic flips to `pending_approval` for the human ack (no audit gate — the audit already ran inline).

---

## Report

Three outcomes — clean close, close + follow-up, or fatal halt.

Clean (no findings, or all findings culled):

```
Closed `<epic_id>`. Epic closed. No followup epic created.
```

Close with follow-up (findings survived the cull, follow-up scaffolded):

```
Closed `<epic_id>`. Epic closed. Audited inline → planned `<new_epic_id>` ('<title>').
Tasks: N. Findings: kept K, culled C, merged M.
```

Split case (rare exception — Phase 6.3 strongly discourages splitting):

```
Closed `<epic_id>`. Epic closed. Audited inline (split exception — see each epic body's `## Why split` section):
  - `<new_epic_id_a>` ('<title_a>'): N tasks. Findings kept K_a, merged M_a.
  - `<new_epic_id_b>` ('<title_b>'): N tasks. Findings kept K_b, merged M_b.
  Findings culled across both: C.
```

Fatal halt (Phase 6 path):

```
Halted `<epic_id>`. fatal finding: <verdict['fatal_reason']>. epic NOT closed.
```

The `## Audit decisions` table on each new epic (visible via `planctl cat <new_epic_id>`), plus the new epic's `depends_on_epics: ["<source>"]`, are the durable trace of what the audit decided and why — no write to the source spec.

---

## Out of scope

- **No separate auditor session.** The audit runs inline as Phases 6.1–8 of this skill; there is no `/plan:audit` skill, no auditor persona, no auto-audit dispatcher.
- **No inline tier classification by the closer** — the classifier agent owns all tier decisions (Phase 4). The closer's Phase 6.2 is the second-pass vet/cull, not a re-tiering.
- **No closer-driven worker dispatch.** Surviving findings become tasks in a scaffolded follow-up epic, worked later via `/plan:work`; the closer never spawns fix workers.
- **No re-validation of the source before close** — the fatal check is the only ship-block gate on the source.
- **No write to the source epic body** — provenance lives on the follow-up's `depends_on_epics: ["<source>"]` and the `## Audit decisions` table, not on the source spec.
- **No retry on scaffold failure** — surface errors verbatim and stop; the human re-runs (the Phase 7 guard makes re-run safe).
- **No `Skill(plan:plan)` dispatch.**
