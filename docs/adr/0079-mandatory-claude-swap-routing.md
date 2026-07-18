# 79. Mandatory claude-swap routing for Claude

## Status

Accepted. Supersedes ADRs 0058, 0064, and 0065 while preserving Claude and Pi as Keeper's complete Supported harness set and preserving the account-routing supersession chain to ADRs 0038, 0012, and 0009.

## Context

Keeper launches concurrent Claude processes across multiple accounts. The account decision is per process, not per conversation: a fresh launch, resume, or restore may choose a different account while shared history keeps the conversation available.

claude-swap already owns managed account credentials, ordered inventory, usage freshness, and account-specific execution. A separate ambient-account observer adds an installation, authorization, signing, polling, and failure surface without supplying managed rows. A native fallback also lets Claude start outside the account policy when routing evidence is absent.

The foreground Codex quota-reset command is independent of Claude account routing and is not required as a Keeper capability.

## Decision

Claude and Pi remain Keeper's complete Supported harness set. Pi Launch ids may contain OpenAI or Codex model and subscription names without becoming another harness.

Every Keeper-launched Claude process requires one fresh, routeable claude-swap account:

- the daemon invokes `cswap list --json` through a deadline-bounded, output-capped exact-argv runner and atomically publishes one private Capacity observation;
- only positive slots with `usageStatus: ok`, an explicit freshness signal, and remaining session and weekly quota are routeable; a Fable launch also requires remaining Fable quota;
- the active claude-swap slot remains an ordinary managed candidate rather than aliasing a native route;
- every fresh start, resume, and restore selects independently: a Fable launch orders candidates by greatest raw Fable quota remaining, while a non-Fable launch first prefers accounts with no Fable entitlement and otherwise the least Fable quota remaining; generic quota pressure, short-lived Launch reservations, and least-recently-used order break equal conservation scores but never override unequal Fable percentages; and
- every successful decision executes `cswap run <slot> --share-history -- <claude arguments...>` and records the PII-free `claude-swap:<slot>` Launch attribution.

There is no ambient or native Claude fallback. Missing, stale, malformed, unsupported, or empty inventory fails before Claude process creation. An explicit `--x-account cN` request likewise fails rather than substituting another account.

Capacity observations and reservation ledgers are transient versioned files. An incompatible version is ignored rather than migrated. Historical event and job rows may retain the old `default` attribution so re-fold remains deterministic, while the current hook accepts only managed route ids.

Keeper does not install, authorize, invoke, or otherwise integrate a second account-capacity CLI. Keeper exposes no quota-reset command or interactive reset machinery.

## Alternatives considered

- **Keep a native fallback.** Rejected because it bypasses the mandatory account policy precisely when routing evidence is weakest.
- **Treat the active account as native.** Rejected because the same-account `cswap run` path already provides one uniform execution contract without special identity semantics.
- **Retain a separate ambient observer.** Rejected because managed inventory and execution already belong to claude-swap, while a second provider adds no route Keeper can launch.
- **Replace the retired reset telemetry.** Rejected because preserving an unrelated quota-redemption command would add another external protocol solely to keep a nonessential feature.

## Consequences

- Claude cannot launch through Keeper until claude-swap is installed, at least one account is registered, and the observer has published fresh routeable capacity.
- All Claude process paths share one account inventory, route identity, and execution seam.
- Cross-account resume remains conversation-correct through shared history, without durable account affinity.
- Model-aware routing is a launch-time decision; an interactive model change does not move an already-running process to another account.
- Provider uncertainty is visible as bounded PII-free per-account launch diagnostics and blocks only Claude; Pi and non-Claude Keeper surfaces remain usable.
- Historical ADRs and event data retain their original terminology as rationale and replay evidence, not live behavior.
