## Overview

Autopilot's terminal-surface spawning (open/close a `claude` worker
window) is hard-coded to Ghostty via two pieces buried in
`scripts/autopilot.ts`: `launchInGhostty` (osascript → new Ghostty
window, capture `tab-group-…` id) and the `closeWindow` dep
(osascript repeat-loop close-by-id). This epic extracts those
mechanics behind a narrow `ExecBackend` interface in a new
`src/exec-backend.ts`, adds a second `zellij` backend with the same
API (new-tab → capture tab id → close-tab-by-id, plus lazy
session-ensure), and makes the backend selectable by name via two new
`~/.config/keeper/config.yaml` keys — defaulting to **zellij**. All
autopilot orchestration (suppression, settling, dispatch-log stamp,
JSONL persistence, dry-run gating) stays put; only the spawn/parse-id
core and the close call move behind the interface. Entirely
client-side — no event log / reducer / projection / schema impact.

## Quick commands

- `bun test test/exec-backend.test.ts test/db.test.ts` — backend argv
  construction (injected fakes, no real spawn) + the two new config keys
  (present / absent→default / malformed→default)
- `bun test test/autopilot.test.ts` — confirm the launch/close rewire
  didn't break the existing orchestration suite
- `printf 'exec_backend: zellij\nzellij_session: autopilot\n' >> ~/.config/keeper/config.yaml` — opt into zellij (also the default)
- `zellij action new-tab --help | head -8` — confirm the installed binary prints the tab id on stdout

## Acceptance

- [ ] `src/exec-backend.ts` exports `ExecBackend`, `createGhosttyBackend`, `createZellijBackend`, `resolveExecBackend` — factory-style, import-clean (mirrors `src/live-shell.ts`)
- [ ] `resolveConfig()` surfaces `execBackend` (default `"zellij"`, validated against `{ghostty,zellij}`) and `zellijSession` (default `"autopilot"`), independently best-effort, both listed in the catch-block defaults
- [ ] autopilot resolves the backend once in `main()`; `launchWindow` (renamed from `launchInGhostty`) and the `closeWindow` dep route through it; all suppression/settling/log/persist/dry-run behavior is unchanged
- [ ] zellij backend lazily ensures the session (memoized once) before its first `new-tab`, captures the tab id from stdout, and closes via `close-tab-by-id`
- [ ] README config + autopilot prose updated to be backend-neutral

## Early proof point

Task that proves the approach: `<TASK_1>`. If it fails (e.g. zellij
`new-tab` doesn't actually emit a usable id, or the session-ensure race
can't be tamed): keep Ghostty as the shipped default by leaving
`resolveExecBackend`'s fallback at `"ghostty"` until the zellij path is
proven, and land the interface + config plumbing regardless.

## References

- `src/live-shell.ts` — the canonical `src/` factory module shape to mirror (interface-first, `create*({deps})`, no import-time side effects)
- `fn-646` (reverse-dep, NOT hard-wired) — task `.5` "autopilot cutover stateful keymap" ports `scripts/autopilot.ts` into `cli/`; that cutover should wire through this new `ExecBackend` abstraction rather than copying the old inline spawn code. Left as advisory because it depends on us, not vice-versa.
- `fn-648` (overlap, hard-wired as dep) — task `.3` edits `src/db.ts` `migrate()`; this epic edits `KeeperConfig`/`resolveConfig` in the same file (different region). Wired as a coordination dep to avoid a concurrent-edit collision; rm-dep if you'd rather run them in parallel.
- zellij 0.44.3 programmatic control: `zellij --session <s> action new-tab --cwd <abs> -- <argv>` (prints tab id), `zellij --session <s> action close-tab-by-id <id>`, `zellij attach -b <name>` (create detached background session if absent)
- zellij issue #3733 — `action new-tab` races a not-yet-ready `--create-background` session; poll `list-sessions` until the name appears before first new-tab

## Docs gaps

- **README.md** (config block ~lines 242-269): add `exec_backend` + `zellij_session` to the bullet list AND the YAML snippet, same style as the existing keys
- **README.md** (autopilot prose ~lines 496-521): "Ghostty" is hard-coded in ~3 places (spawns a Ghostty window / records its Ghostty window id / auto-closes via osascript) — make backend-neutral or scope the osascript detail to "ghostty backend"; the `--dry-run` mention (~line 520) names Ghostty too

## Best practices

- **Pass argv to zellij as a discrete array after `--`, never via `sh -c`:** `new-tab -- <exe> <args>` execs directly with no shell layer, so the OS argv boundary is the safe quoting seam (no injection surface).
- **Resolve `--cwd` to an absolute path before passing it:** zellij `--cwd` does not expand `~`/`$HOME` (issue #2288); pass `dirFull`, and the baked-in `cd` in `buildWorkerCommand` is the backstop.
- **Ensure the session once, not per-launch:** `attach -b` returns before the server accepts actions; pay the create+poll cost a single time at first use and reuse the ready session (issue #3733).
