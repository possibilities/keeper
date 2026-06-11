## Description

Resolves audit findings F1 (+TG1 merged) and F2 from
fn-24-strip-snippet-pipeline. Both edit `planctl/models.py` and ship as one
commit.

F1 — branch-default three-way divergence. Commit 80c8411 (the snippet-strip
commit) flipped `normalize_epic` (`models.py:59`) from `branch_name = None`
to `branch_name = "main"`, but `run_scaffold.py:901` still mints
`branch_name = epic_branch or epic_id` and the scaffold CLI docstrings
(`cli.py:229`, `cli.py:398`) claim `branch ... defaults to main`. A
no-`--branch` scaffold therefore yields `branch_name = epic_id`,
contradicting the help text. The uncommitted working-tree edit at
`run_epic_create.py:132` (`branch or "main"`) signals an in-flight intent to
standardize on `"main"`. Decide the single intended default, then make
`normalize_epic`, `run_scaffold.py:901`, `run_epic_create.py:132`, and the
`cli.py` docstrings agree.

TG1 (merged into F1) — once the default is chosen, add a scaffold test that
pins the no-`--branch` minted `branch_name` to the intended default; the
existing round-trip test covers snippets/bundles but not the branch flip.

F2 — dead-verb comments. The dormant-seam comments at `models.py:89` and
`models.py:148` both trail with "promptctl render-spec handles dedup at union
time". `render-spec` was deleted by this epic (commit cc7ee6b) and has no
surviving consumer. Per the repo's forward-facing doc discipline, trim the
trailing clause so each comment documents only the live fact (lists are
persisted verbatim, order-preserving).

## Acceptance

- [ ] `normalize_epic`, `run_scaffold.py:901`, `run_epic_create.py:132`, and the scaffold `cli.py` docstrings all reflect one chosen `branch_name` default.
- [ ] A scaffold test asserts the no-`--branch` minted `branch_name` equals the intended default.
- [ ] `models.py:89` and `models.py:148` comments carry no reference to `render-spec` (or any deleted verb) and state only the live verbatim-persist behavior.
- [ ] `uv run pytest tests/ --run-slow` stays green.

## Done summary
Standardized the scaffold-minted branch_name default on 'main' across run_scaffold.py, run_epic_create.py, normalize_epic, and the cli docstrings; pinned it with a no-branch scaffold test. Trimmed the deleted render-spec verb reference from the two models.py snippet/bundle normalize comments.
## Evidence
