## Description

**Size:** M
**Files:** cli/setup-tmux.ts, test/setup-tmux.test.ts, README.md

Wire the drop-in's installation into `keeper setup-tmux` (idempotent,
fail-open) and document it. This is the install plumbing for the artifact
shipped in `.1`.

### Approach

In `cli/setup-tmux.ts`:
1. Add an injectable fs seam (default = `node:fs`) mirroring the existing
   `SyncSpawnFn` pattern — the methods needed: `lstat`/`readlink`/`symlink`/
   `mkdir` (or a minimal subset). This is the FIRST fs touch in the file; do
   NOT inline `node:fs` — inject it so `main` stays test-drivable without
   touching real `~/.config`.
2. Pure path builders: source = `<repoRoot>/tmux/keeper-guard.conf`; link =
   `${HOME}/.config/tmux/conf.d/zz-keeper-guard.conf`. Handle empty `HOME`
   defensively (mirror `:98` `${process.env.HOME ?? ""}`) — no-op + warn on empty HOME rather than write a root-relative path.
3. An idempotent `ensureGuardSymlink` step: `mkdir -p` the conf.d parent;
   if the link already points at the source → quiet no-op; if it is a symlink
   to a wrong/missing target → relink; if it is a REAL file (not a symlink) →
   refuse + warn (never clobber); any fs error → warn + continue.
4. Run it in its OWN inner try/catch (mirror the `rebuildDash` fail-open at
   `:672-679`), near the top of `main()`'s `try`, so a failure warns + continues
   and never skips dash rebuild / work-session ensure; exit stays 0.
5. Update the `HELP` block (`:39-73`) with one clause on the symlink install.

In `README.md`: revise the step-10 `keeper setup-tmux` block (`~679-694`) and
the setup-tmux description (`~1404-1445`) to mention the symlink + the
`conf.d`-sourcing precondition; add `rm ~/.config/tmux/conf.d/zz-keeper-guard.conf`
to the Uninstall block (`~1447-1463`) with the no-live-unload note.

### Investigation targets

**Required** (read before coding):
- cli/setup-tmux.ts:118-129 (`SyncSpawnFn`/`defaultSpawn` seam to mirror), :462-483 and :672-679 (`rebuildDash` fail-open pattern), :485-494 (present-vs-absent idempotence), :593-698 (`main` flow), :39-73 (HELP), :98 (empty-HOME guard).
- test/setup-tmux.test.ts:35-53 (`makeSpawnStub` record-calls pattern to mirror for the fs seam), :459-565 (process.exit / TTY global patching).
- README.md:483-495 (LaunchAgent symlink step to mirror), :679-694 (step 10), :1404-1445 (description), :1447-1463 (uninstall), :440 (`mkdir -p` precedent).

**Optional** (reference as needed):
- cli/keeper.ts:167 — confirms `setup-tmux` is already routed (no new subcommand).

### Risks

- First fs seam in a 100%-spawn-based file — keep it injectable or the test would touch real `~/.config`.
- Fail-open isolation: the step must not abort the rest of `main` (own inner try/catch).
- Idempotence must cover all branches (correct / wrong-target / real-file / parent-missing / fs-error).

### Test notes

- Extend `test/setup-tmux.test.ts` with a fake fs seam (record `{mkdir,symlink}` calls, canned `lstat`/`readlink`) and assert: correct link → no relink; wrong target → relink; real file → refuse + no symlink call; parent missing → `mkdir -p` then link; fs error → warn + `main` still completes (dash/work spawns still fire). NO real tmux/fs. Assert HELP mentions the install.
- `bun run test:full` before landing (CLI path).

## Acceptance

- [ ] `keeper setup-tmux` creates `~/.config/tmux/conf.d/zz-keeper-guard.conf` → `<repo>/tmux/keeper-guard.conf`, idempotently, fail-open, in its own try/catch, without disturbing dash/work provisioning.
- [ ] All idempotence branches (correct/wrong/real-file/parent-missing/error) are unit-tested via an injected fs seam, no real fs.
- [ ] HELP + README step 10 / description / Uninstall reflect the install and the `conf.d`-sourcing precondition.
- [ ] `bun run test:full` passes.

## Done summary
Wired the tmux guard drop-in install into keeper setup-tmux via an injectable fs seam: idempotent symlink (correct/wrong/real-file/absent/error branches), fail-open in its own try/catch, plus HELP + README docs. Unit-tested through the seam, no real fs.
## Evidence
