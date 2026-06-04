"""Tests for the fn-565 `planctl refine-apply` verb.

Coverage:
- Add a task to an existing epic.
- Rewrite an existing task's spec.
- Rewire deps (drop + add) on an existing task.
- Rewrite the epic spec.
- A new task depending on BOTH an existing id AND another new task (mixed
  existing-id + new-ordinal dep list — the novel-vs-scaffold resolver case).
- Cycle rejection on the post-delta graph.
- last_validated_at is re-stamped (refine-apply is in VALIDATION_RESTAMP_VERBS).
- Exactly ONE planctl_invocation line (op=refine-apply).
- Failure shapes: epic_not_found, target_invalid, dep_invalid, spec_invalid.
"""

from __future__ import annotations

import json

from click.testing import CliRunner
from planctl.cli import cli

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _invoke(args: list[str]):
    runner = CliRunner()
    return runner.invoke(cli, args)


def _parse_envelope(output: str) -> dict:
    """Take the first JSON document on stdout (compact NDJSON), skipping stderr noise."""
    for ln in output.strip().splitlines():
        stripped = ln.strip()
        if stripped.startswith("{"):
            return json.loads(stripped)
    raise AssertionError(f"No JSON line found in output: {output!r}")


def _count_planctl_invocation_lines(output: str) -> int:
    return sum(
        1
        for ln in output.strip().splitlines()
        if ln.strip().startswith("{") and "planctl_invocation" in ln
    )


def _indent(text: str, n: int) -> str:
    prefix = " " * n
    return "\n".join(prefix + line if line else "" for line in text.splitlines())


_VALID_TASK_SPEC = """\
## Description
Implement the thing.

## Acceptance
- [ ] It works.

## Done summary

## Evidence
"""


def _write(repo, name: str, content: str) -> str:
    path = repo / name
    path.write_text(content, encoding="utf-8")
    return str(path)


def _seed_two_task_epic(repo) -> str:
    """Scaffold a 2-task epic (task 2 deps on 1) and return its epic_id."""
    yaml = f"""\
epic:
  title: refine apply seed
  spec: |
    ## Overview
    seed epic.
tasks:
  - title: First task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
  - title: Second task
    deps: [1]
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write(repo, "seed.yaml", yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output
    return _parse_envelope(r.output)["epic_id"]


def _stamp_marker(repo, epic_id: str) -> None:
    epic_path = repo / ".planctl" / "epics" / f"{epic_id}.json"
    data = json.loads(epic_path.read_text())
    data["last_validated_at"] = "2020-01-01T00:00:00Z"
    epic_path.write_text(json.dumps(data))


def _read_epic(repo, epic_id: str) -> dict:
    return json.loads((repo / ".planctl" / "epics" / f"{epic_id}.json").read_text())


def _read_task(repo, task_id: str) -> dict:
    return json.loads((repo / ".planctl" / "tasks" / f"{task_id}.json").read_text())


def _read_task_spec(repo, task_id: str) -> str:
    return (repo / ".planctl" / "specs" / f"{task_id}.md").read_text()


def _read_epic_spec(repo, epic_id: str) -> str:
    return (repo / ".planctl" / "specs" / f"{epic_id}.md").read_text()


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_refine_apply_add_task(planctl_git_repo):
    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = f"""\
add_tasks:
  - title: Third task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    assert payload["success"] is True
    assert payload["added_task_ids"] == [f"{epic_id}.3"]
    assert _count_planctl_invocation_lines(r.output) == 1
    assert payload["planctl_invocation"]["op"] == "refine-apply"
    assert payload["planctl_invocation"]["target"] == epic_id

    new_task = _read_task(planctl_git_repo, f"{epic_id}.3")
    assert new_task["title"] == "Third task"
    assert new_task["depends_on"] == []
    assert "Implement the thing." in _read_task_spec(planctl_git_repo, f"{epic_id}.3")


