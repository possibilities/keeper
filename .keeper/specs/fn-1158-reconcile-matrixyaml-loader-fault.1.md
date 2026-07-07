## Description

Fixes F1 (`plugins/plan/src/subagents_config.ts:221-236`, `loadHostMatrix`):
the `try` block wraps both `statSync(path).isFile()` and `readFileSync(path)`,
so the `catch` returns `null` for a present-but-unreadable file, silently
falling back to claude-only defaults. This contradicts the function's own
contract at line 219 ("matrix.yaml is fail-loud, never a silent half-built
default") and diverges from the launcher island (`src/agent/matrix.ts:110-116`,
`loadMatrix`) where `readFileSync` is unguarded and throws.

Narrow the plan island's catch to the `statSync` / not-a-file case (absent →
null) and let a genuine read failure on a present file propagate as a
fail-loud `SubagentsConfigError`, matching the launcher island and the
stated contract.

Also folds in F2 and F3 (same reconciliation commit): the two parsers
(`src/agent/matrix.ts` and the `subagents_config.ts` host-matrix section)
have now drifted once on this exact path, so add a cross-island parity test
that feeds one fixture roster to both `loadMatrix` and `loadHostMatrix` /
`parseHostMatrix` and asserts the same accept/reject verdict, plus a test
exercising the present-but-unreadable path in both islands.

Files:
- `plugins/plan/src/subagents_config.ts` (`loadHostMatrix`)
- the plan test suite (new parity + unreadable-path coverage; sandbox the config dir)

## Acceptance

- [ ] A present-but-unreadable `matrix.yaml` throws a typed fail-loud error in the plan island; absent / not-a-file still returns null.
- [ ] Cross-island parity test asserts both parsers agree on one fixture roster's accept/reject verdict.
- [ ] Present-but-unreadable path is covered in both islands.

## Done summary

## Evidence
