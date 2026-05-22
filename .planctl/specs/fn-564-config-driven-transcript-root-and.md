## Overview

keeper's transcript-title pipeline has two restart-fragility defects, diagnosed
from a real miss (a session renamed to "simplify-tui-navigation" never folded;
`jobs.title` stayed stuck at a lower-priority payload title). (1) The transcript
watch root is driven by the `KEEPER_WATCH_ROOT` env var, which a manual daemon
restart silently dropped. (2) The worker anchors each file's tail at EOF on first
sight and never scans existing content at boot, so any `custom-title` set while
the daemon was down is permanently missed until the title changes again. This epic
moves the watch root into `~/.config/keeper/config.yaml` under a clear
`claude_projects_root` key (separate from the plan `roots` key) and adds a startup
current-title fold scoped to live jobs via `jobs.transcript_path`. End state:
renames survive daemon restarts, and the watch root is configured, not env-fragile.

## Quick commands

- `bun test --isolate` — full suite green
- `bun test --isolate test/transcript-worker.test.ts test/db.test.ts test/integration.test.ts` — the touched suites
- Manual repro of the fixed bug: stop keeperd, set a `custom-title` in a session transcript, restart keeperd, confirm `jobs.title` folds to it

## Acceptance

- [ ] `KEEPER_WATCH_ROOT` is retired; the transcript watch root resolves from `claude_projects_root` in `~/.config/keeper/config.yaml` (default `~/.claude/projects`), independent of the plan `roots` key
- [ ] A `custom-title` set while the daemon is down is folded into `jobs.title` on the next boot
- [ ] No duplicate `TranscriptTitle` events on restart for an unchanged title (re-fold determinism preserved)
- [ ] Worker stays read-only (main remains sole writer of synthetic events); full `bun test --isolate` green; README + CLAUDE.md/AGENTS.md updated

## Early proof point

Task that proves the approach: `.2` (startup fold) — it directly fixes the diagnosed
miss. If it fails (e.g. the change-gate doesn't suppress restart re-emits): fall back
to scoping the scan to jobs whose `title_source != 'transcript'`, or gate emits behind
an explicit "title differs from persisted" check.

## References

- Root-cause investigation (this session): session `566f013d` renamed to "simplify-tui-navigation" — zero `TranscriptTitle` events for it; last `transcript_title` event id 24316 at 08:25 vs daemon restart at 08:30, so every successful title was emitted by the pre-restart daemon.
- `src/plan-worker.ts` `scanRoot` (400-421) + `seedFromDb` — the boot-scan + change-gate precedent both tasks mirror.
- `src/db.ts` config triplet (58-149) — the config-migration template.

## Docs gaps

- **CLAUDE.md / AGENTS.md** (symlinked, same file): transcript-worker description (hardcodes `~/.claude/projects` → make config-driven, name the key); `src/db.ts` description (add the `resolveClaudeProjectsRoot` resolver); state-machine `TranscriptTitle` bullet (note the startup-seed path — a `TranscriptTitle` can now emit at boot); Worker-contract producer archetype (how the watch root is resolved); DO NOT transcript bullet consistency.
- **README.md**: architecture "third Worker" paragraph (206-212, config-driven framing); install step 3 (105-121, document `claude_projects_root` + default + when to override, alongside `roots`); "What keeper is NOT" `@parcel/watcher` bullet (77-81, loosen the hardcoded-path assumption).

## Best practices

- **The change-gate IS the dedup layer for the startup scan** — re-reading an already-folded title is auto-suppressed by `lastEmitted` (seeded by `seedFromDb`) plus the reducer's same-priority-same-value no-op. Correctness comes from the idempotency gate, not from perfect ordering.
- **Snapshot file size once, read forward from offset 0** — `const size = statSync(path).size` taken once, loop `while (offset < size)`; bytes appended after the snapshot are picked up by the normal live tail. Forward-from-0 keeps every `\n`-terminated line whole (only a trailing partial is torn); never reverse-scan from EOF (boundary-reconstruction footgun) and never `readFileSync` the whole transcript.
- **Tilde-expand only a leading `~/` / bare `~`** against `homedir()`, matching the existing `resolvePlanRoots` expander; Node/Bun core does not expand `~`, and `path.join` an already-absolute value resets the path.
