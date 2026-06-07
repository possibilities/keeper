## Description

**Size:** S
**Files:** plist/arthack.keeper-babysit.plist, README.md, CLAUDE.md

The ops wrapper: the launchd template that runs `--tick` every 5 min, plus the
install/uninstall/architecture docs. Depends on .2 for the final `--tick`
invocation + state-dir paths.

### Approach

Mirror `plist/arthack.keeperd.plist` (TEMPLATE — keeper ships no install verb;
hard-coded absolute paths, header comment with the manual symlink + bootstrap
steps). `Label` arthack.keeper-babysit; `ProgramArguments`
`/opt/homebrew/bin/bun run /Users/mike/code/keeper/cli/keeper-watch.ts --tick`;
`EnvironmentVariables.PATH` including `/Users/mike/.local/bin` (notifyctl/botctl);
`ProcessType` Background; `WorkingDirectory` the repo root; `StandardOutPath` /
`StandardErrorPath` under `~/.local/state/keeper-watch/`. Periodic via
`<key>StartInterval</key><integer>300</integer>` — NOT `KeepAlive` (mixing them
defeats the interval). `RunAtLoad` true for an immediate first pass (the scanner
already exits 0 cleanly if the DB is missing). No `~` anywhere in the plist.

Docs (per docs-gap-scout): README Install (new step beside the logrotate sidecar:
symlink + `launchctl bootstrap gui/$UID`), Uninstall (`bootout` + `rm`),
Architecture (~L946, one sentence: out-of-process read-only scanner, never writes).
CLAUDE.md: one line under "Writes are tightly scoped" — babysitter is a pure
read-only external scanner (no event-log write, no synthetic events, no RPC).
`keeper-watch` is its own binary, not a `keeper` subcommand — don't add it to the
subcommand enumeration as one.

### Investigation targets

**Required** (read before coding):
- plist/arthack.keeperd.plist — the template to mirror
- plist/arthack.keeperd.logrotate.plist — periodic-job precedent
- README.md Install / Uninstall / Architecture sections (~L194, ~L478, ~L946)

**Optional** (reference as needed):
- CLAUDE.md "Writes are tightly scoped" heading — where the one-line note lands

### Risks

- Wrong `bun` path or missing PATH entry → silent launchd failure; verify with `launchctl print`.
- `~` in plist → path not resolved; use absolute paths only.

### Test notes

No unit test. Manual: symlink + `launchctl bootstrap gui/$UID`, confirm a tick
runs (StandardOut log), `launchctl print gui/$UID/arthack.keeper-babysit` shows
it loaded, then `launchctl kickstart` to force a tick.

## Acceptance

- [ ] plist/arthack.keeper-babysit.plist mirrors keeperd conventions: absolute bun path, PATH incl ~/.local/bin, StartInterval 300, no KeepAlive, ProcessType Background, no `~`
- [ ] Header comment documents the manual symlink + bootstrap + uninstall steps
- [ ] README Install / Uninstall / Architecture updated; CLAUDE.md one-line note added
- [ ] `launchctl bootstrap` loads it and a forced tick runs cleanly against the live DB

## Done summary

## Evidence
