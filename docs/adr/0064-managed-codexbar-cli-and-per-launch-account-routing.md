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

CodexBar runs as an unattended observer only after deliberate foreground authorization. `keeper agent accounts authorize-codexbar` runs the exact Claude and Codex provider calls serially, validates their output in memory, and writes a private, PII-free receipt containing the executable SHA-256, successful provider names, a non-repeating generation nonce, per-provider attempt revisions, and timestamps. Before each unattended spawn, the observer atomically consumes one provider's authority; only a parseable successful completion carrying that exact attempt revision grants it again. Concurrent observer calls, stale foreground completions, crashes, timeouts, malformed output, and receipt I/O failures therefore fail closed without forming a prompt loop or overwriting a newer decision. Capacity observations carry their executable digest; the worker and launch router reject a fresh-looking sidecar that no longer matches the current authorized generation. A changed executable or missing receipt skips CodexBar while claude-swap observation continues and selection fails open to the native default. Raw provider output, identity, and credentials are never persisted in the receipt.

The installer has one exception to external-source non-ownership: it manages the CodexBar CLI artifact from `https://github.com/possibilities/CodexBar.git` `main`, with `https://github.com/steipete/CodexBar.git` `main` as upstream. These mutable main tips are intentional trusted source authorities; the installer does not add SHA locks. Every install resolves the refs to immutable SHAs in disposable source state, attempts a noninteractive, config-sealed, hookless, unsigned `--rebase-merges` rebase, and never modifies or pushes a human checkout or remote. Unchanged resolved source identities are an idempotent no-op; changed identities update automatically. Upstream resolution or rebase failure builds the exact unrebased fork SHA; a rebased-build failure gets the same clean fallback. SwiftPM runs with prompt suppression and disposable HOME, config, and caches so dependency Git cannot inherit operator credentials or hooks while public fetches remain available.

The only build product is `CodexBarCLI`. Each immutable generation contains the executable and `PROVENANCE`, and one atomic `current` symlink swap publishes them together. The stable `~/.local/bin/codexbar` path traverses `current`, including for keeperd; an existing direct-layout artifact remains the migration fallback until generation publication succeeds. Before hashing or publication, Keeper signs the staged executable with a pinned, certificate-backed identity whose private key remains in the operator's login Keychain, then verifies the exact stable identifier and certificate-leaf designated requirement. This stabilizes the legacy trusted-application ACL, but macOS assigns non-Apple-signed code a separate `cdhash:` Keychain partition that changes with the CodeDirectory. Automatic publication therefore invalidates the prior authorization receipt by digest and notifies the operator to reauthorize; the observer fails open until that deliberate foreground action succeeds. Provenance records fork and upstream refs and SHAs, mode, built commit and tree SHAs, binary SHA-256, architecture, sanitized single-line Swift toolchain version, and the signing identity, identifier, and requirement. Signature, requirement, and binary digest are verified before accepting an unchanged input or publishing an update; a missing or unusable signing identity is a publication failure that preserves the previous generation.

A successful resolved-pair build is reused when both source SHAs are unchanged. An upstream-unavailable result is retried on the next install because no exact pair exists. Build, fetch, rebase, notification, and publication failures remain nonfatal and preserve the previous managed artifact. Startup removes incomplete `.staging.*` generation directories left by hard crashes; current and prior generations are retained through successful publication. No broad installer deadline or timeout policy is introduced. No `/Applications/CodexBar.app` is installed, and a Homebrew cask is removed only after publication succeeds.

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
- **Publish SwiftPM's ad-hoc-signed executable unchanged.** Rejected because its designated requirement is tied to a changing content hash, so Keychain trust granted to one generation does not survive the next build.
- **Use global claude-swap switching or bind conversations to accounts.** Rejected because either choice couples unrelated processes or turns attribution into durable affinity.
- **Restore Keeper's profile farms, usage projections, or reserve latch.** Rejected because claude-swap owns account isolation and normalized multi-window selection needs no parallel credential topology.

## Consequences

- Keeper remains functional without either integration and falls open to native Claude behavior.
- Keychain-backed polling requires a generation-bound foreground authorization; missing authority or a provider failure disables balancing rather than prompting again unattended.
- The managed CLI has reproducible source provenance, automatic source-identity updates, a certificate-backed trusted-application identity, and a stable daemon path without mutating a developer checkout.
- Rebase conflicts and upstream outages are visible notifications but do not sacrifice a buildable fork tip or an already installed CLI.
- Cross-account resume, argv forwarding, freshness handling, launch attribution, and same-account behavior remain proof obligations at the public CLI boundaries.
- The general frame-stream contract remains accepted; only the retired usage-viewer branch stays superseded.
