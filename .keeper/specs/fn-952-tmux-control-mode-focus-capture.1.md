## Description

**Size:** M
**Files:** src/tmux-control-parser.ts (new), src/tmux-focus-derive.ts (new), test/tmux-control-parser.test.ts (new), test/tmux-focus-derive.test.ts (new)

### Approach

Two PURE, dependency-free seams (no `bun:sqlite`, no daemon imports) so they run in the
fast test tier against golden strings.

1. **Control-mode stream parser** (`src/tmux-control-parser.ts`): raw bytes → a discriminated
   stream of `{ kind: "reply", cmdNum, lines } | { kind: "notification", verb, args } | { kind: "exit", reason? }`.
   A two-state machine: `Idle` vs `InBlock(cmdNum)`. `%begin <ts> <cmdNum> <flags>` opens a block;
   `%end`/`%error` with the SAME cmdNum closes it — match by COMMAND NUMBER only, never ts/flags.
   Inside a block, ANY line (even `%`-prefixed) is body. In `Idle`, a `%`-line is a notification;
   decode the verb + args. Unknown `%`-verbs parse-and-ignore (never throw). `%extended-output`
   (if ever seen) splits header vs value at the FIRST colon. Decode `\NNN` octal only at a
   presentation helper, never in the protocol layer. Guard the line loop with an explicit
   max-iteration bail-out (iTerm2 #2302 infinite-loop class).

2. **Focus-derivation** (`src/tmux-focus-derive.ts`): `parseClientLines(stdout)` + `parsePaneLines(stdout)`
   (tab-delimited `-F` output) and `pickCurrentClient(clients, panes)` → `{ status: "focused"|"none", session_name, window_index, pane_id }`.
   Drop rows with `client_control_mode = 1` (keeper's own observer). Require an attached session.
   Pick `max(client_activity)`, tiebreak `max(client_created)` then lexical `client_name`. Compose
   current client → its session → that session's active window → that window's active pane. Zero real
   clients ⇒ `status: "none"`.

### Investigation targets

**Required** (read before coding):
- src/restore-worker.ts:668 — `parsePaneLines` tab-delimited `-F` parsing pattern to mirror (2-split limit so a session name with tabs is safe).
- src/exec-backend.ts:438 — `localeDefaultedEnv` (the C-locale `\t`→`_` sanitization the worker must apply when it captures the strings these seams parse; the seams themselves stay pure).

**Optional** (reference as needed):
- test/tmux-boot-seed.ts — golden-string / synthetic-fixture test discipline for tmux output.

### Risks

- Misframing: treating a `%`-line inside a block as a notification. The command-number match is the guard.
- Parser infinite loop on a malformed line — the max-iteration bail-out is mandatory.

### Test notes

Fast-tier unit tests with synthetic byte-string fixtures (capture a couple of real `tmux -C`
transcripts once and commit them as static fixtures). Cover: split replies, interleaved
notifications mid-block, unknown verbs, `%exit` with/without reason, multi-client `pickCurrentClient`
(control-mode filtered, tiebreaks), zero-client `none`.

## Acceptance

- [ ] Parser yields a correct discriminated stream for golden transcripts incl. interleaved notifications, split replies, unknown verbs, and `%exit`.
- [ ] Unknown `%`-verbs and malformed lines never throw; the loop has a max-iteration bail-out.
- [ ] `pickCurrentClient` drops `client_control_mode=1`, applies the activity/created/name tiebreak, composes session→window→pane, and returns `none` with zero real clients.
- [ ] Both modules are pure (no db/daemon imports) and run in the fast tier.

## Done summary
Added two pure, dependency-free fast-tier seams: src/tmux-control-parser.ts (command-number-framed control-mode stream parser with notification decode, %exit, max-iteration bail-out, octal/extended-output presentation helpers) and src/tmux-focus-derive.ts (client/pane -F parsers + pickCurrentClient with control-mode filter, activity/created/name tiebreak, session→active-window→active-pane composition). 41 fast-tier tests.
## Evidence
