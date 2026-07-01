## Overview

Make read-only posture honest: keep ONLY the prompt directive and rely on the model following
it; rip out the two "detection" layers that pretend to enforce it. Rationale: agents do not run
in isolated git worktrees (work is SCHEDULED to avoid overlap in a shared checkout), so the git
before/after changed-files backstop is meaningless; and the per-harness tool-strip is leaky
(bash `>`, `sed -i`, git all escape it). Two theatrical layers, zero real prevention.

REMOVE: (1) the per-harness tool-strip (`nativeClaudeArgs`/`nativePiArgs` read-only branches;
codex never had one) and (2) the entire git backstop (`gitSnapshot`/`diffGitSnapshots`/
`parseGitPorcelain`/`changed_files`/`read_only_violation`). KEEP: the `READ_ONLY_DIRECTIVE`
prepend and `--read-only` parsing on BOTH `agent run` and `pair send`. The run-capture 9-key
envelope is UNCHANGED — it never carried a read-only field, so no schema bump.

Also fold a small forward-facing doc note capturing the env-scrub finding (see References): the
partner env-scrub (`stripClaudeEnv`) is defense-in-depth, NOT the load-bearing gate — no new
scrubbing is added here.

## Quick commands

- `bun run test` — full suite green
- `bun run typecheck` — `tsc --noEmit` clean
- (out-of-band) `keeper agent run --read-only claude "list files"` — directive prepended, NO
  `--disallowed-tools` in the launched argv, NO changed-files audit

## Acceptance

- [ ] `--read-only` on `agent run` and `pair send` still prepends `READ_ONLY_DIRECTIVE`; NO
  tool-strip flags (`--disallowed-tools`/`--exclude-tools`) and NO git backstop anywhere.
- [ ] `read_only_violation`/`changed_files` and the `changed=` Monitor field are gone; the
  run-capture 9-key envelope is UNCHANGED (no schema bump).
- [ ] All read-only docs (dispatch help, cli headers, README, pair SKILL.md, panel.md) say
  "prompting-only", not "detection/tool-strip/backstop". `bun test` green.

## Early proof point

The core task rips the machinery and keeps the directive. If removing the now-vestigial
`readOnly` field from `PairLaunchOpts`/`LaunchPosture` causes wide test churn, take the MINIMAL
path first (drop the strip BRANCHES inside `nativeClaudeArgs`/`nativePiArgs`, leave the inert
fields) and delete the fields in a follow-up — the observable behavior is identical either way.

## References

- **Keep the directive, drop the theater.** The directive prepend (user-turn text) is the whole
  guarantee now — honest and best-effort. Frame it that way everywhere.
- **Envelope is safe.** The uniform 9-key run-capture envelope never carried `read_only`/
  `changed_files`; only pair's `--output` YAML + the `completed` Monitor line did. Removing the
  backstop drops those pair-side fields ONLY — the envelope contract and exit-code taxonomy
  (0/0/4/4/1/2) are untouched. Do NOT bump `RUN_CAPTURE_SCHEMA_VERSION`.
- **Env-scrub finding (document, do NOT harden).** `stripClaudeEnv` filters only the INPUT to
  `launchScriptEnv`'s 5-key allowlist, which already excludes `ANTHROPIC*`/`*_API_KEY`/`DYLD_*`;
  the partner pane's real env comes from that allowlist + the tmux-server env + the login-shell
  re-source. So `stripClaudeEnv` is defense-in-depth, not the gate. `DYLD_*`/`LD_*` are already
  hard-blocked on the `--x-tmux-env` injection channel. Record this as a forward-facing comment/
  note; add NO new scrubbing (stripping `ANTHROPIC*` from a claude partner would break its auth).
- This lands before the `agent panel`/pair-retirement work, which then inherits a
  strip-free/backstop-free pair surface.

## Docs gaps

- **`src/agent/dispatch.ts` (`USAGE` + `KEEPER_AGENT_HELP` run block)**: rewrite the `--read-only`
  lines from "prepends a directive and strips edit tools per harness — detection, NOT prevention"
  to a prompting-only description. Part of the deliverable.
- **`cli/agent.ts` header + `cli/pair.ts` module doc/HELP**: drop tool-strip/git-backstop wording.
- **README (~agent-run bullet)**: drop "strips edit tools per harness … unlike keeper pair's
  caller-side git backstop".
- **`plugins/keeper/skills/pair/SKILL.md`**: rewrite the "Read-only posture (detection, not
  prevention)" section to prompting-only; drop `read_only`/`changed_files`/`read_only_violation`
  from the output-fields list.
- **`plugins/plan/skills/panel/references/panel.md`**: drop "strips its edit tools" / "changed-
  files backstop" language.

## Best practices

- **Clean seam:** KEEP `ParseRunArgsResult.readOnly` + `assemblePrompt(readOnly)` + the two
  directive prepend sites; REMOVE the strip branches + all git-snapshot helpers + the
  `changed_files`/`read_only_violation` plumbing. Nothing in between.
- **Delete, don't comment out.** `diffGitSnapshots`/`parseGitPorcelain`/`gitSnapshot` have no
  remaining consumers — remove them and their tests outright.
- **Forward-facing docs only** — describe the present prompting-only behavior; no "used to strip"
  tombstones.
