## Overview

Make `--x-profile` the launch-local Account selector for the one-based `claude-N` and `codex-N` labels already shown by Harness statuslines. Claude keeps exact current-inventory routing, while Pi receives an exact eligible initial Codex seed without losing its full activation policy, bounded pre-output failover, or proven runtime-route distinction.

The interface remains invocation-scoped: it creates no profile farm, persisted default, Account focus, stable route identity, or conversation affinity. Existing zero-based Claude `--x-account` behavior remains compatible, but the two selector families cannot be combined.

## Quick commands

- `bun test ./test/agent-args.test.ts ./test/agent-account-routing.test.ts ./test/agent-pi.test.ts ./test/agent-profile-bootstrap.test.ts ./test/agent-dispatch.test.ts ./test/agent-tmux-launch.test.ts`
- `bun run test:pi-codex-pool`

## Acceptance

- [ ] `--x-profile claude-N` selects current Claude inventory position `N` through the exact explicit-route path, and `--x-profile codex-N` selects configured Pi Codex position `N` as an eligible model-scoped launch seed.
- [ ] Missing, malformed, non-canonical, wrong-Harness, mixed-selector, out-of-range, and ineligible explicit requests fail with bounded PII-free diagnostics before a Claude or Pi Harness child starts.
- [ ] Repeated `--x-profile` uses its final occurrence, while every existing Claude-only `--x-account cN|N` compatibility behavior remains intact.
- [ ] Pi receives the complete activated alias policy alongside the requested seed, preserving current child independence, retry limits, pre-Substantive-output failover, generic native fallback, Spark fail-closed behavior, and proven runtime-route reporting.
- [ ] Wrapper help and operator documentation use the statusline label vocabulary while distinguishing positional selectors from stable route identity, affinity, and profile storage.
- [ ] No launch path creates or selects `CLAUDE_CONFIG_DIR` or `PI_CODING_AGENT_DIR` profile farms from `--x-profile`.

## Early proof point

Task that proves the approach: task 1. If it fails, retain the inert compatibility behavior while narrowing the parser-to-router handoff so no partial selector contract ships.

## References

- `CONTEXT.md` — Account display label and Account selector vocabulary.
- `docs/adr/0109-statusline-named-launch-account-selection.md` — accepted cross-Harness selector contract.
- `docs/adr/0090-keeper-managed-pi-codex-account-pool.md` — Pi provider-boundary retry and credential invariants.
- `docs/adr/0103-agent-runtime-diagnostics-and-threshold-awaits.md` — launch seed versus proven runtime route.
- `docs/adr/0105-capability-scoped-codex-routing.md` — model-scoped capability and Spark fallback boundary.

## Docs gaps

- **`README.md`**: consolidate the account-routing summary around statusline-named `--x-profile`, retained `--x-account`, and Pi seed-versus-runtime behavior.
- **`docs/install.md`**: update selector grammar, one-based examples, Harness validation, current-order semantics, and exact Claude versus failover-capable Pi behavior without duplicating the existing routing model.

## Best practices

- **Strict tagged selector:** validate the complete lowercase Harness-qualified label before numeric conversion; never clamp, partially parse, or silently substitute. [CLI Guidelines](https://clig.dev/)
- **Identity-safe execution:** fail explicit ambiguity before the Harness child starts and keep diagnostics free of credentials, account PII, and shell interpolation. [OWASP command injection defense](https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html)
- **Retry boundary preservation:** an explicit Pi seed may fail over only through the existing bounded pre-output policy; visible output closes replay. [Azure Retry Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/retry)

## Operator post-land

- Required after this epic lands: run `keeper daemon restart` from the Keeper repo root. Report a refresh failure separately from the landed commit.
