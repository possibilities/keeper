## Overview

`keeper pair --cli claude`, driven from inside an active claude session in the
same project dir, silently returns the DRIVER's transcript+answer instead of
the spawned partner's — breaking the Opus leg of `/plan:panel`. Root cause
(confirmed in source): agentwrap mints a partner session uuid and stores it as
run.json `transcriptSessionId`, and sets `AGENTWRAP_TMUX_SESSION_ID` on the
launch env — but that carrier is only on `req.env`, never `-e`-forwarded into
the tmux pane (`tmux-launch.ts:494/509` forwards `req.options.env` only). On an
existing tmux server the inner re-exec (`main.ts:1174-1184`) therefore mints a
FRESH uuid, the partner writes `<fresh>.jsonl`, and the resolver looking up
`<transcriptSessionId>.jsonl` misses and falls back to newest-by-mtime
(`transcript-watch.ts:195`) — which a concurrently-writing driver wins. The fix
pins the partner's session identity end-to-end, makes pinned resolution strict,
bounds the stop-wait, and adds a keeper-side fail-loud guard.

## Quick commands

- From inside a claude session in `/Users/mike/code/keeper`: `keeper pair send --cli claude --read-only --output /tmp/probe.yaml <prompt-file-with-unique-token>` — then assert `/tmp/probe.yaml` `transcript_path` basename != `$CLAUDE_CODE_SESSION_ID`, `message` contains the token, `elapsed_seconds` realistic.
- `cd /Users/mike/code/agentwrap && bun test && bun lint && bun typecheck`
- `cd /Users/mike/code/keeper && bun test test/pair-command.test.ts`

## Acceptance

- [ ] `keeper pair --cli claude` from inside a same-project claude session resolves the PARTNER's transcript+answer, never the driver's.
- [ ] A misfire surfaces as `failed` (`error=self-transcript-collision`), never a bogus `completed`.
- [ ] `wait-for-stop` blocks for the partner's real turn and is bounded; `show-last-message` returns the partner's final message.
- [ ] codex pairing is unaffected.

## Early proof point

Task that proves the approach: `.1` (agentwrap carrier-forward + strict
resolution + decoy-transcript regression test). If it fails: fall back to
injecting `--session-id <transcriptSessionId>` directly into `innerArgs` at the
outer `main.ts` call site instead of via the `-e` carrier — same end state,
different seam.

## References

- `~/docs/keeper-pair-claude-session-collision.md` — origin handoff.
- Overlap (NOT hard-wired — see below): `fn-903` (retire pairctl) task `.3` also edits `cli/pair.ts` + `src/pair-command.ts` (strips pairctl comment blocks). Natural sequencing handles it: this epic is armed + awaited to completion BEFORE the autopilot flips to yolo and picks up fn-903, so fn-903 rebases the comments after this lands — no concurrent edit.
- Reverse-dep (advisory): `fn-901` task `.2` tests `cli/pair.ts` Monitor contract against whichever pair shape lands first.
- agentwrap seams: `src/main.ts:669-698` (outer launch) / `:1172-1187` (inner `--session-id` push), `src/tmux-launch.ts:457-513` (pane `-e` env) / `:624` (`envArgs`), `src/transcript-watch.ts:65-81` (stop wait) / `:182-196` (claude resolve) / `:44-63` (path-timeout pattern to mirror).

## Docs gaps

- **plugins/keeper/skills/pair/SKILL.md**: add `error=self-transcript-collision` to the failure-mode list; note the partner gets a pinned, non-colliding transcript.
- **/Users/mike/code/agentwrap/AGENTS.md**: note the tmux pair launch forwards a pinned `--session-id` carrier into the pane (strict/pinned transcript resolution), framed as a current-state invariant.

## Best practices

- **Fresh uuid per launch (never reuse a `--session-id`):** `--session-id` without `--resume` APPENDS to an existing `<uuid>.jsonl`, mixing prior context. agentwrap already mints per-launch — keep it.
- **cwd-scoped transcript path:** the partner must launch from the driver's cwd or the pinned path won't match (claude-code transcripts live at `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`).
- **Bound polling with a wall-clock deadline, not iteration count:** fail-loud on timeout beats an unbounded hang.
