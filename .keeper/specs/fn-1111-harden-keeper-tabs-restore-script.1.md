## Description

Findings F2 + F6 (same root cause) with the test from F4. Evidence path:
`src/tabs-core.ts:354` (`lines.push(\`# ${candidate.label}\`)`) and `:332`
(`# session: ${sessionName} ...`), plus the summary stanzas around lines
219-223, interpolate `label`/`sessionName` raw while every argv token and
cwd route through `shellQuote` / `quoteArgv`. `label` derives from the job
title, which is agent-influenced (the handoff RPC's `optStr` accepts any
string with no newline filter). The rendered script is written to
`~/.local/state/keeper/revive.sh` (0600) on every restore-worker pulse and
printed by `keeper tabs dump`; both are meant to be executed by the human
after a crash. A title like `foo\n<command>` renders `# foo` followed by
`<command>` as a live script line. Strip/replace `\r`/`\n` in every
comment-line interpolation (`label`/`sessionName`) before pushing the `#`
line, e.g. `label.replace(/[\r\n]+/g, " ")`.

## Acceptance

- [ ] Every raw interpolation of `label`/`sessionName` into a `#` comment line in `renderSnapshotScript` (and the summary stanzas) strips `\r`/`\n`.
- [ ] A test feeds a newline-bearing label AND session name through the generator and asserts the injected text stays inside its `#` comment (no executable line escapes).

## Done summary
Neutralize CR/LF in every label/session interpolation into a # comment line of the generated revive script (renderSnapshotScript + renderOutcomes summary stanzas) via a new commentSafe helper, plus a test proving a newline-bearing label and session stay inside their # comment with no live line escaping.
## Evidence
