## Overview

The keeper CLI ships roughly eight incompatible JSON output shapes, carries a structured
recovery field on exactly one failure path, and lacks the projected reads agents actually need —
so skills teach jq pipelines and agents hand-roll sqlite and read raw transcripts into token-cap
walls. End state: one envelope family for keeper-native one-shot commands with a
{code, message, recovery} error object on every failure, new projected reads that retire the
documented jq lore, and a machine-readable help layer. Settled scope decisions: plan's emit()
family stays exempt (Python parity + one-JSON-root are frozen) and converges only on the error
sub-object; schema_version stays per-verb versioning the data payload — the envelope key set is
governed by an additive-only contract, no second global version int.

## Quick commands

- `keeper show-job --session <bad> ; echo $?` — failure emits the envelope with error.code + error.recovery
- `keeper query tasks --json | jq '.data[0]'` — flat task rows exist
- `keeper autopilot show --json | jq '.data.worktree_multi_repo'` — config read round-trips every durable knob
- `keeper --help --json | jq '.subcommands | length'` — command index

## Acceptance

- [ ] Every keeper-native one-shot read/mutate emits {schema_version, ok, error, data}; every ok:false carries error.{code,message,recovery}
- [ ] `keeper query` failure puts the envelope on stdout (never empty stdout + stderr prose)
- [ ] query tasks, autopilot show, and session-summary exist and retire their documented jq/sqlite workarounds
- [ ] keeper --help --json emits the command index; --agent-help exists on dispatch, handoff, commit-work, autopilot
- [ ] Named exemptions unchanged: plan emit() family, plan validate, plan cat, show-session-files snake_case, watch streaming shape

## Early proof point

Task that proves the approach: `.1` (the shared envelope helper + one migrated reader). If the
helper cannot honor per-verb schema_version cleanly, fall back to converging error objects only
and defer full envelope unification.

## References

- cli/status.ts:306-353 — the reference envelope (ok:false on stdout, exit 0 model)
- plugins/plan/src/emit.ts:44-50,195-205 — the frozen plan family + its error object
- cli/control-rpc.ts:212-233 — raw value prints to migrate
- cli/show-job.ts:64-66,463 — bare-reader success/failure shape flip
- cli/commit-work.ts:600 — the recovery contract to generalize
- RFC 9457 problem-details informs the error object: code stable, message corrective not diagnostic, recovery actionable; no stack traces or filesystem paths in agent-facing errors

## Alternatives

- Absorbing plan's emit() into the unified envelope — rejected: breaks Python byte-parity, the one-JSON-root guard, and every orchestration parse for aesthetic unity.
- A single global envelope version int — rejected: either noisy (every payload change bumps it) or inert; additive-only key-set contract + per-verb payload versions carry both axes.

## Rollout

Additive first: helper + new reads land before any old shape changes. The bare readers' error
shape flips string→object on rarely-exercised failure paths — land with the old `error` string
preserved as `error.message` and audit in-repo consumers (skills, api.py, statusline) in the same
change. Docs that quote shapes (plan README Output Contract, await failed-reason table, dispatch
exit taxonomy) update in the same commits as the shape they describe.

## Docs gaps

- **plugins/plan/README.md**: Output Contract section — document the exemption boundary and the converged error object
- **README.md**: Example clients list gains query tasks / autopilot show / session-summary / --help --json
- **plugins/plan/CLAUDE.md**: Convention Divergences — state how validate's {valid} relates to ok
- **CLAUDE.md**: the query-epics jq pipeline line retires in favor of `keeper query tasks`

## Best practices

- **Additive-only envelope contract:** unknown fields ignored by consumers, documented as the contract; never repurpose a field name
- **Deprecation window:** old key + deprecated pointer for one version window; never silently drop a parsed field
- **Registry doc:** a typed problem-code registry (meaning, recovery, retry-safety) agents can load on demand
