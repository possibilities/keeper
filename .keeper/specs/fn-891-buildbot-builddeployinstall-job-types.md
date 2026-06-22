## Overview

Buildbot (owned by arthack, `system/buildbot/master.cfg`) gains three
first-class job types: **build** (today's CI), **deploy** (mermaidctl —
now gated on a green build), and **install** (global installs + dependency
refreshes, each triggered by a repo's green build). It also gains scheduled
runs: arthack preinstall+install+doctor 4×/day and a dotfiles install daily.
keeper's read-only `keeper builds` viewer renders the job type per row.
Config stays in arthack; keeper stays the viewer over buildbot's REST API.
Scope is locked: reconfigure already-connected builders only; the one
addition is a dotfiles install-only builder.

## Quick commands

- `~/.local/share/uv/tools/buildbot/bin/buildbot checkconfig ~/.local/state/buildbot/master` — the config gate; must pass after every master.cfg change
- Force a builder from the web UI (`http://greybird.taile9945f.ts.net:8010/`) or `POST /api/v2/forceschedulers/force` — manual build/deploy/install path
- `keeper builds` — confirm each row shows its job type (build/deploy/install)

## Acceptance

- [ ] master.cfg models build/deploy/install via a shared step-builder + typed dispatch; the 5 existing build builders + mermaidctl-deploy are construction-identical after the refactor
- [ ] each installable repo (keeper, agentrender, agentusage, arthack) has an install builder triggered by its green build; agentusage's install is a dep refresh (no bun link)
- [ ] mermaidctl-deploy fires only when arthack's build is GREEN and the changes touched apps/mermaidctl/**
- [ ] arthack install+doctor run 4×/day and dotfiles install runs daily, all visible in `keeper builds`, without the scheduled install self-killing the buildbot master
- [ ] `keeper builds` renders the job type per row (render-time only; no schema/worker/fold change)
- [ ] `buildbot checkconfig` passes

## Early proof point

Task that proves the approach: `.1` (typed job-factory foundation). It is
behavior-preserving — `checkconfig` green AND the existing builders
construct byte-identically proves the typed dispatch before any new builder
piles on. If it fails: the `_make_step` extraction is leaking behavior — diff
the constructed builder set (names/steps/envelope) before vs after and fix
the helper before proceeding.

## References

- Buildbot 4.3.0 (pinned at `arthack/scripts/install.sh:664`; docs at docs.buildbot.net/4.3.x)
- Prior deploy work (arthack planctl board): `fn-670` buildbot-driven-mermaidctl, `fn-671` buildbot-config-tree — this epic continues them
- keeper builds surface: `fn-781` keeper-builds-buildbot-surface (the viewer being extended)
- Single-worker deadlock + gating: `Trigger(waitForFinish=False)` mandatory on `max_builds=1`; `doStepIf=success` required (checks flunk-but-don't-halt); Dependent's HEAD/source-stamp caveat is benign for live-tree installs (docs.buildbot.net schedulers/trigger/steps)
- arthack tasks land in `/Users/mike/code/arthack`; the viewer task lands in keeper (this board's primary repo)

## Docs gaps

- **arthack `system/CLAUDE.md`**: buildbot bullet — document the new builder-name suffix convention (`-install`/`-deploy`) and the three job types
- **keeper `cli/builds.ts`** HELP constant (38-58) + file JSDoc (3-28): describe the render-time job-type tag and how it's derived from the builder name
- **keeper `README.md`**: viewer enumeration is stale ("five snapshot-capable viewers", ~line 629) and the Architecture subcommands list (~2913) omits `builds` — correct both to six incl. `builds`
- **keeper `.keeper/specs/fn-781-...md`**: the row-format acceptance bullet should name the job-type field once the viewer ships it

## Best practices

- **`waitForFinish=False` on the Trigger step:** on `max_builds=1`, `True` deadlocks (parent holds the only slot while the child waits for it). [buildbot serial-worker]
- **`doStepIf=success` gate:** arthack checks are `flunkOnFailure` but not `haltOnFailure`, so a naive end-of-factory Trigger fires on a red build. [buildbot steps/common]
- **Nightly does no catch-up:** a slot missed while the Mac sleeps is dropped, not backfilled — acceptable (matches launchd, master is KeepAlive). [buildbot schedulers]
- **BuilderConfig `tags` are static identity, `properties` are per-build:** classify job type with `tags`, never encode dynamic data in tags. [buildbot config]
