# 38. External capacity observation and per-launch account routing

## Status

Accepted. Supersedes ADR 0009 and ADR 0012 (latched reserve profile balancer), and supersedes the usage-viewer-specific clauses of ADR 0012 (agent frame-stream wire contract).

## Context

Keeper owned the complete Claude-account balancing stack: a `usage_models` account registry, per-profile `CLAUDE_CONFIG_DIR` trees, shared-state link farms, tmux-driven TUI scraping, event-sourced usage projections, a usage viewer and frames route, and a latched-reserve picker. That ownership made human terminal output a machine contract and coupled account identity, quota observation, launch routing, resume behavior, and UI presentation.

CodexBar and claude-swap expose complementary public command-line contracts. CodexBar can report the ambient Claude account's structured usage. `cswap list --json` reports managed accounts, freshness-bearing usage windows, and actionable status under a versioned schema. `cswap run <slot> --share-history -- <claude arguments...>` launches one terminal-scoped account without globally switching other Claude processes and makes shared conversations resumable across accounts.

The integrations must remain optional. Missing or unusable CodexBar disables automatic balancing but must not block a native default-account launch. Missing claude-swap likewise leaves native default Claude behavior intact. Keeper may wrap both public CLIs, but neither external source tree becomes a Keeper-maintained fork or patch surface.

Account selection is orthogonal to conversation identity. A fresh start, a resume, and a crash restore each make a new selection; the account used by an earlier process is attribution, not affinity. Consequently, preserving Keeper's profile farms or recreating their full link topology inside claude-swap would retain the coupling this change exists to remove.

## Decision

Keeper wraps the installed public CLIs with exact argument arrays, bounded execution, validated output, and no shell:

- A valid CodexBar observation is the gate for automatic balancing and supplies ambient-account capacity.
- `cswap list --json` is authoritative for managed-account inventory, launchability, quota windows, and measurement freshness.
- `cswap run <slot> --share-history -- <claude arguments...>` is the account-specific execution seam. Keeper passes its complete Claude argv through the `--` boundary and never calls global `cswap switch` or `cswap auto` for a worker.

Keeper owns only four narrow concerns:

1. the latest validated Capacity observation;
2. continuous per-launch selection across currently routeable accounts;
3. short-lived Launch reservations that bias simultaneous selections without granting exclusive ownership; and
4. immutable Launch attribution for each process.

Every start, resume, and restore selects independently. Keeper stores no conversation-to-account affinity and never uses prior attribution as a routing input. Cross-account resume relies on claude-swap's public `--share-history` contract. Keeper does not read or mutate claude-swap's private session directories.

The selector excludes stale, unknown, signed-out, expired, or otherwise unrouteable candidates. For each candidate it evaluates every applicable normalized quota window, including a matching model-scoped window when present, and prefers the candidate with the greatest worst-window headroom after Launch reservations. Deterministic least-recently-used order breaks ties. There is no threshold ladder, reserve account, or hysteresis latch.

Keeper's existing usage UI, frame route, scraper, usage projections, usage-model registry, picker state machine, account-profile launch selection, and Claude/Pi profile-link farms retire. The new capacity path does not preserve a second quota renderer or a compatibility profile route.

The installer may seed canonical Claude settings from Keeper's stow source, but launch-time settings drift comparison, repair, and failure behavior retire. After installation, the live canonical settings file may evolve locally and claude-swap shares that live file into managed sessions. The separate global-instruction link guards remain.

Cutover is a clean break. Keeper does not import credentials into claude-swap and does not translate legacy profile identity into the new router. The operator registers desired accounts through claude-swap. Retired profile and scraper state moves byte-for-byte, without credential inspection or transformation, into the user-private `~/archive/keeper-agent-usage/` tree; the archive root and its contents remain mode-restricted because they may contain credentials. New routing state starts empty.

Fallback is evidence-sensitive:

- absent, stale, malformed, or unsupported CodexBar data means no automatic balancing and a native default launch;
- absent or empty claude-swap inventory leaves the native default route;
- a candidate that definitively fails before Claude starts may be replaced by another viable candidate or the native default;
- an ambiguous failure after invoking an account-specific launch never starts a second Claude process.

## Alternatives considered

- **Extend CodexBar's CLI to expose its app-only claude-swap projection.** Rejected: Keeper can consume the two existing public machine contracts directly, so an external fork or carried patch buys indirection without removing a dependency.
- **Use global `cswap switch` or `cswap auto`.** Rejected: global credential mutation changes unrelated terminals and editor sessions and cannot safely support concurrent Keeper workers on different accounts.
- **Bind a conversation to its first account.** Rejected: shared history makes account choice orthogonal to start/resume/restore, and durable affinity would reduce balancing freedom while adding slot-reuse and recovery failure modes.
- **Retain the latched reserve.** Rejected: normalized multi-window headroom and launch-local reservations provide continuous balancing without a hidden reserve state machine.
- **Preserve Keeper's profile farms as compatibility state.** Rejected: claude-swap owns account isolation, and a parallel Keeper profile topology would recreate split ownership and credential risk.

## Consequences

- Keeper remains fully functional with neither integration installed, using the ambient default Claude account without balancing.
- CodexBar is deliberately not the source of managed-account rows; it gates automation and observes the ambient route while claude-swap owns managed-account telemetry.
- Cross-account resume, argv forwarding, plugin/hook loading, terminal behavior, and same-account fast-path attribution require proof tests against the installed public CLIs before destructive cleanup.
- A Claude settings write can diverge from the repository's seed without blocking a later launch; subsequent managed sessions consume the live canonical value.
- Launch attribution replaces profile-name inference. It may explain which account route a process used, but it cannot make a later resume choose that account.
- Removing usage projections and historical profile machinery requires a forward-only schema retirement that still passes a fresh zero-to-head migration and deterministic re-fold tests.
- The archive is rollback evidence only, never a live launch source. No code path reads it after cutover.
- The general frame-stream contract remains accepted for surviving viewers; only its usage-viewer branch retires.
