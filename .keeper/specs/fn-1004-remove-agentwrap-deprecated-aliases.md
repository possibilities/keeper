## Overview

The agentwrap launcher is fully vendored into the `keeper agent` subcommand. This epic removes the last transition scaffolding: the dead `resolveAgentwrapPath()` resolver and `DEFAULT_AGENTWRAP_PATH` constant, plus the deprecated `KEEPER_AGENTWRAP_PATH` env / `agentwrap_path` config alias arms wired as fallbacks into the three LIVE keeper-agent-path resolvers — and the stale README sentence and deprecated-alias tests. The live launch transport (`agentwrapLaunch`, `src/exec-backend.ts`, `src/agent/*`) is untouched. End state: a single `KEEPER_AGENT_PATH > keeper_agent_path > derived-default` precedence with no alias fallback, a regression guard for the now-ignored key, and a green suite.

The repo changes are one task (one commit). Two steps live OUTSIDE the repo and are run by hand after the epic lands (an await is armed for this): deleting the dead `exec_backend: agentwrap` line from `~/.config/keeper/config.yaml`, and `mv ~/code/agentwrap ~/archive/agentwrap`.

## Quick commands

- Verify no dead refs remain (after the task lands): `grep -rn 'resolveAgentwrapPath\|DEFAULT_AGENTWRAP_PATH\|KEEPER_AGENTWRAP_PATH\|agentwrap_path' src/ cli/` → empty.
- Smoke: `cd /Users/mike/code/keeper && bun run test` → full suite green.
- MANUAL post-land step 1 (run by hand, NOT the worker): remove the `exec_backend: agentwrap` line and its explanatory comment block from `~/.config/keeper/config.yaml`.
- MANUAL post-land step 2 (run by hand, NOT the worker): `mv ~/code/agentwrap ~/archive/agentwrap` (rollback survives via the `archived-folded-into-keeper` git tag + GitHub).

## Acceptance

- [ ] All deprecated agentwrap alias scaffolding removed from `src/` + tests; full suite green; committed via `keeper commit-work`.
- [ ] The live launcher transport + identity are untouched (`src/exec-backend.ts`, `src/agent/*`, `cli/agent.ts`, `AGENTWRAP_CLAUDE_PROFILE`, the `exec_backend` regression guards, `.keeper/` specs).
- [ ] The two external steps (config.yaml line + repo `mv`) completed by hand after the commit lands.

## Early proof point

The single code task proves the approach. If it fails — an unexpected live caller of a "dead" symbol, or a precedence regression in the kept `KEEPER_AGENT_PATH` tests — re-scope to keep the symbol and prune only the truly-unreferenced parts; the kept `KEEPER_AGENT_PATH` resolver tests are the guardrail.

## References

- Source brief: `~/docs/keeper-agentwrap-merge-cleanup-handoff.md`.
- Precedent to mirror: the `exec_backend` key retirement — silent-ignore + a `not.toHaveProperty` regression guard asserting clean boot.
- LIVE, DO NOT TOUCH: `src/exec-backend.ts` (the `agentwrapLaunch` transport + its cross-repo JSON-schema / exit-code contract) and `src/agent/main.ts:321` (the `AGENTWRAP_CLAUDE_PROFILE` env — unrelated to the path alias).

## Docs gaps

- **README.md (~line 442)**: delete the sentence "The `agentwrap_path` config key and `KEEPER_AGENTWRAP_PATH` env are still read as a deprecated alias." — it becomes false once the alias is removed. Part of the code task's deliverable; the surrounding paragraph (435-448) stays.

## Best practices

- **Remove by named symbol, never by string sweep:** "agentwrap" is a legitimate live identifier in ~52 files; only ~7 are in scope. Grep-and-delete would gut the live launcher.
- **Audit the fallback chain before cutting a link:** dropping a middle/last `??` arm can silently promote a different default — verify the surviving `KEEPER_AGENT_PATH > keeper_agent_path > derived-default` precedence with the kept tests.
