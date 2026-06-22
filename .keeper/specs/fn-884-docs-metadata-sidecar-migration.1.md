## Description

**Size:** M
**Files:** plugins/keeper/plugin/hooks/sidecar-writer.ts (new), plugins/keeper/hooks/hooks.json, src/sidecar.ts (new, shared dep-free helper), test/sidecar-writer.test.ts (new), CLAUDE.md, README.md

### Approach

Add a fail-open `PostToolUse` hook to the keeper plugin. On `Write` to a `.md` under `~/docs` (honor a `KEEPER_DOCS_DIR` override for tests), create-or-merge the doc's `.yaml` sidecar — NEVER modify the `.md`. On Bash `gh gist create`, parse the gist URL from `data.tool_response` and upsert `gist-url:` into the matching `.md`'s sidecar only. Mirror `events-writer.ts`: `readStdin`, `strField` payload extraction, and the `import.meta.main` + exit-0 outer guard (events-writer.ts:~864). Clone `resolveEventsLogDir()` as `resolveDocsDir()` (`KEEPER_DOCS_DIR` else `~/docs`). Reuse `src/derivers.ts` `extractMutationPath` (Write path) and `extractBashMutation`/`tokenizeShell` (Bash). Factor the strip-signature detector + sidecar read/merge/write into a NEW dep-free `src/sidecar.ts` (imports limited to node:fs/os/path) so task `.4`'s migration reuses the SAME strip logic (no regex drift). Hand-roll YAML (no dep-free serializer importable in a hook): single-quote scalars (escape `'`→`''`), quote special chars, spaces not tabs.

**Sidecar fields** (resolved): `path`, `type: doc`, `created` (now, ISO; preserve existing on merge), `session-id` + `cwd` from the PostToolUse payload (`session_id`/`cwd`), `resume` built from cwd+session-id; `git-branch`/`git-commit` best-effort via a single wrapped `git -C <cwd> rev-parse` (omit on any failure). NO `claudectl` dependency. `~/docs` ONLY — no `~/briefs`.

**hooks.json:** add Write + Bash entries to the existing `PostToolUse` array (the events-writer `*` entry already exists — do NOT touch/duplicate it). Matchers are tool-name, not path → the hook self-gates on path/command.

### Investigation targets

**Required:**
- plugins/keeper/plugin/hooks/events-writer.ts:70-87,599-645,864-881 — readStdin, field extraction, exit-0 guard
- plugins/keeper/plugin/hooks/events-writer.ts:382-412 — `resolveEventsLogDir` env-override pattern to clone
- plugins/keeper/plugin/hooks/branch-guard.ts:1-16 — pure-predicate + fast-tier test sibling
- src/derivers.ts (extractMutationPath ~171-194, extractBashMutation ~659-670, tokenizeShell ~688) — reuse, do not duplicate
- plugins/keeper/hooks/hooks.json — PostToolUse array shape
- test/branch-guard.test.ts, test/events-writer.test.ts, test/helpers/sandbox-env.ts — two-layer test pattern + sandboxEnv(extra:{KEEPER_DOCS_DIR})

### Risks

- Exit 0 is load-bearing — a non-zero exit fail-closes the human's session. Wrap everything; add uncaughtException/unhandledRejection → exit 0.
- Never import bun:sqlite or src/db.ts (cold-start regression). Keep src/sidecar.ts dep-free too.
- gist URL regex must be bounded `https?://[^\s"'<>]+` (the old greedy regex corrupted 4 docs by swallowing the JSON tail).
- Atomic sidecar write (tempfile in same dir + rename) so a killed hook leaves the prior sidecar intact.

### Test notes

`test/sidecar-writer.test.ts`: Layer 1 — export + unit-test the pure parser/strip-signature/sidecar-merge fns. Layer 2 — `Bun.spawn(["bun", HOOK])` with `sandboxEnv({tmpDir, dbPath, clearAmbientIds:false, extra:{KEEPER_DOCS_DIR}})`; assert sidecar written, `.md` UNCHANGED, exit 0 on garbage stdin, no-op on non-docs path. Keep it fast-tier (like branch-guard); if subprocess spawns are slow, add `--path-ignore-patterns` to the `test` script only.

## Acceptance

- [ ] Write to `$KEEPER_DOCS_DIR/foo.md` creates/merges `foo.yaml`, leaves `foo.md` byte-unchanged
- [ ] Bash `gh gist create .../foo.md .../foo.yaml --web` upserts `gist-url:` into `foo.yaml` only (URL bounded, no JSON tail)
- [ ] merge preserves existing `created`; no `~/briefs` handling; no `claudectl`/db/sqlite imports
- [ ] hook exits 0 on malformed stdin, non-docs path, and missing docs dir
- [ ] `bun test test/sidecar-writer.test.ts` passes; `bun run test:full` green
- [ ] keeper CLAUDE.md ("Two hooks, two contracts"→three) + README (Install + Architecture hook count/paragraph) updated forward-facing

## Done summary
Added the fail-open keeper PostToolUse(Write|Bash) sidecar-writer hook + dep-free src/sidecar.ts (strip-signature + sidecar parse/merge/serialize, shared with the .4 migration). On Write to ~/docs/*.md it create-or-merges the .yaml sidecar (never the .md); on gh gist create it upserts a bounded gist-url. Exported tokenizeShell, wired hooks.json, updated CLAUDE.md/README; 30 unit+subprocess tests green and test:full passes.
## Evidence
