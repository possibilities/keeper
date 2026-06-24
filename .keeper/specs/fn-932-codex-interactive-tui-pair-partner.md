## Overview

`keeper pair` and the panel launch the codex partner headless via `codex exec`, so it shows as a non-interactive client and diverges from the claude partner, which already launches as an interactive TUI (commit e068bfb1, fn-920, closed). This epic flips the codex partner to an interactive TUI too, and adds a fail-open helper that seeds codex's per-directory trust BEFORE launch so the detached interactive window does not hang on codex's "Do you trust the contents of this directory?" prompt. Codex only — `pi` is not a pairing CLI (src/pair-command.ts:41; PAIR_CLIS = {claude, codex}).

## Quick commands

- `bun run test:full` — routes through scripts/test-gate.ts; covers the CLI/process paths the fast tier skips.
- Manual smoke from a never-trusted cwd: `keeper pair send <prompt-file> --cli codex --output /tmp/out.yaml --session pairtest` → the codex window runs interactively with NO trust prompt and `/tmp/out.yaml` carries the partner's `message`.

## Acceptance

- [ ] codex pair/panel partner launches as an interactive TUI (no `codex exec`); the existing wait-for-stop / show-last-message / synchronous reap flow still returns the partner's final message.
- [ ] launching codex pair in a never-trusted cwd does NOT hang on the trust prompt; a cwd already trusted is left untouched (idempotent).
- [ ] the trust-seed is fail-open — any failure logs and proceeds to launch, never throws or blocks the pair.
- [ ] no real codex spawn / no real `~/.codex` write in the default test tier.

## Early proof point

The single task `.1` IS the whole change; the manual smoke command above proves it end-to-end (interactive window, no prompt, captured answer). If the interactive-launch assumption regressed (wait-for-stop times out), recovery is to revert only the `nativeCodexArgs` flip while keeping the trust-seed helper — the trust work is independently valuable.

## References

- Commit `e068bfb1` "feat(pair): launch claude pair/panel partner as tracked interactive TUI" — the mirror precedent (claude side, fn-920, closed).
- Codex trust model: `[projects."<path>"] trust_level = "trusted"` in `${CODEX_HOME:-~/.codex}/config.toml`. Trust is NOT inherited from ancestors (verified live: a fresh subdir under the trusted `/Users/mike` still prompts) → seed the exact `realpathSync(cwd)`.
- `--enable web_search_request` is deprecated (codex: "web search is enabled by default") → drop it, web search stays on.
- docs-pusher O_EXCL/`wx` lock model to mirror: plugins/keeper/plugin/hooks/docs-pusher.ts:288-384 — mirror the lock primitives, but NOT its skip-on-contention (the seed must wait-and-recheck).

## Docs gaps

- **plugins/keeper/skills/pair/SKILL.md**: the codex launch is no longer headless — fix the launch-mode line + the `--cli codex` row; add a one-line note that keeper seeds codex directory-trust before launch (fail-open).
- **plugins/plan/skills/panel/SKILL.md (~:81) + references/panel.md (~:30-32)**: codex read-only stays carried by the prompt directive (still accurate); note that the codex partner now runs as an interactive TUI with pre-seeded trust.
- **CLAUDE.md**: add one forward-facing invariant — the cli/pair.ts codex pre-launch trust-seed is the only keeper surface that writes codex's own config dir, and it is fail-open.

## Best practices

- **realpath the cwd key:** codex stores the canonical path (macOS `/var`→`/private/var`); seed `realpathSync(cwd)` or codex still prompts. [practice-scout]
- **Presence check = exact table-header line equality, not `includes()`:** avoid substring false positives from values/comments. [practice-scout]
- **O_EXCL lock + post-acquire re-check:** two unlocked concurrent appends duplicate the `[projects]` table → TOML parse error; the lock + re-check prevents it. [practice-scout]
- **Only ever seed the exact cwd, never a parent/wildcard; hardcode `trust_level = "trusted"`, no interpolation.** [practice-scout, OWASP trust-chain]
