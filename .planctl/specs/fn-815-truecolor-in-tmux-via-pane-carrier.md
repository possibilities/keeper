## Overview

Claude Code hard-caps itself to 256-color whenever `$TMUX` is set (ink2 renderer, since v2.1.77; anthropics/claude-code#36785), so theme colors render muted inside tmux even though tmux passes 24-bit truecolor through fine. The fix hides `$TMUX` from Claude at launch (claudewrap strips it) so Claude emits truecolor — but `$TMUX` is also what keeper's events-writer hook keys off to stamp the tmux pane id that keeperd's renamer-worker needs to auto-name windows. Approach B2 keeps both: claudewrap copies the pane id to a keeper-owned carrier env var `KEEPER_TMUX_PANE` before deleting `$TMUX`/`$TMUX_PANE`, and keeper's hook grows a fallback arm that stamps identical tmux coords from the carrier when native `$TMUX` is absent. End state: new Claude sessions under tmux render truecolor AND keep automatic window renaming.

Lockstep: keeper lands first (the fallback is inert until something sets the carrier), then claudewrap.

## Quick commands

- keeper gates: `cd ~/code/keeper && bun run test:full && bun lint && bun typecheck && bun run assert-comment-only`
- claudewrap gates: `cd ~/code/claudewrap && bun test && bun lint && bun typecheck`
- post-deploy truecolor check (new claudewrap session in tmux): `tmux capture-pane -p -e -t <pane> | grep -ao '48;2;[0-9;]*'` — expect 24-bit `48;2;...`, not `48;5;37`
- post-deploy rename check: `/rename probe` in the session, then `tmux list-windows` shows the window renamed

## Acceptance

- [ ] keeper: `execBackendEnvMeta("tmux")` returns `paneIdCarrierEnvVar: "KEEPER_TMUX_PANE"`; `backendExecCoordsFromEnv` native arm byte-unchanged; fallback arm stamps coord-identical `{type:"tmux", paneId, sessionId}` from the carrier when `$TMUX` absent, all-NULL when the carrier is empty/absent
- [ ] keeper `CLAUDE.md` scraping-scope rule lists `KEEPER_TMUX_PANE`; `docs/exec-backend.md` + `README.md` env-read sequence updated
- [ ] claudewrap: under tmux, deletes `TMUX`/`TMUX_PANE` from the Claude child env after copying the pane id to `KEEPER_TMUX_PANE` (only when `TMUX_PANE` non-empty); no-op when `$TMUX` absent
- [ ] cross-reference comments on both sides name the other repo's literal (drift guard — comments only)
- [ ] end-to-end (post-deploy): a new claudewrap session in tmux renders truecolor (`48;2`), `/rename` still renames the tmux window, OSC 52 copy still reaches the clipboard
- [ ] both repos' test/lint/typecheck gates green

## Early proof point

Task that proves the approach: task 1 (keeper). Its `backendExecCoordsFromEnv` fallback-arm tests assert carrier-stamped rows are byte-identical to native-stamped rows — the load-bearing equivalence the renamer-worker depends on. If it fails: reconsider whether the renamer needs more than `{type, paneId}` (e.g. the session id) to map a job to a window, and adjust the carried fields.

## References

- anthropics/claude-code#36785 — hardcoded `if (process.env.TMUX && level>2) level=2` cap (root cause; v2.1.77 regression); #35148 (open) — washed/salmon branding under tmux.
- Lockstep / rollout: ship keeper (task 1) first — the fallback is inert until claudewrap sets the carrier; then claudewrap (task 2). Activation: keeper plugin reinstall (`rm -rf ~/.claude/plugins/cache` + reinstall) + keeperd restart; claudewrap is live on next launch. Existing Claude sessions keep their old env (256-color) until relaunched — an accepted mixed-mode window; no session breaks renaming.
- Universal chokepoint: every Claude launch (interactive + keeper restore-agents) goes through the `claude`→`claudewrap` alias under `zsh -l -i -c`, so the claudewrap-side fix covers all paths; no restore-agents change.
- Verified non-issues: `$TMUX` alone triggers the cap (`env -u TMUX` keeps `TERM=tmux-256color` + `TMUX_PANE` and already renders truecolor); `set-clipboard external` keeps OSC 52 working without `$TMUX`.

## Docs gaps

- **keeper/docs/exec-backend.md**: update the `execBackendEnvMeta` helpers row to name the `paneIdCarrierEnvVar` carrier; revise the "Color-capable env" paragraph (truecolor now comes from claudewrap stripping `$TMUX`; the carrier preserves the pane id); note the carrier as the fallback-read key in "Extending to a new backend".
- **keeper/README.md**: revise the env-read-sequence passages (brief ~67-70 + authoritative ~1732-1737) to describe the two-step read (native `TMUX_PANE`, else carrier `KEEPER_TMUX_PANE`).
- **keeper/CLAUDE.md** (~line 46): add `KEEPER_TMUX_PANE` to the scraping-scope env list (reviewer invariant; same commit as the hook change).
- **claudewrap/CLAUDE.md**: add an env-stripping section (what is stripped, why = truecolor, carrier preserves the pane id, copy-before-strip ordering, gated on `$TMUX` present).

## Best practices

- **Mutate `process.env` in place; do not pass `env:` to `Bun.spawn`:** `defaultSpawn` inherits live `process.env`; adding an `env:` object without spreading `...process.env` would drop the carrier and `PATH`. An anti-fix comment guards this.
- **Namespace the carrier** (`KEEPER_TMUX_PANE`, owner-prefixed SCREAMING_SNAKE) to avoid collisions; it propagates transitively to Claude's children incl. hooks — exactly how the hook receives it.
- **Treat the carrier as a hint, not proof of a live pane:** the hook collapses empty→NULL and refuses to stamp `type=tmux` with a NULL pane.
