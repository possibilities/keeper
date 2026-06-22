## Description

**Size:** S
**Files:** cli/builds.ts, test/builds.test.ts, README.md

### Approach

Render-time ONLY — derive job type from the builder NAME (the `project` PK
string) suffix: `-deploy` → deploy, `-install` or `-doctor` → install, else
build. This is the only contract with the arthack side (the builder-name
suffix convention); the keeper change needs no arthack code. Add a pure
exported `resolveJobType(project)` next to `resolveStatus` (cli/builds.ts:89-97),
following the `RESULT_STATUS` const-table idiom (:73-81), and insert an
ASCII-safe type tag into `renderRow`'s `parts` array (:130-152). Reuse `seg`
(:117-119) for null-safe coercion.

NO schema / payload / worker / fold change: the `builds` projection has no
`tags` field and is a deterministic-replayed projection (re-fold is sacred).
Rows already arrive sorted `project ASC`, so `arthack` / `arthack-deploy` /
`arthack-doctor` / `arthack-install` cluster naturally — do any grouping
purely client-side in `renderRowLines` (:165-167) if desired; do NOT touch
the wire sort or the descriptor.

Also: update the HELP constant (:38-58) + file JSDoc (:3-28) to describe the
type tag, and fix the stale README viewer enumeration ("five" → "six", add
`builds`) at ~line 629 and the Architecture subcommands list at ~2913.

### Investigation targets

**Required** (read before coding):
- cli/builds.ts:73-81 (RESULT_STATUS table + Status interface), :89-97 (resolveStatus — sibling seam), :130-152 (renderRow parts array)
- cli/builds.ts:105-119 (formatAge / seg helpers — reuse, don't reinvent), :165-167 (renderRowLines — client-side grouping seam)
- test/builds.test.ts:33-44 (freshRow override factory), :101-108 (Set-distinctness assertion to mirror)

**Optional:**
- cli/builds.ts:38-58 (HELP), :3-28 (JSDoc); README.md:629 + :2913 (viewer enumerations)

### Risks

- Keep it render-time only — no fold/worker/schema exposure (re-fold determinism).
- `-doctor` → install is a convention choice; keep it aligned with task `.1`'s suffix contract (deploy/install/build are the three displayed types; doctor is install-family).
- `updated_at` is seconds while `now` is ms (the `*1000` at :140 is load-bearing) — don't disturb age logic.

### Test notes

Add cases to test/builds.test.ts with `project` overrides `"foo"`, `"foo-install"`, `"foo-deploy"`, `"foo-doctor"`; assert the type tag renders and the types are distinct (mirror the `new Set(lines).size` assertion).

## Acceptance

- [ ] `resolveJobType` derives deploy/install/build from the builder-name suffix (doctor → install)
- [ ] `keeper builds` renders an ASCII-safe job-type tag per row; no schema/worker/fold change
- [ ] tests cover build/deploy/install (+ doctor) and assert distinct rendering
- [ ] HELP + JSDoc updated; README viewer enumeration corrected to six incl. `builds`
- [ ] `bun run lint` + `bun run typecheck` + `bun test test/builds.test.ts` pass

## Done summary

## Evidence
