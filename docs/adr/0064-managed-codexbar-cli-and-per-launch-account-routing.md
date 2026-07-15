# 64. Managed CodexBar CLI and per-launch account routing

## Status

Accepted. Supersedes ADR 0038 while preserving its account-routing decisions and its supersession chain to ADRs 0009 and 0012. ADR 0038 remains the historical record for the retired Keeper-owned profile balancer and usage viewer.

## Context

CodexBar and claude-swap expose complementary command-line contracts. CodexBar reports structured usage for the ambient Claude account. `cswap list --json` reports managed accounts, freshness-bearing usage windows, and actionable status; `cswap run <slot> --share-history -- <claude arguments...>` launches one terminal-scoped account without globally switching unrelated processes.

Both integrations are optional. Missing or unusable capacity data must not block a native default-account launch. Account choice is also orthogonal to conversation identity: every fresh start, resume, and restore needs an independent route, while the route used by an earlier process remains attribution rather than affinity.

Keeper previously treated CodexBar as an entirely external public-CLI dependency. The required ambient observation now depends on fixes carried by the `possibilities/CodexBar` fork, while release archives and a human development checkout are unsuitable installation authorities. Keeper needs a narrow, reproducible CLI installation exception without taking ownership of a mutable checkout, an app bundle, or either Git remote.

## Decision

Keeper wraps external commands with exact argument arrays, bounded execution, validated output, and no shell:

- a valid CodexBar observation gates automatic balancing and supplies ambient-account capacity;
- `cswap list --json` is authoritative for managed-account inventory, launchability, quota windows, and measurement freshness; and
- `cswap run <slot> --share-history -- <claude arguments...>` is the account-specific execution seam. Keeper forwards complete Claude argv through `--` and never calls global `cswap switch` or `cswap auto`.

Keeper owns only the latest validated Capacity observation, continuous per-launch selection, short-lived non-exclusive Launch reservations, and immutable Launch attribution. Every start, resume, and restore selects independently. Keeper stores no conversation-to-account affinity, never routes from prior attribution, and does not read or mutate claude-swap private session directories.

The selector excludes stale, unknown, signed-out, expired, or otherwise unrouteable candidates. It evaluates every applicable normalized quota window, including a matching model-scoped window, and chooses the greatest worst-window headroom after Launch reservations. Deterministic least-recently-used order breaks ties; there is no threshold ladder, reserve account, or hysteresis latch.

CodexBar runs as an unattended, headless observer. Keeper forces `CODEXBAR_DISABLE_KEYCHAIN_ACCESS=1` both in keeperd's launch environment and at the provider-subprocess boundary; parent configuration cannot weaken that invariant. The observer never requests a macOS password or reads CodexBar's Keychain cache. If ambient capacity cannot be obtained without Keychain, the CodexBar gate is unavailable and selection fails open to the native default.

The installer has one exception to external-source non-ownership: it manages the CodexBar CLI artifact from `https://github.com/possibilities/CodexBar.git` `main`, with `https://github.com/steipete/CodexBar.git` `main` as upstream. These mutable main tips are intentional trusted automatic source authorities; the installer does not add SHA locks. It resolves each run's refs to immutable SHAs in disposable source state, attempts a noninteractive, config-sealed, hookless, unsigned `--rebase-merges` rebase, and never modifies or pushes a human checkout or remote. Upstream resolution or rebase failure builds the exact unrebased fork SHA; a rebased-build failure gets the same clean fallback. SwiftPM runs with prompt suppression and disposable HOME, config, and caches so dependency Git cannot inherit operator credentials or hooks while public fetches remain available.

The only build product is `CodexBarCLI`. Each immutable generation contains the executable and `PROVENANCE`, and one atomic `current` symlink swap publishes them together. The stable `~/.local/bin/codexbar` path traverses `current`, including for keeperd; an existing direct-layout artifact remains the migration fallback until generation publication succeeds. Provenance records fork and upstream refs and SHAs, mode, built commit and tree SHAs, binary SHA-256, architecture, and a sanitized single-line Swift toolchain version. The binary digest is verified before an unchanged-input skip.

Every successful unrebased fallback for a resolved fork/upstream SHA pair, including fallback after a rebased-build failure, is latched for that exact pair until either main tip changes. An upstream-unavailable result is retried because no exact pair exists. Build, fetch, rebase, notification, and publication failures remain nonfatal and preserve the previous managed artifact. Startup removes incomplete `.staging.*` generation directories left by hard crashes; current and prior generations are retained through successful publication. No broad installer deadline or timeout policy is introduced. No `/Applications/CodexBar.app` is installed, and a Homebrew cask is removed only after publication succeeds.

The installer exception owns artifact production, not fork development: Keeper carries no working source tree, credentials, branch rewrite, or force-push path. CodexBar remains the ambient observer, never the source of managed-account rows.

The live canonical Claude settings file may evolve after its one-time install seed, and claude-swap shares that value into managed sessions; the separate global-instruction link guards remain. Keeper has no compatibility profile route, second quota renderer, usage projection, usage-model registry, or reserve picker. It neither imports credentials nor translates legacy profile identity; the operator registers accounts through claude-swap and routing state starts empty. Retired profile and scraper state remains private rollback evidence under `~/archive/keeper-agent-usage/`; Keeper never reads it as launch state.

Fallback remains evidence-sensitive:

- absent, stale, malformed, or unsupported CodexBar data disables automatic balancing and uses the native default;
- absent or empty claude-swap inventory uses the native default;
- a candidate that definitively fails before Claude starts may be replaced by another viable candidate or the native default; and
- an ambiguous failure after invoking an account-specific launch never starts a second Claude process.

## Alternatives considered

- **Install an upstream release archive.** Rejected because it does not carry the fork behavior required by the ambient observation contract.
- **Rebase or build a human checkout.** Rejected because installation must not rewrite, clean, or depend on development state.
- **Install the CodexBar app bundle.** Rejected because account routing consumes only the public CLI and must not own a GUI application.
- **Use global claude-swap switching or bind conversations to accounts.** Rejected because either choice couples unrelated processes or turns attribution into durable affinity.
- **Restore Keeper's profile farms, usage projections, or reserve latch.** Rejected because claude-swap owns account isolation and normalized multi-window selection needs no parallel credential topology.

## Consequences

- Keeper remains functional without either integration and falls open to native Claude behavior.
- Headless polling cannot use Keychain-backed ambient credentials; losing that gate disables balancing rather than prompting.
- The managed CLI has reproducible source provenance and a stable daemon path without mutating a developer checkout.
- Rebase conflicts and upstream outages are visible notifications but do not sacrifice a buildable fork tip or an already installed CLI.
- Cross-account resume, argv forwarding, freshness handling, launch attribution, and same-account behavior remain proof obligations at the public CLI boundaries.
- The general frame-stream contract remains accepted; only the retired usage-viewer branch stays superseded.
