## Description

Harden the shipped escalation-grant confinement surface for three
audit-kept gaps (all inert until the mint side is wired):

- **F1** — `plugins/keeper/plugin/hooks/grant-guard.ts`: `gitSubcommandInfo`
  (:382-410) skips `GIT_VALUED_GLOBAL_FLAGS` (`-C`, `--git-dir`,
  `--work-tree`), and for a write-capable role `classifyExecutable` returns
  allowed for every git subcommand except `config` (:615). `decideBash`
  (:895-909) binds only `payload.cwd` to `writableRoot`, so
  `git -C /foreign/repo commit` (or `--git-dir=…/--work-tree=…`) mutates a
  tree outside the granted checkout while the cwd check passes — contradicting
  the :892 comment. Fix: when a git segment carries `-C`/`--git-dir`/`--work-tree`
  for a write-capable role, resolve that target and require
  `writableRootCovers` on it, or deny those global flags for the confined roles.

- **F2** — `plugins/keeper/plugin/hooks/grant-guard.ts` (`readStdin` :947-952
  + `main` :965-985): `readStdin` truncates to 1 MB, `main` `JSON.parse`s the
  truncated text which throws to `payload=null`, and `decideGrantGuard(null)`
  returns allow (:923) — the `catch` never fires. A confined agent's >1 MB
  Write body or Bash command bypasses the guard. Fix: distinguish "input was
  truncated" from "well-formed small payload" — scan the untruncated head for
  a confined `agent_type` and fail CLOSED when one is present.

- **F4** — `src/grant-leaf.ts`: `writableRootCovers` (:142, docstring
  "both already canonical") and the parser (:248-249, `isAbsolute` only)
  never canonicalize `writable_root`. A daemon-minted root with a symlink
  component (e.g. a macOS `/tmp`/`/var` or a symlinked lane checkout) yields a
  `..`-prefixed `relative()` and denies a legitimate in-root write — fail-closed
  but a silent confinement-too-tight surprise. Fix: canonicalize
  `writable_root` in `writeGrantLeaf` (and/or state the writer's canonical-root
  contract at the reader).

Files: `plugins/keeper/plugin/hooks/grant-guard.ts`, `src/grant-leaf.ts`,
and the corresponding guard/leaf test suites.

## Acceptance

- [ ] F1: a write-capable role's `git -C <foreign>` / `--git-dir` / `--work-tree`
      mutation is denied (target resolved and root-checked, or the flags denied).
- [ ] F2: a >1 MB payload carrying a confined `agent_type` is denied, not allowed.
- [ ] F4: a non-canonical `writable_root` covers a legitimate in-root write
      (canonicalized at mint) rather than over-denying.
- [ ] Regression tests cover the `-C`/`--work-tree`/`--git-dir` escape, the
      >1 MB fail-open, and the symlink-component root.

## Done summary

## Evidence
