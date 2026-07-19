## Overview

The wrapped/grant guard lexers consume a `\<newline>` continuation inside
double quotes but never re-check `$`/`(` adjacency afterward, so
`"$\<newline>(evil)"` slips past the command-substitution deny while a real
POSIX shell strips the continuation first and expands `$(evil)`. This is a
reachable evasion of a defense-in-depth security gate on wrapped/escalation
agent commands, present identically in both byte-identical guard copies and
untested. Close the split vector and lock it under the CVE deny corpus.

## Acceptance

- [ ] A `\<newline>`-split command substitution inside double quotes is denied by both guards
- [ ] The split vector is asserted denied in both guards' CVE deny corpora
- [ ] Legitimate `\<newline>` continuations still lex without a false deny

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Traced at c83817941: inDouble continuation-consume skips `\<newline>` without re-checking `$`/`(` adjacency, so `"$\<newline>(evil)"` evades the SUBSTITUTION deny in both guard copies while a real shell expands `$(evil)`. |

## Out of scope

- The false-deny fix for legitimate continuations already shipped in the source epic
- The backtick vector (a single backtick denies on sight and cannot be split)
