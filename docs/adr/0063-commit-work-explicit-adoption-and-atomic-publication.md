# 63. Commit-work explicit adoption and atomic byte-bound publication

## Status

Accepted. Extends the repository-state gates without weakening them, and amends
[ADR 0050](0050-wrapped-delegation-guard.md) so wrapped workers close through
Keeper rather than raw Git.

## Context

Session attribution explains many direct Claude edits, but it is neither a
complete write journal nor commit authority. Shell commands, generators, package
managers, delayed folds, deleted paths, and provider legs can leave legitimate
dirt without an exclusive current-session claim. Treating every dirty path as
owned made unrelated shared-checkout work commit-able; waiting a fixed interval
for the fold did not establish ordering. Falling back to `git add` plus raw
`git commit` was worse: the ambient index could contain old or foreign entries,
and native commit execution did not bind the published tree to the set the
caller had reviewed.

Commit hooks and signing are executable boundaries. A hook or signer can change
worktree bytes, branch context, either index (including flags/extensions that
`ls-files --stage` does not expose), or ownership while a commit is being built.
A safe implementation therefore needs an immutable selected identity, explicit
hook execution, and an atomic ref publication step rather than a best-effort
pathspec commit.

Wrapped workers sharpen the problem. Their provider leg legitimately writes the
tree under a different Harness session, while the Claude wrapper owns testing
and close-out but is mechanically forbidden to edit. A raw-Git escape hatch
would turn that expected attribution gap into an unreviewed mixed commit.

## Decision

### Ownership and adoption

Every invocation requires one valid invocation identity. Automatic selection is
limited to active exclusive tool, plan, or synchronous direct claims belonging
to that identity. Missing or ambiguous evidence fails automatic selection
closed. Bash, inferred, package-manager, and code-generation evidence is an
**observation** only: preview reports it as adoptable context, never as exclusive
ownership.

A caller resolves an attribution gap with repeatable `--adopt <exact-path>` or a
bounded regular-file manifest:

```json
{"schema_version":1,"kind":"commit-work-adoption","paths":["path/to/file"]}
```

Adoption is local to that invocation and creates no durable claim. Every named
path is canonicalized, checked against the complete live dirty surface,
Git-ignore/exclusion rules, and rename pairing. A live or unknown foreign
exclusive claim blocks it with no force override; only positively terminal
foreign claims are adoptable. A bounded `--message-file` gives wrappers the same
non-shell-interpolated input path for attacker-influenced provider text.

### Frozen commit identity

Under the per-worktree close-on-exec flock, Keeper captures the branch ref and
parent, creates an isolated index from the parent tree, and populates only the
selected Git-normalized entries. The frozen identity is the sorted path, kind,
blob OID, and mode set plus its resulting tree. Deletions and both halves of a
rename participate explicitly. Ambient staged entries outside the selected set
remain a refusal unless the existing narrow unstage override restores exactly
those entries.

Lint runs against non-deleted selected paths. Before and after lint, before
commit creation, and after signing, Keeper re-reads ownership and verifies the
selected worktree identities. A changed claim, path, OID, mode, tree, branch, or
operation aborts the invocation rather than silently refreshing the selection.

### Hooks, signing, and publication

Keeper runs `pre-commit`, `prepare-commit-msg`, and `commit-msg` explicitly
against the private index and target worktree configuration. It preserves
Keeper-owned trailers and rejects a hook that mutates the frozen worktree,
branch, private index, or ambient target index. Index checks fingerprint the
actual file identity, complete bytes, and stable metadata, covering
assume-unchanged, skip-worktree, split-index state, and extensions.

Keeper then creates one commit with `commit-tree`, requesting `-S` when
`commit.gpgSign` is enabled. It verifies the resulting commit object has exactly
the frozen tree and parent, repeats operation/ownership/branch/byte/index checks
after the signer boundary, and publishes with one compare-and-swap `update-ref`.
A moved ref is a typed conflict; Keeper never rolls another writer back.
`post-commit` runs only after publication, so its failure is a structured
committed-local outcome rather than a rollback attempt.

The ambient index is reconciled after publication only when exact checkout and
index identity still make that lossless. Otherwise the commit remains valid and
the result carries a warning. Remote publication uses the immutable commit SHA
to the captured branch ref; first-push tracking is configured separately after
the exact remote update.

### Explainability and wrapped enforcement

Preview and execution emit one versioned `commit-work-result` envelope. The
surface partitions caller-selected, unattributed-adoptable, observed-adoptable,
terminal-foreign-adoptable, live-foreign-conflict, ambiguous, excluded, and
ambient-staged paths. A committed result carries the exact file identities,
local commit state, and push state in the same object.

Wrapped workers derive the provider delta, write an out-of-tree adoption
manifest and message file, preview the exact set, and invoke Keeper. Their guard
denies raw `git commit`; ordinary Claude sessions retain policy and telemetry
rather than a global Git-command ban.

### Attribution boundedness

Git attribution uses the prior per-root snapshot/drop event id as a completeness
fence and never reads future events already present in a reducer batch. Active
roots carry the fence in `git_status`; a dropped root carries one impossible
Git-path floor row. Each snapshot keeps only active claims for currently dirty
paths, replacing unbounded discharged per-path tombstones with that compact
floor. Package-lock observations use a sparse cwd-and-event-interval index and a
stable `(ts, id)` winner; workspace-root ambiguity remains explicit adoption.

## Consequences

- A commit contains exactly the bytes and modes reviewed by this invocation,
  even when the ambient index contains unrelated staged work.
- Fixed attribution sleeps disappear. Fold lag is visible immediately as an
  adoption decision instead of being guessed away by elapsed time.
- Generated files and provider-leg output can be landed safely without granting
  shell activity automatic ownership.
- Hooks and signing remain compatible, but mutating hooks/signers must be made
  validation-only or their output committed in a fresh invocation.
- Initial/unborn branches remain unsupported by this path because atomic parent
  capture and existing repository policy require one parent.
- A post-commit-hook or push failure may report a real local commit; callers must
  branch on structured commit/push state and must not retry commit creation.
- Pi-native mutation attribution remains outside this decision. Pi can still be
  a provider leg whose output a Claude wrapper adopts explicitly.
