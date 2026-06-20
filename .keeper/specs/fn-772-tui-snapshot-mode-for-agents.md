## Overview

keeper's five TUI subcommands (`board`, `jobs`, `git`, `autopilot`, `usage`)
are subscribe-driven live views. When an agent runs one non-interactively
today (stdout not a TTY), `createLiveShell` drops to passthrough mode
(`src/live-shell-core.ts:178`): every `pushFrame` AND the 125ms connecting-
spinner `refreshLive` get written to stdout, and the process NEVER exits —
it blocks on the UDS subscription forever. Agents get a spammy unbounded
stream and a hung tool call.

This epic adds a **snapshot mode**: when stdout is not a TTY (auto-detect),
or `--snapshot` is passed, the command waits deterministically for the
current data frame, prints it as plain text followed by a dual-audience
metadata block (human-readable labeled paths + a final machine-parseable
`keeper-meta:` JSON line), then exits. Humans at a TTY keep today's live TUI
byte-for-byte. `--watch` forces the live stream even when piped; `--timeout
<s>` overrides the ~2s default wait. Pure client-side change — no schema
bump, no `api.py` whitelist, no event-log/reducer/hook touch.

**Determinism is the core contract.** A multi-stream view (board=2 streams,
autopilot=4) must not snapshot a partial composite from fold-ordering luck.
A stream-readiness latch holds the snapshot until every subscribed stream
has delivered its first frame, then emits the fully-folded composite. The
timeout is the only non-deterministic escape (slow/down daemon), and it is
flagged honestly via `truncated` + `status`.

### The keeper-meta contract (single source of truth)

Snapshot stdout = the plain frame text, then a metadata block ending in one
single-line JSON record prefixed `keeper-meta: `. Fields:

- `schema_version` (int, starts at 1)
- `script` (board|jobs|git|autopilot|usage)
- `pid` (int)
- `status` ("ok" | "timeout" | "daemon-unreachable")
- `frame` (int frame number, or `null` on no-frame)
- `frame_count` (int)
- `truncated` (bool — true when the timeout fired before all streams reported)
- `state` (path to the per-frame state JSON sidecar, or `null`)
- `frame_txt` (path to the per-frame frame-text sidecar, or `null`)
- `lifecycle` (path to the lifecycle sidecar)
- `meta` (path to the meta index sidecar)
- `ts` (ISO timestamp)

Stream routing: success → frame + metadata block both on **stdout**.
No-frame → human diagnostic on **stderr**, the `keeper-meta:` line still on
**stdout** (so an agent can always parse the last stdout line regardless of
exit code). The JSON line is always the LAST line of stdout, single-line
(never pretty-printed), newline-terminated. Never embed prose in JSON fields.

### Exit codes

- `0` — a frame was emitted (including a valid empty-projection frame:
  a healthy daemon with zero jobs/roots is a real current-state frame, NOT
  a timeout).
- `1` — no frame before timeout (`status` distinguishes `timeout` vs
  `daemon-unreachable`).
- `2` — CLI misuse (e.g. `--snapshot` and `--watch` both passed, or an
  invalid `--timeout`).

### Trigger precedence

flag (`--snapshot` / `--watch`) > env (`CI`, `TERM=dumb`) > `process.stdout.isTTY`.
`process.stdout.isTTY !== true` → snapshot (tri-state: `undefined` when
piped counts as non-TTY; never coerce before the `!== true` check). `CI` or
`TERM=dumb` force snapshot even under a pty (practice-scout's top
false-positive). stdin TTY is irrelevant to the trigger (stdout-only).

## Quick commands

- `keeper jobs | cat` — non-TTY → prints one frame + `keeper-meta:` line, exits 0
- `keeper jobs | tail -1` — the last line is the parseable JSON record
- `keeper board --snapshot | tail -1` — forced one-shot even from a TTY
- `keeper git --watch | head` — forced live stream even when piped (no exit)
- `KEEPERD-down: keeper jobs --timeout 1; echo $?` — exits 1, status:"daemon-unreachable"
- `bun run test:full` — mandatory gate (CLI subprocess + view paths)

## Acceptance

- [ ] All five subcommands: non-TTY stdout auto-detects snapshot; prints the
      current frame + metadata block; exits 0; no spinner/stream spam.
- [ ] `--snapshot` forces one-shot on a TTY; `--watch` forces the live stream
      when piped; `--snapshot`+`--watch` → stderr error, exit 2.
- [ ] Multi-stream views (board, autopilot) snapshot deterministically: the
      frame reflects ALL streams folded (latch), or `truncated:true` on
      timeout-degrade.
- [ ] No-frame before timeout → exit 1, diagnostic on stderr, `keeper-meta:`
      (frame:null) on stdout; an empty-but-healthy projection exits 0.
- [ ] The `keeper-meta:` line is the last stdout line and is valid parseable
      single-line JSON in every mode (board/jobs/git/autopilot/usage,
      ok/timeout).
- [ ] Humans at a TTY get today's live TUI unchanged (no behavior delta).
- [ ] `bun run test:full` passes.

## Early proof point

Task `.1` proves the shared `src/snapshot.ts` core end-to-end by wiring the
simplest single-stream view (`git`): non-TTY `keeper git` prints one frame +
a valid `keeper-meta:` line and exits 0. If it fails: the seam (frame
capture without the live shell, dispose-then-exit, trailer shape) is wrong —
fix before fanning out to the other mains.

## References

- `src/view-shell.ts:290-698` — `createViewShell` (the shared seam): `emit`
  byte-gate `567-586`, `writeSidecars` `485-530`, spinner-arm site in
  `emitLifecycle` `634`, `installSigintHandler`/`exitCleanly` `644-682`.
- `src/live-shell-core.ts:174-229` — passthrough mode (what snapshot
  REPLACES on the non-TTY path; not reusable as-is — no first-frame/exit).
- `cli/usage.ts:808-1200` — the open-coded outlier (own frameCount/
  emitFrame/writeSidecars/exitCleanly + 30s refreshLive tick); inline per
  decision, must reuse the shared trailer helper to avoid drift.
- `src/readiness-client.ts:310-312,1330` — idempotent `handle.dispose()`;
  `:800` — `connected` fires before the first data frame (latch on first
  DATA callback, not `connected`).
- No related open epics (epic-scout: fn-770 touches readiness only, zero
  file overlap).

## Best practices

- **isatty tri-state:** check `stdout.isTTY !== true`; `undefined` (piped) is
  non-TTY — never coerce before the check. [practice-scout]
- **Honor `CI` / `TERM=dumb`:** a pty under CI sets `isTTY===true` though no
  human watches — the single most common auto-detect false-positive. [practice-scout]
- **JSON trailer LAST, single-line, on stdout even on timeout** (frame:null,
  status:"timeout"); human diagnostic on stderr. Include `schema_version`
  from day one. [practice-scout]
- **`settled` flag + single `cleanup()`** so a frame racing the timeout can't
  double-print/double-exit; **dispose the UDS handle(s) before `process.exit`**
  (autopilot has 4 handles, board 2 — dispose ALL) to avoid a leaked socket
  and Bun's "socket closed with buffered data" warning. [practice-scout]
- **No `process.env` dump in the trailer** (secrets) — surface keeper-named
  paths only. [practice-scout]

## Snippet context

No snippets/bundles attached: `promptctl find-snippets` returned `[]` for
"TUI snapshot", "subscribe live view", and "cli isatty non-interactive agent
output json trailer" (both scout and planner passes). This is a keeper-local
concern with no shared substrate; the contract is defined inline above.
