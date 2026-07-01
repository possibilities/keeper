## Overview

The `keeper agent panel start` (and `pair panel start`) verb parses the ad-hoc
member flags `--model`, `--effort`, and `--role`, but only applies them when a
member selector (`--preset`/`--cli`) is also present. Passed without a selector
— e.g. `panel start p.md --panel default --model gpt-5` — they are silently
dropped onto the configured-panel path, which ignores them. This is a silent
no-op footgun: the human believes an override applied when it did not. Make the
verb fail loud instead.

## Acceptance

- [ ] Passing any ad-hoc-only flag (`--model`/`--effort`/`--role`) without a
      member selector (`--preset`/`--cli`) fails loud (exit 2) with a message
      naming the missing selector, instead of silently dropping the flag.
- [ ] The configured-panel path and the ad-hoc path remain byte-stable for
      their valid argv shapes (no regression to the parity locks).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | panel.ts:924-925 keys hasAdHoc on preset/cli only; --model/--effort/--role parsed then silently dropped onto the configured path (933-956). |
| F2 | culled | — | main.ts:1908-1909 threads --effort onto claude (not silently ignored); config.ts:257 declares effort claude/codex-only by design — panel/direct divergence is deliberate pair-send parity. |
| F3 | culled | — | panel.ts:379-381/954 ad-hoc readOnly:false is a deliberate documented pair-send parity default; auditor concludes intended. |
| F4 | merged-into-F1 | .1 | F4 (test for the silent-drop path) folds into F1's fail-loud task — same root cause; the contract test ships with F1's fix. |
| F5 | culled | — | F5 is tied to culled F2; direct-path claude --effort is intended, no surprising contract to pin. |

## Out of scope

- The panel-vs-direct `--effort` rule divergence (codex-only vs claude/codex) — a deliberate, documented pair-send parity choice (F2).
- The ad-hoc leg mutating-by-default posture — intended pair-send parity, documented at the `--read-only` help line (F3).
