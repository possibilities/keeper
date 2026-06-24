## Overview

Fold agentusage's usage-quota PRODUCER into keeper so the daemon both produces
AND consumes the per-account Claude/Codex usage data. Today an external Python
daemon (`~/code/agentusage/daemon.py`) scrapes each account's `/usage`|`/status`
panel and writes envelopes that keeper's `src/usage-worker.ts` already consumes.
This moves the ORCHESTRATION into keeper as a new TS worker
(`src/usage-scraper-worker.ts`) and VENDORS the TS picker, leaving agentusage as a
Python-only ONE-SHOT scrape util the worker shells out to per scrape. Sibling
follow-on to fn-929 (agentwrap → `keeper agent`). End state: keeper owns the
orchestration + the picker; agentusage holds only `pexpect`+`pyte`+parsers behind a
one-shot JSON CLI.

## Quick commands

- `<abs-uv> run --project ~/code/agentusage python -m agentusage.scrape_cli --target claude --profile default` — the one-shot util prints the discriminated JSON contract on stdout
- `bun run test:full` — MANDATORY (touches daemon + worker + db + a new shell-out path)
- `bun run test:hygiene` — the no-real-process scan stays green after the slow-tier scrape test lands
- `keeper usage` — the existing consumer CLI still renders the projection, now fed by the in-keeper producer

## Acceptance

- [ ] keeperd's `usage-scraper-worker` produces `~/.local/state/agentusage/<id>.json` envelopes byte-compatible with `isUsageFilename` + the existing consumer, the external Python daemon stopped
- [ ] The Python surface in `~/code/agentusage` is a stateless ONE-SHOT scrape util (no long-lived daemon); it prints a discriminated `{ok|error}` JSON contract and writes NO state
- [ ] The TS picker (`pickProfile`/`FileLock`) is vendored into a db-free keeper leaf; `file:../agentusage` (package.json:31) is gone; `keeper agent`'s launch path still imports it without pulling `src/db.ts`
- [ ] The worker un-spawns + warns (never `fatalExit`) when the `uv`/util runtime can't be resolved at boot; a transient scrape failure writes `stale` + `.error.json`, never crash-loops
- [ ] `KEEPER_AGENTUSAGE_ROOT` sandboxes the state dir + picker ledger so tests never touch the real `~/.local/state/agentusage/`; `bun run test:full` + `test:hygiene` green
- [ ] Soaked: envelopes keep flowing + the picker keeps balancing across accounts with the in-keeper producer; rollback to the external daemon documented

## Early proof point

Task that proves the approach: `.3` (the keeper→`uv`→python-util→JSON round-trip
under the real runtime + the test-isolation seam). It de-risks the three things
that could sink the design at once: `uv` resolving agentusage's project env under
keeperd's stripped LaunchAgent PATH, the Bun#24690 empty-stdout-inside-a-Worker
hazard, and the util⇄worker JSON contract round-tripping. If it fails: spawn the
scrape subprocess from MAIN (worker posts a request, main spawns + returns JSON),
and/or fall back to a pinned absolute venv (`~/.keeper/scraper-venv`) instead of
`uv run` — both isolate to this seam without disturbing the worker logic in `.4`.

## References

- Sibling precedent (done): fn-929 — merge agentwrap into keeper (vendored `src/agent/`, dropped a `file:` dep, `resolveKeeperAgentPath`/db-free leaf pattern).
- Producer to port: `~/code/agentusage/daemon.py` (account loop :497-818, envelope builder :433-465, idle/cooldown gates :551-655, restart-cheap :377-404, shutdown :824-887, `ENVELOPE_SCHEMA_VERSION=1` :45, `ENVELOPE_KEYS` :416-430), `~/code/agentusage/scrape.py` (`scrape()` :221, trust mutations :119-159), `~/code/agentusage/scrape_one.py` (debug one-shot — the reshape basis), parsers `parse_claude_usage.py` / `parse_codex_status.py`.
- Structural model: `src/builds-worker.ts` (the non-watcher poll-loop producer) — :472-580 skeleton, :529-579 setTimeout-after-completion + inFlight, :399-402 AbortController, :549-559 no-throw cycle.
- Consumer contract (UNTOUCHED): `src/usage-worker.ts:231` `isUsageFilename` `/^[a-z0-9-]+\.json$/` + carve-outs :217-227.
- Board was empty at plan time (0 open epics) — no inter-epic deps.

## Alternatives

- **Full TS rewrite of scrape+parse (no Python in keeper)** — rejected by the human: reimplementing `pexpect`+`pyte`+the panel regexes (~700 LOC, the part most likely to break) is the wrong thing to port; node-pty doesn't load under Bun and tmux `capture-pane` adds rendering-fidelity risk. Keep the proven scrape in Python.
- **Launch the scrape clients through `keeper agent`/dispatch** ("use the dispatch system") — deferred: routing through `keeper agent` mints a board `jobs` row + loads keeper's full plugin stack into every throwaway scrape, and there is no suppression today. The Python util's direct `pexpect` spawn (today's behavior) fires no hook and mints no job. Revisitable later.
- **Fold scrapes straight into keeper's `usage` projection (drop the envelope files)** — rejected: the picker runs in the db-free `keeper agent` launch process and reads the files; folding into the projection would force a daemon round-trip on every launch. The files stay the decoupling seam.
- **Pinned absolute venv instead of `uv run`** — kept as the `.3` fallback only; the chosen path reuses agentusage's existing `uv` project env via an absolute `uv` path (no per-call `--python` flag, which would recreate the venv every call per uv#11288).

## Architecture

Two processes, one `~/.local/state/agentusage/` tree. The keeper `usage-scraper-worker`
(producer) runs N concurrent per-account async loops sharing a global profile-gate +
per-target mutex; each loop, on its 60–180s jitter cadence, runs the idle/cooldown
gates, resolves the account's tier, then shells out — `<abs-uv> run --project
~/code/agentusage python -m agentusage.scrape_cli …` — to the stateless Python util,
which `pexpect`-spawns the real `claude`/`codex` TUI (direct, with `CLAUDE_CONFIG_DIR`
set — NO `keeper agent`, NO hook, NO job), `pyte`-renders the `/usage`|`/status` panel,
parses it, and prints one discriminated JSON object. The worker assembles the envelope
(`multiplier`, `next_fetch_at`, `last_*_fetch_at`, `lift_at` carry — all producer-side
wall-clock) and atomically writes `<id>.json` (+ `.error.json`, + `events.jsonl`). The
existing `usage-worker` (consumer) watches the same dir and folds envelopes into the
`usage` projection — UNCHANGED. The vendored picker reads the envelopes + `picker.json`
ledger from the db-free `keeper agent` launch path. The new worker is wired like
`builds-worker` (non-watcher, config-gated spawn), NOT like a `WATCHER_WORKERS` member.

## Rollout

1. Land the agentusage one-shot util (`.1`) + vendor the picker (`.2`) — both
additive, zero behavior change (the external daemon still produces). 2. Land the
runtime/proof seam (`.3`) and the worker (`.4`) with the worker's config gate
UNSET, so keeperd does not yet spawn it — still zero change. 3. Cutover (`.5`):
stop the external `agentusage` daemon, set the config key, restart keeperd, soak —
verify envelopes keep flowing + the picker keeps balancing. 4. Only after soak,
retire agentusage's orphaned TS (`.6`). Rollback at any step: unset the config key
(worker un-spawns) and restart the external Python daemon — the envelope contract is
unchanged, so the consumer + picker are agnostic to which producer is running.
