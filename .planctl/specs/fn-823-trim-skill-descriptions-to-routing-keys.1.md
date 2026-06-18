## Description

**Size:** M
**Files:** plugins/keeper/skills/await/SKILL.md, plugins/plan/skills/defer/SKILL.md, plugins/plan/skills/next/SKILL.md, plugins/plan/skills/plan/SKILL.md, plugins/plan/skills/close/SKILL.md, plugins/plan/skills/hack/SKILL.md, plugins/plan/template/skills/work.md.tmpl (NOT plugins/plan/skills/work/SKILL.md — that is generated), plugins/plan/skills/work/SKILL.md (regenerated, do not hand-edit)

### Approach

Trim the `description:` frontmatter of all 7 keeper-side skills to a minimal routing key. Each description must keep BOTH a "what it does" clause AND a "Use when…" trigger clause — do not over-trim to a single clause (Anthropic's guidance: the description is the sole routing signal and needs both dimensions). Remove only the three bloat patterns: internal mechanism that duplicates the SKILL.md body, caveats/refusal/edge behavior, and exhaustive synonym phrase-lists (keep 3–4 representative trigger phrases, not 15). Preserve genuine disambiguators.

Apply the drafted rewrites below for await/defer/next. For plan/close/hack: they are already lean — review and trim only residual mechanism/caveat bloat (e.g. drop next-style "calls planctl X" mechanism if present), otherwise leave. close/hack/work are `disable-model-invocation: true` (slash-only) — keep them human-readable, don't strip them to bare triggers.

For plan:work specifically: edit the SOURCE template `plugins/plan/template/skills/work.md.tmpl` (its `description:` is literal frontmatter, no variable injection). The generated `plugins/plan/skills/work/SKILL.md` is silently overwritten on render, so never edit it by hand. After editing the template, regenerate with `promptctl render-plugin-templates --project-root /Users/mike/code/keeper` (this rewrites work/SKILL.md and refreshes its `.managed-file-dont-edit` sha256). Stage template + regenerated SKILL.md + marker together.

Drafted rewrites (starting points — tune wording but keep the substance):
- await: "Block until a condition holds, then run a follow-up action. Conditions: a planctl board state (epic/task complete or unblocked), git cleanliness of the current repo, other agents finishing, an own-session background task (dev server / build / script) completing, daemon readiness, or any AND-combination. Use for any wait-then-act intent — e.g. \"review when fn-N is done\", \"ping me when the repo's clean\", \"do X after the other agents finish\" — even when the user never says \"keeper\", \"await\", \"epic\", or \"task\"."
- defer: "Capture the conversation's currently actionable work as a single normal-priority planctl epic (no queue jump). Use when the human says \"defer\", \"save for later\", \"put on the list\", or wants a small follow-up tracked without interrupting current work."
- next: "Bump an existing planctl epic to the front of the queue. Use when the human says \"next\", \"do this next\", \"jump the queue\", \"prioritize\", or \"top of the board\". Operates on an epic that already exists — it does not scaffold one."

### Investigation targets

**Required** (read before coding):
- plugins/keeper/skills/await/SKILL.md:1-30 — the 276-word/1682-char flagship description to trim; the body already owns what you're cutting: `## When to invoke` (line 61+) holds the trigger enumeration, `## Step 1` (:97/:133/:141) the off-board refusal, `## Step 2` (:149) and `## Step 3` (:185) the Monitor wiring. Confirm before removing.
- plugins/plan/skills/work/SKILL.md.managed-file-dont-edit — the generation marker: `source_template`, `sha256`, and the render command.
- plugins/plan/template/skills/work.md.tmpl:3-12 — the literal description block to edit.

**Optional** (reference as needed):
- plugins/plan/skills/defer/SKILL.md, next/SKILL.md, plan/SKILL.md, close/SKILL.md, hack/SKILL.md (frontmatter only).

### Risks

- plan:work is GENERATED — editing SKILL.md directly is lost on next render. Edit the template, then re-render.
- Mixed YAML scalar styles: `plan` and `hack` use plain inline scalars (not `>-` blocks). A trimmed plain-scalar rewrite must stay valid YAML — quote it if it contains a `:` followed by space, or starts with a special char. await/defer/next/close/work use `>-`.
- `plugins/plan/` is a git subtree — editing files in-tree is fine; do NOT squash/rebase its merge commit. Commit normally via `keeper commit-work`.

### Test notes

- After trim, measure each description's char count (target ≤ ~600, hard cap 1024) and confirm each still reads as "what + when".
- Confirm the render left no dirty mismatch between work.md.tmpl and the generated work/SKILL.md + marker.
- No "formerly/used-to/replaces" phrasing (forward-facing only).

## Acceptance

- [ ] All 7 keeper skill descriptions are a routing key (what + when), ≤ ~600 chars, with no mechanism/caveat/synonym-dump.
- [ ] await reduced from ~1682 chars to ≤ ~600; condition categories preserved as the disambiguator.
- [ ] next keeps "does not scaffold"; defer keeps its normal-priority (no queue-jump) distinction.
- [ ] plan:work changed via template + regenerated; work/SKILL.md and marker sha256 updated with no dirty mismatch.
- [ ] close/hack/work kept human-readable (not stripped to bare triggers).
- [ ] Forward-facing present-tense prose only.
- [ ] keeper repo committed via `keeper commit-work`.

## Done summary

## Evidence
