## Overview

FINAL increment (sketch-step 6) of flattening `keeper pair` into a fat `keeper agent`: collapse `pair panel` (`src/pair/panel.ts`) so detached legs run `agent run` instead of `pair send`, and `panel wait` polls clean JSON result files instead of scraping `[keeper-pair]` logs — deleting the fragile log-scraping machinery while keeping the pidfile crash-backstop and the stable verdict contract. `/plan:panel` (panel-runner + judge + skill) stays working end-to-end. Adds `--preset`/`--session`/`--output` to `agent run` (the launch substrate already carries preset/session; only the parse side + an atomic `--output` writer are new). Builds on fn-1019/fn-1022; hard-deps fn-1026 (file overlap on run-capture.ts/main.ts/dispatch.ts).

## Quick commands

- `bun run test` — full suite green (no real tmux/subprocess/git)
- `bun run typecheck` — clean
- (out-of-band) `keeper agent run --preset opus --read-only --output /tmp/leg.json claude "hi"` → writes the JSON envelope atomically; `/plan:panel "<q>"` still fans out, waits token-free, judges, returns the fused answer

## Acceptance

- [ ] `agent run` gains `--preset`/`--session`/`--output <path>` (atomic temp+rename, written on EVERY outcome); absent-flag argv byte-identical (byte-pin); `pair send` + managed launches unchanged.
- [ ] `pair panel` legs run detached `agent run --preset <m> --read-only --session panels --output <m>.yaml`; `panel wait` polls+parses result files, maps `outcome`→verdict, KEEPS the pidfile crash-backstop, DELETES `scanLogTerminal`; the verdict shape `{dir, ok, members:[{name,harness,status,yaml,reason}]}` is unchanged.
- [ ] `/plan:panel` works end-to-end; the judge answer-file contract is honored (JSON envelope, `message` field); `bun test` green.

## Early proof point

Task `.1` (the `agent run` flags + atomic `--output`) proves the substrate; `.2` proves the collapse. If `.2`'s detached-`agent run`-writes-a-file property is shaky on real macOS: the restored real-spawn survival test (or a manual out-of-band panel run) is the confidence anchor before deleting the log-scraping.

## References

- FINAL increment of a 5-increment pair→agent flattening; builds on fn-1019 (agent run/wait) + fn-1022 (--read-only), done. Hard-deps + overlaps **fn-1026** (system-prompt seam; both edit `run-capture.ts`/`main.ts`/`dispatch.ts`) — sequence strictly after it.
- **Two contracts, distinct:** the panel VERDICT shape (`{dir, ok, members[...]}`) stays byte-stable; the judge ANSWER-FILE content changes from pair's YAML to `agent run`'s JSON envelope. JSON is valid YAML so the judge finds `message`; `panel-judge.md` is updated to name it a JSON envelope (docs-gap-scout's "no change" on that file was wrong).
- **`--output` design:** the write happens inside the emit (exit-code-INDEPENDENT) so a `timed_out`/`launch_failed` leg still produces a result file carrying its failure `outcome` — the reason a shell `>tmp && mv` was rejected (never renames on non-zero exit; `2>&1` merges stderr into the JSON). `--output` is reusable for the future agent-backed-subagent's detached legs.
- **After this lands:** the flattening's 5 increments are complete — stop and assess the end-state (fat `agent run` substrate + thin pair) and the destination (agent-backed subagents / the pair-wrapper).

## Docs gaps

- **src/pair/panel.ts module JSDoc + `:228` comment**: `pair send` legs → `agent run` legs; drop the log-scraping description (forward-facing).
- **plugins/plan/agents/panel-runner.md** (Step 2 `:76` leg mechanism, Step 3 wait, `:139` reason sourcing, `:185` output field) + **plugins/keeper/skills/pair/SKILL.md** `## Panel fan-out` (`:154`, `:183`): reword leg mechanism + reason sourcing (result-file, not `[keeper-pair]` lines); verdict contract stays.
- **plugins/plan/agents/panel-judge.md `:20`** + **plugins/plan/skills/panel/references/panel.md `:31,34`**: answer file is `agent run`'s JSON envelope (`message` field); mechanism is `agent run`.
- **cli/agent.ts JSDoc + README ~:1422**: document `agent run --preset`/`--session`/`--output`.

## Best practices

- **Atomic result file:** temp-in-same-dir + rename (only atomic presence flip); the poller matches ONLY the final path, never the `.tmp`. Carry the outcome IN the file.
- **Two-signal completion:** result-file presence (happy path) AND a wall-clock deadline; at/near the deadline `pidAlive` classifies still-running (timeout) vs dead (crashed) so a leg that dies before writing never hangs the panel.
- **Byte-stability discipline:** new `agent run` flags default-absent → the existing argv/env is byte-identical; the byte-pin is the guard.
