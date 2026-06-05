## Description

**Size:** S
**Files:** bootstrap.sh (+ wherever the stale refs actually live — investigate first)

### Approach

The old `jobctl` UDS server (`run_run_server.py`) is already gone, but stale
references to it (`/tmp/jobctl.sock`, the watchman bind comment, any
`jobctl-server` mention) linger in dotfiles. The gap-analyst's grep was
ambiguous about the exact location, so investigate first (`rg -n 'jobctl'
~/code/dotfiles`), then remove only the dead server-bootstrap refs. Do NOT
remove a `jobctl` reference that is a live command invocation (those are
handled by the shim in task 6) — only the dead-server plumbing. Independent
of the keeper port; can land any time.

### Investigation targets

**Required** (read before coding):
- ~/code/dotfiles — `rg -n 'jobctl' .` to locate the actual stale refs (bootstrap.sh per the scout, but confirm)

### Risks

- Distinguish dead-server plumbing (remove) from live `jobctl` command use (leave for the shim) — don't over-scrub.

### Test notes

`rg -n 'jobctl.sock|jobctl-server|jobctl server' ~/code/dotfiles` returns
nothing; dotfiles still lint/parse (shellcheck on bootstrap.sh).

## Acceptance

- [ ] Stale jobctl-server refs (sock/watchman/server) removed; live command refs left alone.
- [ ] bootstrap.sh shellcheck-clean.

## Done summary
Removed stale jobctl-server references from bootstrap.sh watchman comment; kept live shared-pidfile race rationale. shellcheck clean.
## Evidence
