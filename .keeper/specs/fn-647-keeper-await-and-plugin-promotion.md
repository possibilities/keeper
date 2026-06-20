## Overview

Add a `keeper await` blocking wait-for-condition subcommand to the unified
keeper CLI (built by fn-646), so a Claude Code agent — via the `Monitor()`
tool — or a human can block until a planctl board transition happens, then
act. Four awaitable transitions: epic completed (pops off the board), task
completed, epic unblocked, task unblocked. "Unblocked" deliberately
**excludes autopilot's concurrency serialization** (the
`single-task-per-epic` / `single-task-per-root` readiness mutexes) so the
signal is "ready to be worked on, regardless of how many run at once."
Alongside the command, this epic promotes the keeper repo root into a Claude
plugin (folding in the existing events-writer hook + a new NL skill) and
teaches the arthack launcher to load it via `--plugin-dir`, retiring the
`~/.claude/plugins/keeper` symlink install.

End state: `keeper await complete fn-643-…-hook.4` blocks, emits a
Monitor-shaped event stream on stdout, and exits when the task completes; an
NL skill turns "review when fn-X is done" into the right `Monitor(keeper
await …)` wiring; the hook + skill ship from one root plugin loaded for every
arthack-launched session.

## Quick commands

- `bun test test/await-conditions.test.ts` — pure predicate unit tests
- `keeper await complete fn-646-keeper-cli-opentui-port.1` — block until that task completes (armed line + terminal met/failed)
- `keeper await unblocked fn-650-some-epic` — block until any task/close-row in the epic is workable (concurrency excluded)
- `claude --plugin-dir ~/code/keeper` then `/keeper:keeper-await` available; hook fires once (no double-fold)

## Acceptance

- [ ] `keeper await <complete|unblocked> <id>` exists on the fn-646 dispatcher, auto-detects epic vs task by the `.N` suffix, and is non-TUI.
- [ ] Emits the Monitor protocol: one `[keeper-await] armed …` line after the on-board check, then exactly one terminal `met`/`failed` line; SIGTERM (Monitor timeout) still emits `failed reason=timeout`.
- [ ] "Unblocked" excludes `single-task-per-epic` / `single-task-per-root`; every other blocker (deps, approval, validation, git, dangling-dep, running) still blocks.
- [ ] On-board-or-error: a target absent from board scope at startup ⇒ `failed reason=not-found` exit 1; present-then-vanished ⇒ disambiguated complete-vs-`deleted` (exit 4).
- [ ] Exit codes: 0 met, 1 not-found/usage/connection, 3 timeout, 4 deleted, 5 stuck (only under `--fail-on-stuck`).
- [ ] Repo root is a Claude plugin; the events-writer hook loads exactly once via the launcher (no `~/.claude/plugins/keeper` symlink); a from-scratch session writes one `events` row per hook invocation.
- [ ] NL skill `skills/keeper-await/SKILL.md` wires `Monitor(keeper await …)` and pre-advises that off-board/nonexistent targets can't be awaited.
- [ ] arthack launcher appends `--plugin-dir ~/code/keeper` for all profiles and errors out loudly if the keeper plugin manifest is absent.

## Early proof point

Task that proves the approach: `.1` (the pure `await-conditions` predicate
module + fixtures). It pins the load-bearing semantics — the `workable()`
concurrency carve-out and the complete/unblocked/stuck/not-found/deleted
discrimination — against `test/readiness.test.ts`-style fixtures, with zero
daemon or fn-646 dependency. If it fails: the readiness Verdict shape isn't
a sufficient input and we revisit whether `keeper await` needs a richer
snapshot than `subscribeReadiness` hands back before building the command.

## References

- `src/readiness.ts` — `Verdict` (:260-264), `BlockReason` (:182-193, the two `single-task-per-*` kinds), `ReadinessSnapshot` (:281-286), mutex predicates 11/12 (`applySingleTaskPerEpicMutex` :877, `applySingleTaskPerRootMutex` :943).
- `src/readiness-client.ts` — `subscribeReadiness` (:979, returns the computed `snap.readiness` directly), `subscribeCollection` (:929), `onFatal` default `process.exit(1)` (~:998) — must be overridden so it can't bypass the terminal-line protocol.
- `src/collections.ts:253-265` — epics `default_visible = status='open' OR approval!='approved'` (the "pops off the board" scope) and the `epic_id` pk filter that is scope-exempt for the re-query.
- arthack pairctl `apps/pairctl/pairctl/run_send_message.py` + `helpers.py:emit_event` — the `armed`/terminal event-line convention to mirror.
- `~/code/arthack/system/arthack/.local/bin/arthack-claude.py` — `--plugin-dir` machinery, the `_resolve_agent_plugin` `is_file` existence gate (pattern for the fail-loud preflight), `_CLAUDE_OPTIONS_WITH_REQUIRED_VALUE`.
- Overlap coordination (advisory, not hard deps): fn-643 (.6 final sweep touches `plugin/hooks/events-writer.ts` + README) and fn-645 (`scripts/usage.ts` — this epic does not touch it, low risk). fn-646 already serializes much of the README/plugin surface via the hard dep.

## Best practices

- **Write the terminal line then exit via a write-callback** (`process.stdout.write(line, () => process.exit(code))`), never `process.exit()` first or `process.on("exit")` — a piped fd flushes on the callback, not on close; the terminal line silently drops otherwise.
- **One `terminating` flag** guards every terminal path (met / SIGTERM / failure) so a timeout racing a met can't emit two terminal lines.
- **`key=value`, not JSON**, on the stdout event channel (Monitor feeds lines to Claude as text); sanitize values with `value.replace(/[\r\n]/g, " ")` so embedded newlines can't spoof events; diagnostics go to stderr only.
- **Don't hand-roll `Bun.connect`** — `subscribeReadiness` / `subscribeCollection` are the sanctioned subscribe paths; reuse `LineBuffer` from `src/protocol.ts`.
- **Plugin layout:** `skills/` / `hooks/` live at plugin root, never under `.claude-plugin/` (only `plugin.json` goes there); omit an explicit `version` during dev so the git SHA acts as the per-commit cache key; `plugin.json name: "keeper"` namespaces the skill as `keeper:keeper-await`.

## Docs gaps

- **README.md**: rewrite Install step 4 (retire the `ln -s "$PWD/plugin" ~/.claude/plugins/keeper` symlink → note the root plugin loads via the launcher `--plugin-dir`); remove the `rm ~/.claude/plugins/keeper` line from Uninstall; add a `keeper await` entry to "Example clients" (and fix the "Four scripts" count); mention the dispatcher in one Architecture sentence.
- **CLAUDE.md** (edit in place; AGENTS.md symlink survives): add a short plugin-layout pointer — root `.claude-plugin/plugin.json` is canonical, `plugin/` holds hook source + `bin/`, `skills/` holds NL skills.
