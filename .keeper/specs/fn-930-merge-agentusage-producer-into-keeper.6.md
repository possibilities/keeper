## Description

**Size:** S
**Files:** ~/code/agentusage/src/api.ts, src/flock.ts, src/index.ts (remove), package.json / bun.lock (drop TS bits), README.md, CLAUDE.md

### Approach

After the picker is vendored into keeper (`.2`) and keeper no longer imports
`agentusage`, remove agentusage's now-orphaned TS surface so the repo is Python-only:
delete `src/api.ts`, `src/flock.ts`, `src/index.ts` and the TS-related `package.json`
exports / bun bits. Update agentusage's README + CLAUDE.md, forward-facing: the
surface is now a one-shot Python scrape util keeper shells out to; drop the
"long-lived daemon" framing + the `file:../agentusage` TS-consumer mention. Keep it a
light edit — a redesign note, not a rewrite; AGENTS.md (if present) is a symlink, edit
in place.

### Investigation targets

**Required** (read before coding):
- ~/code/agentusage/src/{api.ts,flock.ts,index.ts} + package.json — the TS surface to remove
- ~/code/agentusage/README.md + CLAUDE.md — the daemon→one-shot-util framing to revise
- confirm `.2` has shipped (keeper no longer resolves `file:../agentusage`) before removing — this is why `.6` depends on `.2`

### Risks

- Removing the TS before keeper's vendor (`.2`) lands would break keeper's build — the dep on `.2` enforces the order.

### Test notes

No keeper test surface. In agentusage: the Python pytest suite still passes; `bun`
is no longer required for the repo. Sanity: nothing in keeper resolves `agentusage`.

## Acceptance

- [ ] `~/code/agentusage/src/*.ts` + the TS package bits removed; the repo is Python-only; the Python pytest suite still passes
- [ ] agentusage README + CLAUDE.md revised forward-facing (one-shot util, no daemon, no `file:` TS consumer)
- [ ] nothing in keeper resolves `agentusage` (verified post-`.2`)

## Done summary
Removed agentusage's orphaned TS surface (src/{api,flock,index}.ts, TS tests, package.json/bun.lock/tsconfig/biome) making the repo Python-only; revised README + CLAUDE.md forward-facing to the one-shot util framing; migrated keeper's cwd-ordinal import from agentusage/flock to the vendored src/usage-flock so nothing in keeper resolves agentusage.
## Evidence
