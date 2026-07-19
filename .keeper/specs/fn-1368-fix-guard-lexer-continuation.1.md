## Description

Close the command-substitution split bypass identified as F1. In BOTH
byte-identical guard lexers — `plugins/keeper/plugin/hooks/wrapped-guard.ts`
(inDouble block, ~line 185) and `plugins/keeper/plugin/hooks/grant-guard.ts`
(inDouble block, ~line 246) — the `else if (c === "\\" && next === "\n") i++;`
continuation-consume strips a backslash-newline without re-checking `$`/`(`
adjacency. Evidence: `"$\<newline>(evil)"` lexes with `$` and `(` landing in
separate iterations, so neither the inDouble `$(` deny nor the backtick deny
fires, and the PreToolUse gate admits a command a real shell expands as
`$(evil)`. Fix by re-joining `$` to a following `(` across a consumed
continuation (or pre-stripping `\<newline>` outside single-quoted regions so
`$` and `(` re-adjoin), applied IDENTICALLY to both copies to preserve the
isolation-driven duplicate-copy convention. Add the split vector to the CVE
deny corpus in BOTH `test/wrapped-guard.test.ts` and `test/grant-guard.test.ts`.

Files: plugins/keeper/plugin/hooks/wrapped-guard.ts, plugins/keeper/plugin/hooks/grant-guard.ts, test/wrapped-guard.test.ts, test/grant-guard.test.ts

## Acceptance

- [ ] `"$\<newline>(evil)"` and equivalent split forms are denied SUBSTITUTION by both guards
- [ ] Both guard copies carry the identical fix
- [ ] CVE deny corpus in both test files asserts the split vector is denied
- [ ] Legitimate `\<newline>` continuations inside and outside double quotes still lex without a false deny

## Done summary
Fixed the inDouble backslash-newline continuation-consume in both guard lexers to re-check $/( adjacency across consumed continuations (skipLineContinuations helper, identical in both files); added single- and multi-continuation split-vector denials to both CVE deny corpora; existing legitimate-continuation tests still pass.
## Evidence
