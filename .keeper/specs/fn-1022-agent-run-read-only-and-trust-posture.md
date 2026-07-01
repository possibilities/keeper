## Overview

Increment 3 (sketch-step 4) of flattening `keeper pair` into a fat `keeper agent`: give the `agent run` verb + the shared launch helper (`launchToResolvedHandle`) the read-only posture (a `--read-only` flag → per-harness tool strip + a directive prepend) and MOVE codex directory-trust seeding + CLAUDE-env scrubbing INTO the shared helper, so both `agent run` and `pair send` get them via one path. BEHAVIOR-STABLE for `pair`; `agent run codex/pi` gain `CLAUDE*`-scrub (a correct partner-isolation improvement on a new verb with no external consumers). The git read-only backstop stays caller-side in pair (the run-capture envelope stays a fixed 9 keys). Builds on fn-1019 + fn-1021 (both done).

## Quick commands

- `bun run test` — full suite green (gated; no test launches real tmux/subprocess/git/`~/.codex`)
- `bun run typecheck` — `tsc --noEmit` clean
- (out-of-band) `keeper agent run --read-only claude "list files"` — launches read-only (tool strip + directive), token-free, JSON envelope

## Acceptance

- [ ] `agent run --read-only` works (per-harness tool strip + directive prepend), and codex-trust + CLAUDE-env-scrub live in the shared launch helper (pair delegates both, drops its own).
- [ ] `pair send` is byte-stable (golden + pair-cli green); managed launches byte-identical (byte-pin green).
- [ ] Read-only is documented honestly as detection-not-prevention; `bun test` green.

## Early proof point

Task `.1` is the whole increment. If the injected trust-seam / directive-prepend entangles pair's byte-stability: fall back to leaving codex-trust + env-scrub in pair and shipping ONLY `agent run --read-only` this increment (move trust/env-scrub in a follow-up).

## References

- Increment 3 of a 5-increment pair→agent flattening; builds on fn-1019 (agent run) + fn-1021 (shared launch helper), both done. Later: step 5 (`--system-file`/`--append-system-prompt`), step 6 (collapse pair panel).
- Read-only posture is **detection, not prevention** (the tool strip is leaky — bash `>`, `sed -i`, git escape it); `agent run --read-only` has directive + tool-strip but NO changed-files audit (that stays caller-side in pair; the run-capture envelope is fixed at 9 keys).
- Fail-open codex trust-seed is the textbook-correct case (an interactive hang is worse than continuing; it is UX pre-fill, not a security check).
- **Future hardening (NOT this increment):** the env-scrub strips only `CLAUDE*`; `ANTHROPIC*` / `*_API_KEY` / `DYLD_*` could also leak — a deliberate, separately-reviewed change.
- CLAUDE.md's sole-writer line ("`src/codex-trust.ts` is the ONLY keeper surface writing codex's config dir") still reads true — it names the module, not the caller; only the caller moves.

## Docs gaps

- **src/agent/dispatch.ts (`USAGE` / `KEEPER_AGENT_HELP`)**: document `agent run --read-only` (detection-not-prevention framing) — part of the deliverable, not a separate task. NO `--scrub-claude-env` flag (it's an agent-conditional default, not a flag).
- **cli/agent.ts header + README ~line 1423**: add `agent run --read-only`; note codex/pi scrub `CLAUDE*` by default.
- **README ~line 3337**: revise the codex trust-seed attribution from `cli/pair.ts` to the shared agent launch path (forward-facing).

## Best practices

- **Detection-not-prevention:** frame read-only honestly in help/docs — three tiers (tool-strip + directive + caller-side git audit), the strip is leaky.
- **Inject the FS effect as a seam:** `ensureCodexDirTrust` rides a `LaunchHandleDeps` field (DI contract + test isolation — no real `~/.codex` write).
- **Env-scrub builds a fresh filtered object** (`stripClaudeEnv`), never `{...env, X: undefined}`; it is identity-isolation, not credential-security.
