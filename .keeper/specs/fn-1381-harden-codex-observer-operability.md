## Overview

The daemon-side codex-pool observer silently fails forever when no literal `pi`
executable is on the daemon PATH (the catalog scan in the observer throws, every
30s refresh cycle keeps the stale sidecar without a log line, and the 90s
freshness ceiling collapses an active-degraded activation to native-fallback —
which serves the exhausted account and kills every gpt work leg on quota). A
production outage of exactly this shape occurred within minutes of the pool
ship; the operational patch is a brittle `~/.local/bin/pi` symlink into the
current nvm version dir. This epic makes the observer resolve its catalog
without that PATH dependence, makes failed refresh cycles visible instead of
silent, and fixes the documented proof-window arming ritual so the ~2026-07-26
full-proof re-run uses a command that parses.

Out of scope (explicit follow-up once the poison-gate epic lands): minting a
daemon distress/needs-human row on sustained observer failure — this epic stops
at bounded logging plus an operator-readable health surface, keeping every
touched file disjoint from the open daemon-surface epics.

## Quick commands

- env -i HOME=$HOME PATH=/usr/bin:/bin KEEPER_JOB_ID=keeperd-codex-observer keeper-pi-codex-observe   # must emit a real envelope, not pool-unavailable
- keeper agent accounts check --json   # codex block carries observation freshness + failure visibility

## Acceptance

- [ ] The observer emits a real observation envelope under a minimal PATH with no `pi` executable anywhere on it
- [ ] A refresh cycle that fails leaves an operator-visible trace (bounded log + surfaced state), never a silent stale sidecar
- [ ] The documented proof-window arming command parses and arms as written in the install docs

## Early proof point

Task that proves the approach: ordinal 1 (catalog resolution). If it fails:
fall back to a keeper-config explicit pi-path key consumed by the observer,
which is strictly additive.

## References

- ~/docs/keeper-phase2-backlog.md items #80 and #81 (full evidence chain)
- ~/docs/keeper-review-remediation.md PHASE-17 takeover section
