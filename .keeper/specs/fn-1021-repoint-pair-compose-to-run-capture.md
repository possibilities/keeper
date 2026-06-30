## Overview

Increment 2 (sketch-step 3) of flattening `keeper pair` into a fat `keeper agent`: repoint `pair send`'s launch→wait→capture COMPOSE onto the in-process `composeRunCapture`/`captureFromHandle` helper that landed in fn-1019, banking the robustness payoff (no cross-process kill margin, no self-transcript-collision exposure). A shared launch→`ResolvedHandle` helper is EXTRACTED from the `agent run` handler so both `agent run` (posture-free) and `pair send` (posture-full) build their launch through one seam. BEHAVIOR-STABLE: pair's `--output` YAML, its two-line `[keeper-pair]` Monitor contract, its 0/1/2 exit codes, and all posture (read-only, env-strip, codex-trust, role/system-prompt) are UNCHANGED. Posture migration into `agent` is later increments.

## Quick commands

- `bun test` — full suite green (the conformance surface; no test launches real subprocess/tmux/git)
- `bun run typecheck` — `tsc --noEmit` clean
- (out-of-band) `keeper pair send <file> --cli claude --output <out>` — same YAML + two-line `[keeper-pair]` contract as before

## Acceptance

- [ ] A shared db-free launch→`ResolvedHandle` helper backs BOTH `agent run` and `pair send`; `agent run` stays byte-stable.
- [ ] `pair send` composes in-process via `composeRunCapture`; the kill margin + self-collision guard are gone (deletion rationale documented at the site).
- [ ] pair's public contract (the `--output` YAML + the two `[keeper-pair]` Monitor lines + 0/1/2 exit codes) and all posture are byte-identical — the golden test (`test/agent-run-capture-golden.test.ts`) stays green; `bun test` green.

## Early proof point

Task that proves the approach: `.1` (the shared launch-helper extraction + `agent run` repoint). If the posture-options-bag seam proves awkward (obscures the two callers' configs): fall back to `pair` inlining a simplified launch closure (DUPLICATE) and keep `agent run`'s launch private.

## References

- Increment 2 of a 5-increment pair→agent flattening; builds on fn-1019 (done/merged). Later: step 4 (`--read-only` + move `ensureCodexDirTrust` into agent), step 5 (`--system-file`/`--append-system-prompt`), step 6 (collapse `pair panel`).
- **Hard-deps fn-1020 (Complete agentwrap retirement):** its task `.2` renames the `AGENTWRAP_*` env-var family across `src/agent/main.ts`, which task `.1` also edits — gated so the rename lands first and `.1` writes against settled identifiers.
- Symbols are post-rename: `runKeeperAgent` / `launchKeeperAgentInTmux` (the agentwrap→keeper-agent rename landed in fn-1018).
- Decision: EXTRACT (DRY shared helper) over DUPLICATE-inline — chosen to converge on shared primitives, accepting the fn-1020 gate.

## Docs gaps

- **cli/pair.ts module doc (lines 21-38)**: rewrite the three-step subprocess "Compose flow" + kill-margin sentence to the in-process compose path (forward-facing, no historical note).
- **src/pair-command.ts module doc + surviving JSDoc**: prune the "subprocess compose" / kill-margin mentions; drop the dead-builder JSDoc together with their defs.
- **plugins/keeper/skills/pair/SKILL.md:126**: discretionary prune of the "subprocess-kill margin" phrase (no behavior change; not a gate).

## Best practices

- **Characterization/golden-master is the guard:** keep `test/agent-run-capture-golden.test.ts` green to prove byte-stability; treat the two-line event ordering (started pre-compose, completed/failed post-rename) as part of the contract.
- **Map outcomes at ONE boundary** with an exhaustive `never`-checked switch; never leak run-capture's 0/4/2 exit codes into pair's 0/1/2 taxonomy.
- **Instrument-then-delete the race guard:** document the structural reason the self-collision guard is safe to drop (handle held locally, session-id pinned at launch) at the deletion site.
