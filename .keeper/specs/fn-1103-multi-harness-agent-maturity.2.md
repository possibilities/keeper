## Description

**Size:** M
**Files:** src/agent/harness.ts, src/agent/config.ts, src/agent/dispatch.ts, src/agent/launch-config.ts, src/agent/args.ts, src/agent/passthrough.ts, src/agent/run-capture.ts, src/agent/transcript-watch.ts, src/agent/main.ts, test/agent-hermes.test.ts (new)

### Approach

Add hermes (Nous Research CLI) as the fourth descriptor: M0 Named (registry entry,
hermes_default preset pointer, reserved-name widening, USAGE/help text, fail-loud
preset validation arm rejecting BOTH effort and thinking — hermes is model-only),
M1 Launchable (binary at ~/.local/bin/hermes with PATH fallback; one-shot -z
prompt delivery; -m model flag; no-approval posture --yolo plus
HERMES_ACCEPT_HOOKS=1 in env; passthrough tables for its subcommands; resume/
continue arg predicates), M2 Capturable (run-capture envelope: stop detection and
last-message extraction). Hermes sessions live in a SQLite store, not JSONL files;
default capture strategy: bounded polling of `hermes sessions export` (JSONL out,
read-only) attributed positively by cwd + created-at with refuse-to-guess on
collision (codex precedent); investigate the store layout first and prefer a
simpler file-watch seam if hermes also writes per-session files. resume_target =
hermes native session id once discovered. Once capturable, hermes is panel-eligible
automatically via the capability gate — no extra panel work.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/transcript-watch.ts:248 — codex positive-attribution discovery (the refuse-to-guess pattern to mirror)
- src/agent/config.ts:385-398 — the cross-harness second-axis fail-loud arms to extend
- test/agent-codex.test.ts and test/agent-pi.test.ts — per-harness test templates for agent-hermes.test.ts
- Live probe: `hermes --help`, `hermes sessions --help`, `~/.hermes/` layout — confirm exact --resume/-r semantics and what per-session artifacts exist (resume flag confidence is MEDIUM; verify before locking argv)

**Optional** (reference as needed):
- src/agent/main.ts:1295-1300 — harness-defaults printout loop (add hermes_default)
- src/agent/dispatch.ts:53 — USAGE blocks (two spots)

### Risks

- Hermes CLI flag semantics are MEDIUM confidence from source reading; a wrong resume flag silently breaks M4 later — verify live first
- The SQLite-store capture may be slower/racier than file-watch; keep the capture bounded and fail to no_transcript, never hang

### Test notes

agent-hermes.test.ts mirrors agent-pi.test.ts: argv byte-pins for interactive +
detached + run-capture forms; preset validation cases (effort rejected, thinking
rejected, model-only accepted); envelope outcomes on synthetic session fixtures.

## Acceptance

- [ ] keeper agent hermes launches interactively and detached into tmux with the documented no-approval posture
- [ ] keeper agent run hermes with a trivial prompt emits the uniform envelope with outcome completed and a non-empty message
- [ ] A hermes preset carrying effort or thinking fails loud at load; a model-only hermes preset resolves; hermes_default pointer works
- [ ] A hermes preset is accepted as a panel member (capability-derived) once this task lands
- [ ] Hermes appears in presets list and keeper agent usage/help output

## Done summary

## Evidence