def test_refine_apply_rewrite_spec(planctl_git_repo):
    epic_id = _seed_two_task_epic(planctl_git_repo)
    new_spec = (
        "## Description\nRewritten approach.\n\n"
        "## Acceptance\n- [ ] New bar.\n\n## Done summary\n\n## Evidence\n"
    )
    delta = f"""\
rewrite_specs:
  - task_id: {epic_id}.1
    spec: |
{_indent(new_spec, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    assert payload["rewritten_specs"] == [f"{epic_id}.1"]
    assert "Rewritten approach." in _read_task_spec(planctl_git_repo, f"{epic_id}.1")


def test_refine_apply_rewire_deps_drop_and_add(planctl_git_repo):
    epic_id = _seed_two_task_epic(planctl_git_repo)
    # Task 2 currently deps on task 1. Drop it; add nothing (clear).
    delta = f"""\
rewire_deps:
  - task_id: {epic_id}.2
    deps: []
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    assert payload["rewired_deps"] == [f"{epic_id}.2"]
    assert _read_task(planctl_git_repo, f"{epic_id}.2")["depends_on"] == []


def test_refine_apply_rewrite_epic_spec(planctl_git_repo):
    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = "epic:\n  spec: |\n    ## Overview\n    Rewritten epic spec.\n"
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    assert payload["epic_spec_rewritten"] is True
    assert "Rewritten epic spec." in _read_epic_spec(planctl_git_repo, epic_id)


def test_refine_apply_new_task_deps_on_existing_and_new(planctl_git_repo):
    """A new task depending on BOTH an existing id AND another new task.

    add_tasks #2 deps: [<existing fn.1>, 1] — mixing an existing-id string with
    a 1-based new-ordinal int. The resolver must map both correctly.
    """
    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = f"""\
add_tasks:
  - title: New A
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
  - title: New B
    deps: [{epic_id}.1, 1]
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    # max existing task was .2 -> new ordinals allocate .3 (New A) and .4 (New B).
    assert payload["added_task_ids"] == [f"{epic_id}.3", f"{epic_id}.4"]
    new_b = _read_task(planctl_git_repo, f"{epic_id}.4")
    # Existing-id string + new-ordinal 1 (New A = .3) both resolve.
    assert new_b["depends_on"] == [f"{epic_id}.1", f"{epic_id}.3"]


def test_refine_apply_restamps_validation_marker(planctl_git_repo):
    """fn-587 task .4: refine-apply re-stamps last_validated_at with a
    strictly-newer timestamp (instead of clearing to None)."""
    epic_id = _seed_two_task_epic(planctl_git_repo)
    _stamp_marker(planctl_git_repo, epic_id)
    pre_stamp = _read_epic(planctl_git_repo, epic_id)["last_validated_at"]
    assert pre_stamp is not None

    delta = "epic:\n  spec: |\n    ## Overview\n    touch it.\n"
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 0, r.output
    post_stamp = _read_epic(planctl_git_repo, epic_id)["last_validated_at"]
    assert isinstance(post_stamp, str) and post_stamp > pre_stamp, (
        f"refine-apply did not re-stamp last_validated_at to a newer value: "
        f"pre={pre_stamp!r} post={post_stamp!r}"
    )


# ---------------------------------------------------------------------------
# Failure shapes
# ---------------------------------------------------------------------------


def test_refine_apply_cycle_rejected(planctl_git_repo):
    """Rewiring task 1 to depend on task 2 (which already deps on 1) is a cycle."""
    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = f"""\
rewire_deps:
  - task_id: {epic_id}.1
    deps: [{epic_id}.2]
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 1, r.output
    payload = _parse_envelope(r.output)
    assert payload["success"] is False
    assert payload["error"]["code"] == "dep_cycle"
    # Nothing written: task 1 still has no deps.
    assert _read_task(planctl_git_repo, f"{epic_id}.1")["depends_on"] == []


