## Description

**Size:** M
**Files:** cli/commit-work.ts, src/commit-work/repo-state.ts, test/commit-work.test.ts, docs/problem-codes.md

### Approach

Three pre-commit gates layered around the purity flow the dependency task landed, ordered
cheap-to-expensive, plus the envelope documentation. New pure helpers live in a new
src/commit-work/repo-state.ts (dep-free, driven through the injected `GitRunner` seam).

1. **In-progress refusal (pure git, pre-lock, always-on, no override).** Refuse to commit
while the repo has a merge/sequencer operation in progress, mirroring git's own
`wt_status_get_state` set: `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` (each via
`git rev-parse -q --verify <name>`), a `rebase-merge` or `rebase-apply` directory, or a
`BISECT_LOG` — every probe path resolved via `git rev-parse --git-path <name>` (in a linked
worktree `.git` is a FILE and state lives in the per-worktree gitdir; never hardcode `.git/`).
WHY: a full `git commit` mid-merge silently creates a two-parent merge commit — the exact
shape that propagated the incident's stale blobs through an auto-merge. Envelope models the
existing `merge_in_progress` precedent in docs/problem-codes.md: commit-time, retry-safe
after the operator concludes or aborts the operation. Pre-lock refusals may use the throwing
`fail()` helper (the flock is not yet held).

2. **Jam-row refusal (keeper.db read, pre-lock, `--override-jam` escape).** Refuse while a
live shared-checkout distress row matches this repo: an open dispatch_failures row with verb
`daemon` and id starting `shared-checkout-dirty:` or `shared-checkout-desync:` whose `dir`
matches the resolved worktree toplevel. The read goes through a NEW injectable on
`CommitWorkDeps` (keeping the fast suite DB-free), implemented with the same read-only
`openDb` + `finally close` pattern as src/commit-work/attribution.ts. dir matching: NORMALIZE
BOTH SIDES (realpath plus trailing-slash strip) before comparing — the row's `dir` provenance
is the producer's repo-dir plumbing, not necessarily `git rev-parse --show-toplevel` output;
VERIFY actual provenance while implementing and add a parity test proving a
producer-shaped `dir` string matches the normalized toplevel. The gate fires on row PRESENCE
(independent of any notified marker — presence means the tree is in a bad state). FAIL-OPEN:
the read-only `openDb` throws on a missing file, and commit-work has no NotadbTolerance — a
broad try/catch around the whole probe (missing, locked, NOTADB, malformed) proceeds without
the gate, so commit-work keeps working in repos with no keeper state. `--override-jam`
(boolean flag, conventions per the sibling flags) proceeds past the refusal.

