## Description

**Size:** M
**Files:** src/cli.ts, src/format.ts, src/invocation.ts, src/project.ts, src/verbs/state_path.ts (naming per TS convention), tsconfig.json, biome.json, package.json, .gitignore, test/*.test.ts additions

### Approach

The keystone: stand up the `src/` tree on the EXISTING bun toolchain and ship `state-path` end-to-end through a compiled binary. Toolchain deltas: add `src/**` (and any new test glob) to biome.json's files.includes allow-list; tsconfig with moduleResolution "bundler", strict, types ["bun-types"], noEmit; package.json gains `build` (`bun build --compile src/cli.ts --outfile dist/planctl-bun`) and `typecheck` scripts with the Bun version pinned; gitignore dist/. CLI layer: hand-rolled dispatch table reproducing click conventions — `--help` exit 0 on stdout with a `Commands:` section, unknown command exit 2 with Usage / Try 'planctl --help' / blank / Error: lines on stderr, top-level `--format json|yaml|human` plumbed to every verb. Read tests/test_cli.py first and satisfy it exactly: if its help assertions require verb names beyond the four implemented, register those names in help with stubs that exit non-zero with a clear not-available error when invoked (no silent success ever). Emitter spine ported from the Python spec: jsonDumps = stringify(obj, null, 2) + one explicit trailing newline; yamlDump via a yaml emitter configured to match pyyaml (noArrayIndent-equivalent, block scalars for multiline, no key sorting); formatOutput with json default, TTY auto-upgrade to human only when --format absent, EPIPE swallowed; emitError envelope + exit 1. Trailer machinery: compact-serialized planctl_invocation second line (field order per the epic References), emitted soft-fail (dropped silently when no project resolves), suppressed for cat/validate by name. project.ts: findGitRoot parent-walk matching a .git directory OR file, never honoring GIT_DIR, falling back to cwd; resolveProject hard-erroring through emitError when .planctl/ is absent. Then the state-path verb. bun:test units for the emitters and project resolution (Bun.spawnSync for any subprocess-shaped test).

### Investigation targets

**Required** (read before coding):
- planctl/_util.py:92-200 — json_dumps/yaml_dump/format_output, the byte-parity spec
- planctl/cli.py:18-160 — trailer emission, _NO_TRACK_COMMANDS, _extract_target, soft-fail
- planctl/invocation.py:173 — readonly trailer builder
- planctl/project.py — find_git_root/resolve_project semantics
- planctl/run_state_path.py — the verb
- tests/test_cli.py — every assertion the bun help/dispatch must satisfy
- package.json + biome.json — the existing toolchain being extended (allow-list gotcha)

**Optional** (reference as needed):
- tests/test_readonly_verbs.py — the state-path tests this task must turn green (read the landed shape)
- plugin/hooks/ + test/*.test.ts — existing TS style and bun:test idioms to match

### Risks

Compiled-binary divergence: no __dirname/relative-path assumptions, all imports static; the gate must run against dist/planctl-bun, never `bun run`. The minimal conformance env (_subprocess_env) forwards only HOME/XDG/GIT_CONFIG/PATH/PLANCTL_ACTOR — verify the compiled binary boots clean under exactly that env. YAML emitter choice is the likeliest parity fight; the task-1 yaml pins are the arbiter.

### Test notes

Exit: `PLANCTL_BIN=$PWD/dist/planctl-bun uv run pytest tests/test_cli.py tests/test_readonly_verbs.py -k "state_path or cli"` green (state-path + cli surfaces), bun test + biome + tsc green, Python fast gate untouched.

## Acceptance

- [ ] dist/planctl-bun compiles via the package.json build script, chmod+x, Bun version pinned
- [ ] test_cli.py green against the compiled binary; state-path tests from tests/test_readonly_verbs.py green against it
- [ ] Emitters, trailer, project resolution, and dispatch land in src/ with bun:test units; biome includes src/; tsc + lint + bun test green
- [ ] No Python file touched; fast gate green

## Done summary
Stood up the src/ TS tree on the existing Bun toolchain: emitter spine (json/yaml/compact-trailer byte-parity with the Python wire spec via js-yaml), project resolution (realpathSync-matched find_git_root), read-only invocation builder, and a hand-rolled CLI dispatch. state-path ships end-to-end through a bun build --compile binary (dist/planctl-bun); detect/status/epics are registered in help but stubbed to exit non-zero. Conformance gate (test_cli + state_path) green against the compiled binary serially and with -n; bun test/biome/tsc green; Python fast gate untouched.
## Evidence
