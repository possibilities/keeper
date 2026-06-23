## Description

**Size:** S
**Files:** plugins/plan/package.json, plugins/prompt/package.json, bun.lock files

### Approach

With `yamlDump` relocated (task .1), `plugins/plan/src/` no longer imports
`js-yaml`, so drop `js-yaml` + `@types/js-yaml` from
`plugins/plan/package.json`. The prompt plugin imports `js-yaml` directly
in ~10 files but does NOT declare it (it free-rides on the hoisted/root
install) — add `js-yaml` + `@types/js-yaml` to `plugins/prompt/package.json`
so the plugin owns what it imports. Root `package.json` KEEPS `js-yaml`
(`src/pair-command.ts` uses it) — do not touch root. Reconcile lockfiles
and prove a clean install resolves.

### Investigation targets

**Required** (read before coding):
- plugins/plan/package.json — `js-yaml` (~line 14) + `@types/js-yaml` (~line 20) to remove; KEEP `yaml` (eemeli, the scaffold-input parser)
- plugins/prompt/package.json — currently has no `js-yaml`; add `js-yaml` + `@types/js-yaml` (match the versions used elsewhere: js-yaml 4.2.0, @types/js-yaml 4.0.9)

**Optional** (reference as needed):
- root package.json:24,31 — `js-yaml` + `@types/js-yaml`; KEEP (pair-command depends on it)
- plugins/plan/bun.lock, plugins/prompt/bun.lock, root bun.lock — lockfiles a dep change touches

### Risks

- Phantom resolution: in a hoisted workspace, dropping from plan's package.json may still resolve js-yaml via root/prompt, masking a missing declaration. Validate with `rm -rf node_modules && bun install --frozen-lockfile` (or equivalent) and a fresh build, not just an incremental install.
- Lockfile drift: run the remove in the plan workspace, then a workspace-root `bun install` to normalize all lockfiles; a drifted lockfile fails `--frozen-lockfile` in CI.
- Do NOT drop `js-yaml` from root — `src/pair-command.ts` imports it for pair `--output`.

### Test notes

After the dep change: clean install, `bun run typecheck` + `bun test` in
both plugins, and build the `keeper plan` binary to confirm js-yaml is no
longer bundled and the prompt bundle-write path still works.

## Acceptance

- [ ] `js-yaml` + `@types/js-yaml` removed from `plugins/plan/package.json`; `yaml` (eemeli) retained
- [ ] `js-yaml` + `@types/js-yaml` added to `plugins/prompt/package.json`
- [ ] root `package.json` unchanged (still declares `js-yaml`)
- [ ] a clean `bun install --frozen-lockfile` resolves; both plugin suites pass; `keeper plan` builds without bundling js-yaml
- [ ] lockfiles reflect the change with no drift

## Done summary

## Evidence