def test_refine_apply_epic_not_found(planctl_git_repo):
    delta = "epic:\n  spec: |\n    ## Overview\n    x.\n"
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", "fn-99999-nope", "--file", delta_path])
    assert r.exit_code == 1, r.output
    assert _parse_envelope(r.output)["error"]["code"] == "epic_not_found"


def test_refine_apply_target_invalid(planctl_git_repo):
    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = f"""\
rewrite_specs:
  - task_id: {epic_id}.99
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 1, r.output
    assert _parse_envelope(r.output)["error"]["code"] == "target_invalid"


def test_refine_apply_dep_invalid(planctl_git_repo):
    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = f"""\
rewire_deps:
  - task_id: {epic_id}.1
    deps: [{epic_id}.999]
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 1, r.output
    assert _parse_envelope(r.output)["error"]["code"] == "dep_invalid"


def test_refine_apply_spec_invalid(planctl_git_repo):
    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = """\
add_tasks:
  - title: Bad spec task
    deps: []
    spec: |
      ## Description
      missing the other required sections
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 1, r.output
    assert _parse_envelope(r.output)["error"]["code"] == "spec_invalid"


def test_refine_apply_empty_delta_rejected(planctl_git_repo):
    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta_path = _write(planctl_git_repo, "delta.yaml", "{}\n")
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 1, r.output
    assert _parse_envelope(r.output)["error"]["code"] == "bad_yaml"


# ---------------------------------------------------------------------------
# Per-task target_repo (fn-585): deterministic replacement for the deleted
# gravity heuristic. Mirrors the scaffold test shapes for add_tasks; also
# covers the recompute-on-every-invocation contract for `epic.touched_repos`.
# ---------------------------------------------------------------------------


def test_refine_apply_add_tasks_target_repo(planctl_git_repo, multi_repo_project):
    """add_tasks declares `target_repo`; persisted per-task + included in rollup."""
    foreign_a, _ = multi_repo_project
    foreign_a_resolved = str(foreign_a.resolve())
    primary = str(planctl_git_repo.resolve())

    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = f"""\
add_tasks:
  - title: Third task
    deps: []
    tier: medium
    target_repo: {foreign_a}
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 0, r.output

    # The new task's target_repo matches the declared (resolved) value.
    new_task = _read_task(planctl_git_repo, f"{epic_id}.3")
    assert new_task["target_repo"] == foreign_a_resolved

    # touched_repos unions existing tasks (primary) with the new foreign repo.
    epic_def = _read_epic(planctl_git_repo, epic_id)
    assert epic_def["touched_repos"] == sorted({primary, foreign_a_resolved})


def test_refine_apply_add_tasks_omit_target_repo(planctl_git_repo):
    """add_tasks omits `target_repo`; persisted value falls back to epic.primary_repo."""
    primary = str(planctl_git_repo.resolve())

    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = f"""\
add_tasks:
  - title: Third task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 0, r.output

    new_task = _read_task(planctl_git_repo, f"{epic_id}.3")
    assert new_task["target_repo"] == primary
    # Single-repo plan — touched_repos stays one element.
    epic_def = _read_epic(planctl_git_repo, epic_id)
    assert epic_def["touched_repos"] == [primary]


def test_refine_apply_add_tasks_relative_rejected(planctl_git_repo):
    """add_tasks declares a relative `target_repo`; repo_invalid + no writes."""
    epic_id = _seed_two_task_epic(planctl_git_repo)
    # Snapshot the pre-delta state so we can assert no writes.
    epic_before = _read_epic(planctl_git_repo, epic_id)

    delta = f"""\
