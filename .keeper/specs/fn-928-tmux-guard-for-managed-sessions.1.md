## Description

**Size:** S
**Files:** tmux/keeper-guard.conf (new), test/keeper-guard.test.ts (new), test/keeper-guard.slow.test.ts (new), package.json

Ship the static tmux drop-in that stamps the managed-session marker and
confirm-before-guards the create-keys. This is the keystone artifact — the
load-bearing risk (the three-level quoting + the indexed hook) is already
verified on tmux 3.6b; reproduce it faithfully and regression-guard it.

### Approach

Author `tmux/keeper-guard.conf` at the repo root (peer of `plist/`) with, in order:
1. A header comment documenting the two coupling contracts: (a) the file MUST
   install as `zz-keeper-guard.conf` so it loads AFTER `splitting.conf` (the
   human's `tmux.conf` sources `conf.d/*.conf` in glob order) and wins the
   split-key rebinds; (b) the 4 session names + the wrapped split commands are
   hand-copied from `src/exec-backend.ts` and the human's `splitting.conf` —
   there is no import in static tmux config, so keep them in sync.
2. `set-hook -g 'session-created[42]'` running `if-shell -F` with a nested
   name-match on the 4 managed names → `set-option @keeper_managed_session 1`
   (LITERAL value — `set-option` does not format-expand `#{session_name}` in a
   value). Match shape (verified):
   `set-hook -g 'session-created[42]' 'if-shell -F "#{||:#{==:#{session_name},autopilot},#{||:#{==:#{session_name},pair},#{||:#{==:#{session_name},panels},#{==:#{session_name},agentbus}}}}" "set-option @keeper_managed_session 1"'`
3. A best-effort `run-shell -b` sweep stamping any ALREADY-LIVE managed session
   at load time (the hook only catches future creates): loop the 4 names,
   `has-session` then `set-option`. `-b` so it never blocks the command queue.
4. The 5 guarded create-key binds, each `if-shell -F '#{@keeper_managed_session}'`
   with the THEN branch = `confirm-before -p "#S is keeper-managed — <verb>? (y/n)" <cmd>`
   and the ELSE branch = `<cmd>` verbatim, so non-managed sessions are byte-identical:
   - `c` → `new-window` (the unmodified tmux default — no `-c`).
   - `|` → `split-window -h -c '#{pane_current_path}'`; `_` → `split-window -v -c '#{pane_current_path}'` (prefix table).
   - `M-\` → split-h; `M--` → split-v (root table, `bind -n`).
   Conform to the human's `navigation.conf:46` confirm idiom (`#S … (y/n)`).
   Do NOT wrap `%`/`"` (unbound). Verified three-level-quoting example:
   `bind-key | if-shell -F '#{@keeper_managed_session}' "confirm-before -p '#S is keeper-managed — split this pane? (y/n)' 'split-window -h -c \"#{pane_current_path}\"'" "split-window -h -c '#{pane_current_path}'"`

### Investigation targets

**Required** (read before coding):
- /private/tmp/claude-501/-Users-mike-code-keeper/0e40b570-f77a-4948-8802-455f4c650807/scratchpad/keeper-guard.conf — the verified literal-value v2 proof; start from it (add the indexed `[42]` hook + `-b` sweep + the remaining `_`/`M-\`/`M--` binds + header).
- src/exec-backend.ts:115-146 — the 4 `*_EXEC_SESSION` literals the .conf must match.
- test/setup-tmux.test.ts:35-53,59-266 — content/argv assertion patterns to mirror for the guard test.

**Optional** (reference as needed):
- package.json `test` script `--path-ignore-patterns` list — where the new `*.slow.test.ts` is added so it stays out of the fast tier (no real-tmux hygiene gate exists; only the path-ignore is needed).
- scripts/test-gate.ts — how `bun run test` / `test:full` route.

### Risks

- Three-level `confirm-before`/`if-shell -F`/`-c "#{pane_current_path}"` quoting is fiddly — prove each bind installs via `list-keys` and that the else-branch is byte-identical.
- Literal drift: the 4 session names are duplicated by value (can't import TS) — mitigated by the content-guard unit test below. The split commands are duplicated from the human's `splitting.conf` (header comment flags it; not test-guarded since the human owns both).
- The load-time sweep's child `tmux` relies on the default server's `$TMUX`; it is best-effort (`-b`), so a miss only means an already-live session waits until recreated.

### Test notes

- `test/keeper-guard.test.ts` (fast, in-process, NO tmux): read `tmux/keeper-guard.conf` and assert each of the 4 `*_EXEC_SESSION` values (imported from `src/exec-backend.ts`) appears, that `@keeper_managed_session` appears, that the hook uses the indexed `session-created[42]` form, and that it binds `c`/`|`/`_` (+ root `M-\`/`M--`) but not `%`/`"`.
- `test/keeper-guard.slow.test.ts` (real tmux, slow tier): on a throwaway `tmux -L <uniq>` socket, `source-file` the real `.conf`, then assert: a newly-created `pair` session reads `@keeper_managed_session=1`; a `myproj` session reads empty; `list-keys -T prefix` shows the wrapped `c`/`|` binds; and the `|` else-branch is exactly `split-window -h -c '#{pane_current_path}'`. Add this file to the fast-tier `--path-ignore-patterns`; `bun run test:full` runs it.

## Acceptance

- [ ] `tmux/keeper-guard.conf` exists at repo root with the indexed hook, the `-b` sweep, the 5 guarded binds, and the header documenting the `zz-` load-order + duplication couplings.
- [ ] The content-guard unit test asserts all 4 managed-name literals + the marker name + the indexed-hook form, and passes.
- [ ] The real-tmux slow test proves stamp-managed / skip-human / both binds install / byte-identical else-branch, and is excluded from the fast tier but run by `test:full`.
- [ ] `bun run test:full` passes.

## Done summary

## Evidence
