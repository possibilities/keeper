## Overview

Dissolve the `keeper plan` exec-shim: `cli/plan.ts` calls the plan verb dispatcher IN-PROCESS instead of `exec`-ing `~/.local/bin/planctl`. Extractability is being abandoned (planctl is retired), so the process boundary that justified the shim is gone. The standalone `planctl` binary KEEPS being built for now (both `planctl` and `keeper plan` work) — it is removed only in the final epic, so nothing in-flight breaks. The ~11ms interpreted-vs-compiled delta is noise inside LLM-bound worker calls.

## Quick commands

- `keeper plan status` — runs in-process; output identical to `planctl status`
- `bun run test:full` — the plan-shim conformance test (now in-process) stays green

## Acceptance

- [ ] `keeper plan <verb>` runs the plan dispatcher in-process (no `Bun.which`, no `exec` of an external binary)
- [ ] `keeper plan <verb>` stays byte-compatible with `planctl <verb>` (conformance test green, incl. the `plan_invocation`/`planctl_invocation` trailer + stdin + exit code)
- [ ] plan's deps (js-yaml, yaml) resolve from keeper's package graph
- [ ] the `planctl` binary still builds/promotes (untouched) — removed only in the final epic
- [ ] `bun run test:full` green

## Early proof point

Single task `.1`. If it fails: the in-process import has a side-effect (e.g. plan's `cli.ts` runs on import) — guard the entrypoint so importing the dispatcher is inert, mirroring keeper's `import.meta.main` pattern.

## References

- Current shim: `cli/plan.ts` (resolves `Bun.which("planctl")`, execs via `Bun.spawnSync`).
- Plan dispatcher to import: `plugins/plan/src/cli.ts`.

## Rollout

Autopilotable, fully reversible (revert to the shim). No daemon restart needed — `cli/plan.ts` is interpreted live-from-source. Keep the `planctl` binary alive.