3. **Reversion-sweep tripwire (in-lock, post-stage, `--allow-mass-reversion` escape).** After
staging and the purity gate, detect the mass-reversion signature over the attributed staged
set: a path whose post-stage INDEX blob equals some `HEAD~1..HEAD~30` ancestor blob while
differing from HEAD's blob is a reversion candidate; abort when candidates number >= 5 AND
>= 30% of the staged set (both named module constants). Implementation: resolve index blob
ids once (`git ls-files -s -z --` over the staged set — also EXCLUDE mode-160000 gitlinks
here, and treat any stage-1/2/3 entry as an unmerged-path refusal), then ONE buffered
`git cat-file --batch-check` invocation through the `GitRunner` seam feeding every
`<rev>:<path>` spec on stdin (one-shot: write all, close, read to EOF — fits the existing
seam; no persistent process). Parse defensively: a missing object echoes the INPUT line plus
` missing` — key on the trailing token, never assume field 1 is a sha. Skip paths matching
the exclude-globset for legitimately oscillating surfaces (named module constant; include
plugins/prompt/corpus/**, oracle golden fixtures, bun.lockb, package-lock.json, *.lock).
Short-circuit each path at its first ancestor match. A history shorter than the window (root
commit reached, shallow clone) degrades to fewer ancestors probed — never an error, never a
false trip. Rename-blind ancestor lookup is an accepted limitation (a rename inside the
window suppresses the signal). A concluded-then-committed intentional revert trips by design;
`--allow-mass-reversion` is its escape. In-lock emission discipline: `printCompact` +
`return 1`, flock released by the outer `finally`.

4. **Envelope registry.** NEW `## keeper commit-work` section in docs/problem-codes.md (none
exists — the preamble mandates codes land with the change) covering EVERY envelope this epic
added across this task and the dependency task: `stale_index_carryover`, the in-progress
refusal, the jam refusal, the mass-reversion abort, `nothing_to_commit` — one row each with
meaning, recovery contract, retry-safety, mirroring the existing table idiom. Reconcile the
HELP/AGENT_HELP/LINT_FAILED_RECOVERY escape-hatch wording (from the dependency task) with the
new gates into ONE story: plain-git-with-explicit-paths remains the documented mixed-commit
path, stated as the deliberate exception the gates exist to make visible.

### Investigation targets

*Verify before relying — cited by file + symbol; the repo moves, so re-locate with search.*

**Required (read before coding):**
- cli/commit-work.ts — post-dependency-task flow: gate placement pre-lock vs in-lock, the
  `fail()` vs `printCompact` emission split, `CommitWorkDeps`, `parseArgs`/HELP/AGENT_HELP.
- src/commit-work/attribution.ts — the read-only `openDb` + `finally close` pattern to reuse
  (and its lack of a missing-file guard — you must add one around your probe).
- src/daemon.ts — `mintSharedCheckoutDistress` and the distress-row `dir` payload provenance
  (for the parity test).
- src/dispatch-failure-key.ts — the `shared-checkout-{dirty,desync}:` id-prefix constants
  (consume the exported constants; do not restate the strings).
- test/commit-work.test.ts + test/helpers/fake-git.ts — the seam all new git probes are
  asserted through (canned `rev-parse --git-path`, `ls-files -s`, `cat-file --batch-check`
  outcomes).
- docs/problem-codes.md — table idiom and the `merge_in_progress` precedent row.

**Optional:**
- src/git-toplevel.ts — toplevel resolution/normalization helpers.
- src/db.ts — `openDb` readonly behavior on a missing file (why the try/catch is mandatory).

### Risks

- The dir-parity assumption is the one silent-failure risk: an unnormalized compare no-ops
  the whole jam gate. The parity test is mandatory, not optional.
- Threshold constants (5 paths, 30%, 30 ancestors) are first-guess policy — name them as
  constants with rationale comments so retuning is a one-line change.
- The exclude-globset names THIS repo's regenerated surfaces; keep it a visible constant a
  future task can extend.

### Test notes

Fake-git seam: in-progress refusal per state (merge/cherry-pick/revert/rebase dirs/bisect)
with `--git-path`-resolved paths asserted in argv; jam refusal via the injected probe
(row present -> refuse; `--override-jam` proceeds; probe throwing -> fail-open proceeds);
parity test with a producer-shaped dir string against a sandboxed real DB fixture
(sandboxEnv + a seeded dispatch_failures row) plus the no-DB fail-open case; tripwire from
canned ls-files/cat-file outputs covering threshold boundaries (4 paths no-trip, 5+30%
trip), fraction denominator, gitlink exclusion, exclude-glob skip, missing-object parse,
short-history degrade, and `--allow-mass-reversion`. No real git.

## Acceptance

- [ ] commit-work refuses with a structured envelope when the repo is mid-merge, mid-cherry-pick,
  mid-revert, mid-rebase, or mid-bisect, probed worktree-portably; the refusal is retry-safe
  once the operation concludes.
- [ ] commit-work refuses while a live shared-checkout dirty/desync distress row matches the
  repo under a normalized dir compare backed by a provenance parity test; `--override-jam`
  proceeds; a missing, locked, or corrupt keeper.db fails open (asserted with no DB present).
- [ ] A staged set mass-matching ancestor blobs (at or past both thresholds, excluding
  gitlinks and the named exclude-globs) aborts with an envelope naming the flagged paths;
  `--allow-mass-reversion` proceeds; short history degrades to no signal; the probe is one
  batched cat-file call through the git seam.
- [ ] docs/problem-codes.md gains a keeper commit-work section covering every envelope this
  epic introduced, consistent with the help-text recovery story.
- [ ] Fast suite green; no real git or unsandboxed DB in any test.

## Done summary
Added three repo-state pre-commit gates to keeper commit-work: an always-on in-progress merge/sequencer refusal, a --override-jam shared-checkout dirty/desync jam refusal (fail-open keeper.db probe), and a --allow-mass-reversion post-stage ancestor-blob tripwire; new src/commit-work/repo-state.ts driven through the GitRunner seam, with every commit-work envelope registered in docs/problem-codes.md.
## Evidence
