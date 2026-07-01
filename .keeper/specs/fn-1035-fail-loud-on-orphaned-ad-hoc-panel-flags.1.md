## Description

Addresses finding F1 (with F4's test folded in). In `runPanel`'s `start`
branch (`src/pair/panel.ts` ~924-956), `hasAdHoc` is keyed only on
`--preset`/`--cli`. When the human passes an ad-hoc-only flag
(`--model`/`--effort`/`--role`) WITHOUT a selector, `adHoc` stays undefined
and those flags are silently dropped onto the configured-panel path — e.g.
`keeper agent panel start p.md --panel default --model gpt-5` runs the
configured model with no error. Make the verb fail loud (exit 2) with a
message telling the human the flag requires `--preset`/`--cli`.

Evidence path: `src/pair/panel.ts:924-925` (hasAdHoc definition) and
`:933-956` (adHoc built only when hasAdHoc). Reproduce via the parsed values
for `model`/`effort`/`role` (lines 890-892) being non-undefined while
`hasAdHoc` is false.

## Acceptance

- [ ] `--model`/`--effort`/`--role` without `--preset`/`--cli` exits 2 with a
      message naming the required selector (applies to both `agent panel` and
      `pair panel` routes, which share `runPanel`).
- [ ] A valid ad-hoc launch (selector + overrides) and a valid configured
      launch (`--panel` alone) are unaffected and stay byte-stable.
- [ ] F4: a fast-tier test pins the orphaned-flag contract for each of
      `--model`, `--effort`, `--role`.

## Done summary
panel start now exits 2 naming the required --preset/--cli selector when --model/--effort/--role are passed without one, instead of silently dropping the override onto the configured-panel path; a fast-tier contract test pins each flag.
## Evidence
