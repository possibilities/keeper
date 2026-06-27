## Overview

`keeper pair` (and `keeper pair panel`) support claude + codex but explicitly reject pi
(`PairCli = "claude" | "codex"`, two reject sites in cli/pair.ts, a hardcoded reject in
src/agent/main.ts). The keeper-agent launcher already launches pi and transcript-watch already
reads pi, so this is pair/panel-specific GLUE: allow pi through the (shared) harness gate
consistently, add `nativePiArgs`, and use pi's per-run trust flag. End state: pi is a first-class
pair AND panel partner in both read-only and read-write, completing the {claude,codex,pi} × {RO,RW} matrix.

## Quick commands

- `bun test test/pair-command.test.ts test/pair-cli.test.ts` — fast-tier argv + validation coverage
- `ty` — typecheck the widened `PairCli` union + 3-way dispatch
- (manual de-risk, NOT a unit test) live tmux probe: `keeper agent pi` runs an edit/bash tool without stalling on approval

## Acceptance

- [ ] pi is accepted as a pair partner (`--cli pi`) and a panel member, in both RO and RW
- [ ] RO is enforced via tool-strip + directive + git backstop; no genuine write masking
- [ ] No accept/reject inconsistency remains across pair-send / panel / presets-resolve
- [ ] `bun test` green, `ty` clean, committed via keeper commit-work

## Early proof point

The task's step-1 live tmux probe: if pi stalls on per-tool approval with no skip flag, the feature is
blocked — STOP and escalate before writing code (don't hack around it). If it runs tools autonomously,
the rest is mechanical glue.

## References

- claude/codex pairing precedent: src/pair-command.ts (nativeClaudeArgs:249, nativeCodexArgs:291, buildPairLaunchArgv:227)
- pi launcher + transcript already done: src/agent/main.ts (pi branch), src/agent/transcript-watch.ts (findPiTranscriptPath/piStopFromObject/piMessageText) — DO NOT rebuild
- src/codex-trust.ts is the seeder pattern to deliberately NOT mirror (pi's `-na`/`-a` flag replaces it; pi trust.json is a shared profile path in state-sharing.ts)

## Docs gaps

- **plugins/keeper/skills/pair/SKILL.md** (~:118-121, front-matter): add pi to `--cli`; the "preset pinning pi fails loud" line must stop reading as a rejection; keep `--effort` codex-only
- **README.md** (~:3118-3125 trust-seed paragraph): note pi uses the per-run `-na` flag (no seeder), prune the codex-exclusive framing

## Best practices

- **pi has no built-in sandbox** — RO is directive (primary) + git changed-files snapshot (backstop); `--exclude-tools edit,write` is reinforcement, bash stays leaky [pi security docs]
- **`-a`/`-na` controls loading repo `.pi/` resources, not write permission** — use `-na` for partner isolation; the trust prompt only fires when the cwd carries `.pi/` resources, so `-na` also prevents a headless hang
