## Description

**Size:** S
**Files:** ~/docs/babysitters/performance/charter.md, ~/docs/babysitters/performance/README.md, ~/docs/babysitters/performance/processed.jsonl

Seed the performance sitter's charter from the human intent that created it, so the
generic system launches with a real, non-empty charter (and so the .1 contract gets
its first real-data test). This was an explicit human request.

### Approach

Mine the founding intent and write `charter.md` per the task .1 contract:
- Read `.planctl/specs/fn-729-keeper-babysitter-monitor.md` (the founding epic) plus the chain: fn-731 (follow-up-prompt-files), fn-733 (telemetry-and-fold-latency), fn-738 (signal-quality), fn-745 (incremental-backstop-telemetry-alerts).
- Mine the original design conversations: `claudectl list-sessions --all --no-limit | grep -i babysit`, then `claudectl show-session <id>` on the founding ones — capture the human's expressed goals in their own framing.
- Write `## Goals` (human intent, as verbatim as the sources allow), `## Understanding` (the agent's current read of the performance sitter's job), `## End-state` = "ongoing — no terminal state" (a safety monitor, never "done"), `## Heuristics` (seed with the concrete learnings already visible in the sitter's history, e.g. dropped-wake / fold-latency clusters being single-stall events), `## Sitter facts` (followups path, key/fingerprint scheme, the 11 categories).
- Initialize an empty `processed.jsonl` and a `README.md` (mirror ~/docs/keeper-reliability/README.md). Commit to the ~/docs repo.

Prefer running `/babysit-new performance` first (task .2) to lay down the canonical
home shape, then populate; if running this standalone, follow the .1 contract layout exactly.

### Investigation targets

**Required:**
- .planctl/specs/fn-729-keeper-babysitter-monitor.md (in /Users/mike/code/keeper) — founding human request
- .planctl/specs/fn-731-*, fn-733-*, fn-738-*, fn-745-* — the evolution chain
- babysitters/FINDINGS-LEDGER.md (task .1) — charter section contract
- ~/docs/keeper-reliability/README.md — README/charter precedent

**Optional:**
- `claudectl list-sessions --all --no-limit | grep -i babysit` then show-session — original design conversations

### Risks

- Specs/conversations describe iterative evolution; distill the DURABLE goal, don't transcribe every iteration. Keep Goals tight.
- This task writes to the ~/docs git repo (not a lint-matrix project) — commit is a plain markdown add/commit.

### Test notes

After writing, run `/babysit performance` (task .3) against the real backlog to
confirm the charter + empty ledger drive a sane first round — the real-data test of the .1 contract.

## Acceptance

- [ ] ~/docs/babysitters/performance/charter.md exists with Goals sourced from fn-729 + chain (+ original sessions where available) and End-state = "ongoing"
- [ ] processed.jsonl initialized (empty) and README.md written
- [ ] Committed to the ~/docs repo

## Done summary
Seeded performance sitter charter.md from fn-729 + chain (Goals/Understanding/End-state=ongoing/Heuristics/Sitter facts incl 11 categories + key/fingerprint scheme), initialized empty processed.jsonl, and wrote README.md mirroring keeper-reliability. Committed f0b5cb3 to ~/docs.
## Evidence
