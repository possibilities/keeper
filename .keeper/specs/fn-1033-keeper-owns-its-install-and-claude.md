## Overview

Keeper stops depending on arthack to install it. The `claude` dotfiles source
(settings.json + CLAUDE.md) moves into keeper at `system/claude/.claude/`, and
keeper's launch-time canonical-link guard resolves that dir from its OWN module
path — the `claude_stow_dir` config key is retired. A new idempotent
`scripts/install.sh` owns keeper's install footprint (bun install + bun link +
gated keeperd reload). There is NO stow step: the launch guard
(`ensureCanonicalStowLinks`) is the sole creator/healer of `~/.claude/{settings.json,CLAUDE.md}`.
An external buildbot `keeper-install` job runs the script on green build. Arthack
drops its `bun link` + `claude` stow steps, shrinking the coupling to one
plain-data dict in the shared buildbot registry.

**Rollout / one-time cutover (operator-run, not a worker task).** The content
move + ownership handoff is not atomic across the two repos. After tasks 1 and 2
land in keeper, the operator — autopilot paused — launches `keeper agent claude`
once so the guard re-points `~/.claude/{settings.json,CLAUDE.md}` at keeper's copy
(content is byte-identical to arthack's live copy, so the guard relinks cleanly
with no divergent-clobber StateError). Only then does task 3 remove arthack's
now-redundant ownership.

## Quick commands

- `bash scripts/install.sh && bash scripts/install.sh` — idempotent; second run is a no-op reload when nothing changed
- `~/.bun/bin/keeper --help >/dev/null && echo linked` — keeper on PATH via bun link
- `launchctl list | grep arthack.keeperd` — daemon loaded
- `ls -l ~/.claude/settings.json` — after one launch, a symlink into `<keeper-repo>/system/claude/.claude/`

## Acceptance

- [ ] Keeper resolves its claude source from its own module path; `claude_stow_dir` retired; the `!existsSync` + `KEEPER_AGENT_SKIP_LINK_GUARD` fail-opens preserved
- [ ] `scripts/install.sh` is idempotent (bun install + bun link + gated keeperd reload, no stow)
- [ ] Buildbot `keeper-install` job runs the script green-gated on keeper's build
- [ ] Arthack no longer bun-links keeper or stows the claude package; its keeper-dependency verifies remain intact
- [ ] `~/.claude/{settings.json,CLAUDE.md}` owned by keeper's guard end-to-end, with no ownership gap through the cutover

## Early proof point

Task that proves the approach: `1` (keeper resolves its own claude source and the
guard owns the canonical leaves). If it fails — module-path resolution doesn't
survive `bun link`, or the guard churns "wrong target" every launch — fall back to
pinning the resolver default in `realDeps()` to `$HOME/code/keeper` rather than
`import.meta.url`.

## References

- `src/keeper-agent-path.ts:32-43` — the `fileURLToPath(import.meta.url)` self-resolution pattern to mirror
- `README.md:406-641` — the manual install procedure `install.sh` formalizes
- `~/code/arthack/system/buildbot/master.cfg:360-372` — the install-builder wiring; `:177-180` sitter's gated-reload precedent
- Decision: guard-only ownership of the canonical leaves — no install-time stow
- Forward-awareness: a future presets-`<harness>_default` / fail-loud effort will also edit `config.ts` + `main.ts` and ultimately delete `claude.yaml`; not yet on the board, so no dep is wired here — whoever plans it next must expect config.ts/main.ts overlap
