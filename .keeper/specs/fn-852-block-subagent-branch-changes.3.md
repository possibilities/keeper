## Description

**Size:** S
**Files:** README.md, CLAUDE.md (AGENTS.md symlink — edit in place), plugins/plan/CLAUDE.md

### Approach

Document the new two-hook reality, forward-facing only (no change-history narration — commit messages carry history). (1) CLAUDE.md `## Hook rules` (highest priority): clarify that the keeper plugin now ships TWO PreToolUse hooks — the events-writer (logs, never blocks) AND the branch-guard (hard-blocks subagent branch create/switch). Critical nuance: the branch-guard STILL exits 0 — it denies via the PreToolUse JSON envelope (`permissionDecision:"deny"`), NOT a non-zero exit — so the "always exit 0" rule HOLDS; add a bullet making clear the branch-guard denies via JSON and must never be "fixed" to drop the deny or to exit non-zero. Update the intro paragraph ("appends one per-pid NDJSON line per hook invocation") to reflect two hooks / two contracts. (2) README.md `## Architecture` (~:1281 hook narration) and the plugins/keeper bullet (~:375 "events-writer hook + keeper:await skill"): add a forward-facing sentence naming the branch-guard and its deny-via-JSON contract. (3) plugins/plan/CLAUDE.md `## Skills and agents`: add a one-line cross-reference noting a keeper-plugin branch-guard hook also enforces the worker "work in place" invariant.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md `## Hook rules` section + intro paragraph — the carve-out target; AGENTS.md is a symlink, edit CLAUDE.md in place (never rm+recreate).
- README.md ~:375 (plugins/keeper bullet) and `## Architecture` ~:1281 (hook narration).
- plugins/plan/CLAUDE.md `## Skills and agents` — cross-ref insertion point.

**Optional** (reference as needed):
- The committed task-.1 branch-guard.ts + hooks.json (for accurate contract wording) — available once .1 lands (this task deps on it).

### Risks

- Forward-facing only: state current two-hook behavior as present fact; no "fn-N added / formerly" narration (`promptctl render code-comment-style` / `future-facing-docs`).
- The "exits 0 / denies via JSON" nuance is subtle and load-bearing — get it right so a future reader doesn't break the guard.

### Test notes

No code tests. Verify AGENTS.md still resolves as a symlink to CLAUDE.md after editing. Sanity-grep that README/CLAUDE.md mention the branch-guard.

## Acceptance

- [ ] CLAUDE.md `## Hook rules` clarifies the two-hook surface and the branch-guard's deny-via-JSON (still exit 0) contract; the intro paragraph reflects two hooks.
- [ ] README.md `## Architecture` + the plugins/keeper bullet name the branch-guard and its contract (forward-facing).
- [ ] plugins/plan/CLAUDE.md carries a one-line cross-ref to the keeper branch-guard enforcing the worker invariant.
- [ ] AGENTS.md remains a valid symlink to CLAUDE.md.

## Done summary

## Evidence
