## Overview

Second epic of the Python→Bun migration program: extend the repo's existing Bun/TS toolchain (root package.json, biome, bun:test) into a `planctl-bun` CLI — a `src/` TypeScript tree implementing the emitter/dispatch spine and four read-only verbs (`state-path`, `detect`, `status`, `epics`), compiled to `dist/planctl-bun` via `bun build --compile`. Parity is proven by the conformance harness: a new engine-agnostic pytest module seeded via the CLI-free `seed_state` builder, green against BOTH the Python binary and the compiled bun binary. Python stays the authoritative implementation; this epic is purely additive.

## Quick commands

- `bun run build && PLANCTL_BIN="$PWD/dist/planctl-bun" uv run pytest tests/test_cli.py tests/test_readonly_verbs.py` — the scoped gate this epic must turn green
- `PLANCTL_BIN="$(command -v planctl)" uv run pytest tests/test_readonly_verbs.py` — same tests against Python (must also be green; proves the tests, not the port)
- `uv run pytest tests/` — Python fast gate, untouched

## Acceptance

- [ ] `tests/test_readonly_verbs.py` exists: seed_state-seeded, engine-agnostic conformance tests for state-path/detect/status/epics covering json + yaml + human formats, the planctl_invocation trailer line byte-for-byte, missing-project error envelopes, and a non-ASCII title fixture — green in default engine AND under `PLANCTL_BIN=<python planctl>`
- [ ] `dist/planctl-bun` is a compiled (`bun build --compile`), chmod+x artifact built by a package.json script with the Bun version pinned; the gate runs against the COMPILED binary, never `bun run`
- [ ] `PLANCTL_BIN=dist/planctl-bun uv run pytest tests/test_cli.py tests/test_readonly_verbs.py` green, serially and with `-n`
- [ ] `bun test`, biome lint (src/ included in biome.json allow-list), and tsc typecheck all green and wired as package.json scripts
- [ ] Python suite untouched: fast gate green, full Python conformance run green
- [ ] Docs landed: README Requirements/Install fold in Bun; CLAUDE.md + AGENTS.md Running Things tables gain the bun rows; one-line polyglot authority statement (Python authoritative, planctl-bun covers a read-only subset)

## Early proof point

Task that proves the approach: ordinal 2 (skeleton + emitters + state-path through the compiled binary against ordinal 1's tests). If compiled-binary quirks block (virtual-FS path issues, env minimalism), fallback: gate a `#!/usr/bin/env bun` chmod+x script shim temporarily while keeping compiled-artifact green as the task's exit criterion — scoped retreat, same acceptance.

## References

- Program: epic ② of ~6 (① fn-28 harness landed → ② this → ③–⑤ verb waves → ⑥ cutover); Python sources are the executable spec
- Wire spec: planctl/_util.py:147 json_dumps (indent 2, ensure_ascii=False, one trailing newline), :92 yaml_dump (block scalars, no flow style, sort_keys=False), :157 format_output (json default, TTY auto-upgrade to human, BrokenPipeError catch); planctl/output.py:22 emit / :154 emit_error (exit 1); planctl/cli.py:30+:132 trailer emission (compact separators, second line, soft-fail), :18 _NO_TRACK_COMMANDS={cat,validate}, :91 _extract_target; planctl/invocation.py:173 build_planctl_invocation_readonly (field order: files, op, target, subject, touched_path_files, repo_root, state_repo)
- Spine spec: planctl/project.py:17 find_git_root (parent walk, .git dir OR file, no GIT_DIR, cwd fallback) / :40 resolve_project; planctl/store.py:125 load_json_safe (silent on corrupt), :171 load_runtime (read-never-creates), :230 get_actor, :267 now_iso + PLANCTL_NOW strict contract; planctl/models.py:47 normalize_epic, :118 normalize_task, :155 merge_task_state (absent → status todo); planctl/ids.py:56 parse_id (unparseable sorts as 999)
- Verb spec: run_state_path.py, run_detect.py (schema_version default 0, no hard error), run_status.py (schema_version default 1 — asymmetry is intentional, do not unify), run_epics.py (_render_human at :8)
- Conformance mechanics: tests/conftest.py:546 _conformance_home, :580 _subprocess_env (minimal env — binary must run with NO other env), :103 executable fail-fast; fixture pattern to copy: tests/test_session_markers.py (seed_state + chdir + run_cli)
- Existing read-only assertions in tests/test_envelope_shape.py are CLI-seeded (fixture routes epic create to PLANCTL_BIN) — they do not transfer to the bun gate; the new module replaces that coverage for these verbs
- Full-suite conformance against the bun binary is a later-epic exit criterion; bun:ffi flock work is deferred (read-only verbs take no locks)

## Docs gaps

- **README.md**: fold Bun into Requirements and Install (no second parallel block)
- **CLAUDE.md / AGENTS.md**: add bun rows (build/lint/test/typecheck + the scoped bun conformance invocation) to both Running Things tables, kept in sync; add the one-line polyglot authority statement in Convention Divergences style
## Best practices

- **Gate the compiled artifact:** `bun build --compile` binaries diverge from `bun run` (virtual FS /$bunfs/root/, no __dirname, static imports only); pin the Bun version [Bun docs]
- **Timestamps:** JS Date is ms-native — pad toISOString to 6 fractional digits for wall clock; validate PLANCTL_NOW by shape and return it AS-IS, never round-trip through new Date() [MDN]
- **YAML parity:** js-yaml dump with noArrayIndent true + lineWidth -1 matches PyYAML dash-at-parent-indent; snapshot-test multiline block scalars [js-yaml #432]
- **Two JSON serializers, don't cross them:** primary payload = stringify(obj, null, 2) + explicit trailing newline; trailer = compact stringify (no spaces)
- **bun:test CLI testing:** use Bun.spawnSync, not async spawn with pipes [Bun #24690]
