## Overview

Two PreToolUse guards have exec/write-flag escapes. `escalation-guard` — a security boundary keying a diagnosis-only role's Bash allowlist that must survive `--dangerously-skip-permissions` — lets a marked diagnosis session reach arbitrary command execution via `rg --pre`, an arbitrary file write via `find -fls`, and an unconstrained worker launch via `keeper dispatch --prompt`, because those allowlisted tools' dangerous flags are not inspected. `branch-guard` — a fail-open subagent workflow guard — lets a space-form git global flag (`git --git-dir <path> checkout -b …`) slip past the branch-create/switch/worktree-add deny. This extends each guard's EXISTING per-tool flag-inspection discipline (the `find -exec` / `git grep -O` / `xargs -I` blocks) to the leaked vectors. Pure hardening, no behavior widening. Depends on fn-1281, which reconciles the same escalation-guard command classifier's `bun` handling — so this epic drops the `bun` vector (owned there) and cuts from fn-1281's landed classifier to avoid a semantic collision.

## Quick commands

- `bun test test/escalation-guard.test.ts test/branch-guard.test.ts`   # both guards' truth tables, fast in-process tier

## Acceptance

- [ ] A diagnosis-role escalation session can no longer reach exec or file-write via `rg --pre`/`--pre-glob`/`--hostname-bin`, `find -fls`, or `keeper dispatch --prompt`/`--prompt-file`.
- [ ] A subagent can no longer bypass the branch-create/switch/worktree-add deny via a space-form git global flag (`--git-dir <path>` and siblings).
- [ ] No legitimate read command or plan-form dispatch (`keeper dispatch work::…`) is newly denied, and each guard keeps its exit-0 + fail-closed-for-marked / fail-open posture.

## Early proof point

Task that proves the approach: `.1` (the escalation-guard security vectors). If it fails: the `rg` arm must precede the `READ_UTILITIES` catch-all and the `dispatch` check must sit inside the `keeper` branch — re-check `classifyExecutable`'s dispatch order.

## References

- Extends the existing flag-inspection idiom: `FIND_EXEC_PRIMARIES`, `gitReadSubcommandExecFlag`/`isOpenFilesInPagerAbbrev` (the mirror-minus-abbreviation for `rg`, since rg is clap-based and does not prefix-abbreviate), the `xargs` any-flag block, and `GIT_VALUED_GLOBAL_FLAGS` (the valued-global list branch-guard must mirror).
- `docs/adr/0017-trunk-repair-escalation-and-role-keyed-guard.md` is the sanctioned home if a threat-model note is wanted (optional 2-3 line Consequences amendment — not required; the tests are the enforcement).
- Depends on / overlaps `fn-1281-radical-deterministic-test-gate` — it rewrites the escalation-guard `bun` classifier this epic builds atop; the `bun run/test` vector is owned there, not here.

## Best practices

- **Deny-by-default on flags is the robust ideal, but per-tool blocklist is right for rg here:** ripgrep is clap-based (no GNU long-option abbreviation), so a small enumerated blocklist mirroring the `git grep -O` arm is consistent and does not over-block the ~100 legitimate rg flags a diagnosis session needs — leave a code comment naming the future-exec-flag residual it inherits (same as the git-grep arm). [OWASP command-injection defense; CWE-88 argument injection]
- **Consume the value token, not a whitespace-run:** a space-form valued global's `<path>` can contain spaces (`--git-dir "/my dir/.git"`), so a naive `\S+` misparses and the branch-create slips through the fail-open guard — consume the value as one token.
