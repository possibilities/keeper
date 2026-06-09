## Description

Finding F5 (auditor: "no test exercises multi-repo source scan"). The
`ordered_scan_repos` dedup/ordering and cross-repo trailer match in
`_find_source_commits` have no test coverage. All existing verdict tests
collapse `target_repo` and `state_repo` to the same single-repo fixture. If
the cross-repo scan path has a bug, a task in a cross-project epic would
receive a wrong verdict (`not_started` instead of `done`), causing the
orchestrator to spuriously resume a finished worker.

Add a test that creates two separate git repo fixtures (one as `state_repo`,
one as `target_repo`), makes a source commit with the correct `Task:` trailer
in `target_repo`, and asserts that `planctl reconcile` returns a `done` verdict.
Also assert that dedup applies when the same repo appears via both `target_repo`
and `touched_repos`.

## Acceptance

- [ ] Test uses two distinct git repos (state_repo != target_repo)
- [ ] Source commit in target_repo with correct Task: trailer produces `done` verdict
- [ ] No duplicate repo scan when target_repo also appears in touched_repos
- [ ] All existing reconcile tests continue to pass

## Done summary

## Evidence
