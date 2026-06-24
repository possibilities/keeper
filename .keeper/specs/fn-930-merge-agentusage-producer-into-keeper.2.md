## Description

**Size:** M
**Files:** src/usage-picker.ts (new — vendored `api.ts`), src/usage-flock.ts (new — vendored `flock.ts`), src/agent/main.ts, package.json, test/usage-picker.test.ts (new), test/usage-flock.test.ts (new)

### Approach

Vendor agentusage's `src/api.ts` (`pickProfile`, `listProfiles`, `setStateDir`/
`getStateDir`, `setClock`/`resetClock`, `PICKER_SCHEMA_VERSION`, `DEFAULT_PROFILE`)
and `src/flock.ts` (`FileLock` + libc dlopen) into keeper as a DB-FREE leaf pair
(`src/usage-picker.ts` imports `FileLock` from `src/usage-flock.ts`) — mirror the
fn-929 vendoring + the existing in-tree flock precedent (`src/commit-work/flock.ts`,
libc dlopen in `src/agent/tty.ts:5`). Repoint the ONLY importer — `src/agent/main.ts:18`
`import { DEFAULT_PROFILE, listProfiles, pickProfile } from "agentusage"` → the
vendored leaf — and drop `"agentusage": "file:../agentusage"` from package.json:31.
The vendored leaf MUST NOT import `src/db.ts` (the `cli/agent.ts` header rule, :16-17)
so the launch path stays cold-start cheap. Port the picker's own tests
(`picker.test.ts` + `flock.test.ts`) into keeper's `test/`. The picker's module-global
`stateDir` (`setStateDir`/`getStateDir`) stays the seam `.3` drives from
`resolveUsageRoot()`.

### Investigation targets

**Required** (read before coding):
- src/agent/main.ts:18 (the import), :103/:165 (`pickProfileFn` dep wiring), :1069 (call site), :96-169 (`MainDeps`/`realDeps()`)
- cli/agent.ts:16-17,:22 — the "MUST NOT pull src/db.ts" db-free discipline
- ~/code/agentusage/src/api.ts (:147 pickProfile, :51 module-global stateDir, :54/:59 setStateDir/getStateDir, :47 PICKER_SCHEMA_VERSION, :42 DEFAULT_PROFILE) + ~/code/agentusage/src/flock.ts:165 FileLock — the vendor source
- src/commit-work/flock.ts `CommitWorkLock`, src/agent/tty.ts:5 — keeper's in-tree libc/flock precedent
- package.json:31 — the only `file:` dep; grep confirms `from "agentusage"` is at src/agent/main.ts:18 ONLY

### Risks

- The vendored leaf accidentally importing `src/db.ts` (transitively) re-drags `bun:sqlite` onto the cold launch path — assert db-free with a grep/hygiene check.
- `FileLock` FFI quirks on macOS-aarch64 (FD_CLOEXEC, return type) — the ported `flock.test.ts` is the guard; do not paraphrase the libc calls.

### Test notes

Port `picker.test.ts` (stride scheduling, headroom, stale-still-rotates, multi-process
flock contention) + `flock.test.ts` (advisory-lock correctness) verbatim into keeper's
`test/`, adjusting imports to the vendored paths. `bun run test:full`.

## Acceptance

- [ ] `src/usage-picker.ts` + `src/usage-flock.ts` vendored; `src/agent/main.ts:18` imports them; no `from "agentusage"` remains; package.json:31 dropped; `bun install` clean
- [ ] the vendored leaf imports no `src/db.ts` (grep/hygiene proof); `keeper agent` cold-start unaffected
- [ ] ported picker + flock tests pass under `bun run test:full`

## Done summary

## Evidence