add_tasks:
  - title: Third task
    deps: []
    target_repo: "apps/foo"
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 1, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "repo_invalid"
    assert any("absolute path" in d for d in env["error"]["details"]), env["error"][
        "details"
    ]

    # No writes: epic JSON, task 3 absent, marker untouched.
    assert _read_epic(planctl_git_repo, epic_id) == epic_before
    assert not (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.3.json").exists()


def test_refine_apply_recompute_on_rewrite_specs_only(planctl_git_repo):
    """Zero add_tasks, only rewrite_specs; touched_repos still recomputed
    idempotently from existing tasks."""
    primary = str(planctl_git_repo.resolve())

    epic_id = _seed_two_task_epic(planctl_git_repo)
    # Sanity: seed produces single-repo plan.
    assert _read_epic(planctl_git_repo, epic_id)["touched_repos"] == [primary]

    new_spec = (
        "## Description\nRewritten approach.\n\n"
        "## Acceptance\n- [ ] New bar.\n\n## Done summary\n\n## Evidence\n"
    )
    delta = f"""\
rewrite_specs:
  - task_id: {epic_id}.1
    spec: |
{_indent(new_spec, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 0, r.output

    # Idempotent: same input → same touched_repos.
    assert _read_epic(planctl_git_repo, epic_id)["touched_repos"] == [primary]


def test_refine_apply_recompute_unions_existing_and_new(
    planctl_git_repo, multi_repo_project
):
    """Existing tasks point at repo A (primary), new add_tasks declare repo B;
    touched_repos becomes sorted({A, B})."""
    foreign_b, _ = multi_repo_project
    foreign_b_resolved = str(foreign_b.resolve())
    primary = str(planctl_git_repo.resolve())

    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = f"""\
add_tasks:
  - title: New B
    deps: []
    tier: medium
    target_repo: {foreign_b}
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 0, r.output

    epic_def = _read_epic(planctl_git_repo, epic_id)
    assert epic_def["touched_repos"] == sorted({primary, foreign_b_resolved})


def test_refine_apply_recompute_rejects_stale_target_repo(planctl_git_repo):
    """fn-589 task .1 (item 2): refine-apply now asserts filesystem-repo
    validity at write time (the trailing ``validate --epic`` the skill used to
    fire is no longer needed).  A pre-existing stale ``target_repo`` on disk
    surfaces as an ``integrity_failed`` envelope rather than round-tripping
    silently into ``touched_repos`` — the structural writes already landed at
    that point (refine-apply's per-file atomic_write semantics) but the
    ``last_validated_at`` stamp is NOT updated, so the dispatch observer's
    ``current_stamp != stored_stamp`` check still soft-disarms.
    """
    epic_id = _seed_two_task_epic(planctl_git_repo)

    # Hand-edit task .1 to point at a path that doesn't exist on this host.
    stale = "/definitely/not/a/real/path/on/this/host"
    t1_path = planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.1.json"
    t1 = json.loads(t1_path.read_text())
    t1["target_repo"] = stale
    t1_path.write_text(json.dumps(t1))

    # Pure rewrite_specs delta (no add_tasks) — refine-apply rebuilds
    # touched_repos as the union of every task's target_repo, then fails the
    # post-write integrity check because the stale path has no ``.git/`` dir.
    new_spec = (
        "## Description\nRewritten approach.\n\n"
        "## Acceptance\n- [ ] New bar.\n\n## Done summary\n\n## Evidence\n"
    )
    delta = f"""\
rewrite_specs:
  - task_id: {epic_id}.2
    spec: |
{_indent(new_spec, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 1, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "integrity_failed"
    assert any(stale in d for d in env["error"]["details"]), env["error"]["details"]

    # Task 1's stored target_repo was NOT silently rewritten by refine-apply.
    assert json.loads(t1_path.read_text())["target_repo"] == stale, (
        "refine-apply must not rewrite task target_repos"
    )


def test_refine_apply_target_repo_not_string_rejected(planctl_git_repo):
    """Non-string target_repo (int) is a shape failure → bad_yaml, no writes."""
    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = f"""\
add_tasks:
  - title: Third task
    deps: []
    target_repo: 42
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 1, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "bad_yaml"
    assert any(
        "`target_repo` must be a string" in d for d in env["error"]["details"]
    ), env["error"]["details"]
    assert not (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.3.json").exists()


def test_refine_apply_target_repo_tilde_expansion(planctl_git_repo, monkeypatch):
    """~ expansion: persisted target_repo is the canonicalised absolute path.

    fn-589 task .1 (item 2): refine-apply now asserts filesystem-repo validity
    at write time, so the tilde must resolve to a real ``.git/``-bearing dir.
    Point ``HOME`` at the (git-init'd) test repo so ``~`` expands to a valid
    git root.
    """
    from pathlib import Path as _P

    monkeypatch.setenv("HOME", str(planctl_git_repo))
    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = f"""\
add_tasks:
  - title: Third task
    deps: []
    tier: medium
    target_repo: "~"
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 0, r.output

    expected = str(_P("~").expanduser().resolve())
    new_task = _read_task(planctl_git_repo, f"{epic_id}.3")
    assert new_task["target_repo"] == expected
    # Persisted form is absolute (no leading ~).
    assert not new_task["target_repo"].startswith("~")
    assert new_task["target_repo"].startswith("/")


# ---------------------------------------------------------------------------
# fn-589 task .1 (item 1): stdin support via `--file -`
# ---------------------------------------------------------------------------


def test_refine_apply_reads_yaml_from_stdin(planctl_git_repo):
    """`--file -` reads delta YAML from stdin; envelope mirrors file mode."""
    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = f"""\
add_tasks:
  - title: Third task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    runner = CliRunner()
    r = runner.invoke(cli, ["refine-apply", epic_id, "--file", "-"], input=delta)
    assert r.exit_code == 0, r.output
    payload = _parse_envelope(r.output)
    assert payload["success"] is True
    assert payload["added_task_ids"] == [f"{epic_id}.3"]
    # Exactly ONE invocation line, same as file mode.
    assert _count_planctl_invocation_lines(r.output) == 1


# ---------------------------------------------------------------------------
# Per-task tier (fn-594): refine-apply mirrors scaffold's tier enforcement on
# add_tasks entries. Field is REQUIRED on every new task; missing field and
# unknown value both surface as tier_invalid; non-string is bad_yaml. Build-
# forward — no back-compat null default. `rewrite_specs` / `rewire_deps` do
# not mint new tasks and do not get a tier validation pass.
# ---------------------------------------------------------------------------


def test_refine_apply_add_tasks_missing_tier_rejected(planctl_git_repo):
    """Omitted `tier:` on an add_tasks entry → tier_invalid, no new task lands."""
    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = f"""\
add_tasks:
  - title: Third task
    deps: []
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "tier_invalid"
    detail_blob = " ".join(env["error"]["details"])
    assert "missing" in detail_blob, env["error"]["details"]
    for valid in ("medium", "high", "xhigh", "max"):
        assert valid in detail_blob, env["error"]["details"]
    # No new task landed.
    assert not (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.3.json").exists()


def test_refine_apply_add_tasks_invalid_tier_rejected(planctl_git_repo):
    """Unknown tier value (not in TASK_TIERS) → tier_invalid, no new task lands."""
    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = f"""\
add_tasks:
  - title: Third task
    deps: []
    tier: bogus
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "tier_invalid"
    assert any("'bogus'" in d for d in env["error"]["details"]), env["error"]["details"]
    assert not (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.3.json").exists()


def test_refine_apply_add_tasks_valid_tier_persists(planctl_git_repo):
    """Happy path: every TASK_TIERS member is accepted and persisted on the new task_def."""
    from planctl.models import TASK_TIERS

    epic_id = _seed_two_task_epic(planctl_git_repo)
    tasks_block = "".join(
        f"""  - title: tier add #{i}
    deps: []
    tier: {tier}
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
        for i, tier in enumerate(TASK_TIERS, start=1)
    )
    delta = f"add_tasks:\n{tasks_block}"
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 0, r.output

    # max existing task was .2 -> new ordinals allocate .3, .4, .5, .6.
    for offset, tier in enumerate(TASK_TIERS, start=3):
        td = _read_task(planctl_git_repo, f"{epic_id}.{offset}")
        assert td["tier"] == tier


def test_refine_apply_add_tasks_tier_non_string_is_bad_yaml(planctl_git_repo):
    """Non-string tier (int) is a shape failure → bad_yaml, no new task lands."""
    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = f"""\
add_tasks:
  - title: Third task
    deps: []
    tier: 42
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "bad_yaml"
    assert any("`tier` must be a string" in d for d in env["error"]["details"]), env[
        "error"
    ]["details"]
    assert not (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.3.json").exists()


def test_refine_apply_add_tasks_tier_collects_all_offenders(planctl_git_repo):
    """Collect-all: two add_tasks entries with missing/unknown tier → both in details."""
    epic_id = _seed_two_task_epic(planctl_git_repo)
    delta = f"""\
add_tasks:
  - title: missing tier
    deps: []
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
  - title: bogus tier
    deps: []
    tier: low
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "tier_invalid"
    details = env["error"]["details"]
    # The missing-tier offender is attributed to add_tasks #1.
    assert any("add_tasks #1" in d and "missing" in d for d in details), details
    # The bad-value offender is attributed to add_tasks #2.
    assert any("add_tasks #2" in d and "'low'" in d for d in details), details
    # Neither new task landed.
    for offset in (3, 4):
        assert not (
            planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.{offset}.json"
        ).exists()


# ---------------------------------------------------------------------------
# fn-640: refine-apply commit-boundary behavior after the fn-629 seam unwind
# was deleted. A pre-COMMIT failure (invocation-build raise, git error) now
# leaves the freshly-minted task/spec tree ON DISK (§10 no-rollback) — the
# keeper HEAD-gate is the sole guard that keeps an uncommitted tree invisible
# to the autopilot. The local write-phase try/except blocks still unwind a
# MID-WRITE crash, so these tests target the commit-failure window specifically
# (the write phase completed before the raise).
# ---------------------------------------------------------------------------


def test_refine_apply_missing_session_id_persists_writes(planctl_git_repo, monkeypatch):
    """CLAUDE_CODE_SESSION_ID unset → invocation-build raises in emit()
    AFTER the write phase already completed (fn-640). With the seam unwind gone, the
    freshly-minted task JSON / spec now PERSIST on disk (no automatic unwind).
    """
    epic_id = _seed_two_task_epic(planctl_git_repo)

    # The seed scaffold already committed; baseline tasks are 1 + 2.
    baseline_task3 = planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.3.json"
    baseline_spec3 = planctl_git_repo / ".planctl" / "specs" / f"{epic_id}.3.md"
    assert not baseline_task3.exists()
    assert not baseline_spec3.exists()

    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)

    delta = f"""\
add_tasks:
  - title: Third task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code != 0, r.output

    # The new task tree PERSISTS: the write phase completed before the
    # invocation-build raise, and there is no seam-level unwind anymore. The
    # tree is untracked-on-disk and invisible to the autopilot via keeper's
    # HEAD-gate until a re-run lands the commit.
    assert baseline_task3.exists()
    assert baseline_spec3.exists()


def test_refine_apply_invocation_raise_persists_written_tree(
    planctl_git_repo, monkeypatch
):
    """fn-640: a raise from build_planctl_invocation (after the write phase
    completed, pre-commit) leaves the freshly-written tree on disk — no
    seam-level unwind. The local write-phase block only unwinds a MID-WRITE
    crash, which is not this window.
    """
    epic_id = _seed_two_task_epic(planctl_git_repo)
    baseline_task3 = planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.3.json"
    baseline_spec3 = planctl_git_repo / ".planctl" / "specs" / f"{epic_id}.3.md"
    assert not baseline_task3.exists()

    import planctl.invocation as _inv

    def _boom(*_):
        raise RuntimeError("synthetic: invocation build blew up post-write")

    monkeypatch.setattr(_inv, "build_planctl_invocation", _boom)

    delta = f"""\
add_tasks:
  - title: Third task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code != 0, r.output

    # The fresh add_tasks write PERSISTS: pre-commit raise, no automatic unwind.
    assert baseline_task3.exists()
    assert baseline_spec3.exists()


def test_refine_apply_commit_failure_persists_written_tree(
    planctl_git_repo, monkeypatch
):
    """fn-640: a CommitFailed from auto_commit_from_invocation yields the
    structured ``commit_failed`` envelope (success envelope NEVER printed) and
    leaves the freshly-written add_tasks files ON DISK (§10 no-rollback). The
    deleted seam unwind no longer scrubs the pre-commit window.
    """
    from planctl import commit as commit_module

    epic_id = _seed_two_task_epic(planctl_git_repo)
    baseline_task3 = planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.3.json"
    baseline_spec3 = planctl_git_repo / ".planctl" / "specs" / f"{epic_id}.3.md"

    def _boom(_):
        raise commit_module.CommitFailed(
            "git_commit", "synthesized refine-apply commit rejection"
        )

    monkeypatch.setattr(commit_module, "auto_commit_from_invocation", _boom)

    delta = f"""\
add_tasks:
  - title: Third task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 1, r.output

    # The failure envelope landed (compact NDJSON), the success envelope did
    # NOT, and the freshly-written add_tasks files PERSIST (no unwind).
    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"] == "commit_failed"
    assert env["details"]["error"] == "git_commit"
    assert baseline_task3.exists()
    assert baseline_spec3.exists()


def test_refine_apply_lock_disjoint_from_commit_lock(planctl_git_repo, monkeypatch):
    """fn-629 task .2 acceptance (fn-640 retune): the ``_epic_id_lock``
    (id-allocation, sub-millisecond) is RELEASED before the auto-commit's git
    commit runs. Nesting would balloon the id-lock hold time across a git
    commit and bottleneck concurrent scaffolds in sibling projects. Since
    fn-640 deleted the commit flock, we spy the surviving commit seam
    (``_git_commit``) instead of the lock-acquire.
    """
    import contextlib as _ctxlib

    import planctl.commit as _commit_mod
    import planctl.run_epic_create as _epic_create_mod

    epic_id = _seed_two_task_epic(planctl_git_repo)

    events: list[str] = []
    original_lock = _epic_create_mod._epic_id_lock
    original_commit = _commit_mod._git_commit

    @_ctxlib.contextmanager
    def _spy_id_lock():
        events.append("id_lock:enter")
        with original_lock():
            try:
                yield
            finally:
                events.append("id_lock:exit")

    def _spy_commit(msg, files, cwd):
        events.append("commit:enter")
        sha = original_commit(msg, files, cwd)
        events.append("commit:done")
        return sha

    # refine-apply uses a function-local ``from planctl.run_epic_create
    # import _epic_id_lock`` lookup, which resolves the attribute from the
    # source module each call — patching the source attribute is sufficient.
    monkeypatch.setattr(_epic_create_mod, "_epic_id_lock", _spy_id_lock)
    monkeypatch.setattr(_commit_mod, "_git_commit", _spy_commit)

    delta = f"""\
add_tasks:
  - title: Third task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = _write(planctl_git_repo, "delta.yaml", delta)
    r = _invoke(["refine-apply", epic_id, "--file", delta_path])
    assert r.exit_code == 0, r.output

    # The id lock RELEASED before the git commit runs — no nesting.
    id_exit_idx = events.index("id_lock:exit")
    commit_enter_idx = events.index("commit:enter")
    assert id_exit_idx < commit_enter_idx, (
        f"id lock must release before the git commit runs; event order: {events}"
    )
