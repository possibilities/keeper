"""Tests for the fn-544 `planctl scaffold` verb.

Coverage:
- Happy path: epic + 2 tasks + one dep produces exactly ONE planctl_invocation
  envelope (op=scaffold) covering epic JSON + epic spec + every task JSON + every
  task spec.
- Task spec is written verbatim (NOT a skeleton).
- 1-based ordinal deps resolve to `fn-N.M` ids on the right tasks.
- Forward ref (task 1 deps on [2]) resolves via two-pass id allocation.
- Failure shapes: bad_yaml (non-mapping), spec_invalid (malformed task spec),
  dep_invalid (out-of-range ordinal), dep_cycle. Each writes nothing.
"""

from __future__ import annotations

import json

import pytest
from click.testing import CliRunner
from planctl.cli import cli

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_yaml(tmp_path, content: str) -> str:
    path = tmp_path / "plan.yaml"
    path.write_text(content, encoding="utf-8")
    return str(path)


def _invoke(args: list[str]):
    runner = CliRunner()
    return runner.invoke(cli, args)


def _parse_envelope(output: str) -> dict:
    """Take the first JSON document on stdout. Scaffold emits compact NDJSON.

    CliRunner can mix stderr noise (e.g. ``planctl.audit: emit failed`` when
    realtime fan-out is no-op in test environments) into
    ``r.output``; skip non-JSON lines.
    """
    for ln in output.strip().splitlines():
        stripped = ln.strip()
        if stripped.startswith("{"):
            return json.loads(stripped)
    raise AssertionError(f"No JSON line found in output: {output!r}")


def _count_planctl_invocation_lines(output: str) -> int:
    """Count how many JSON stdout lines carry a `planctl_invocation` key.

    Filters to lines that both start with ``{`` AND contain
    ``planctl_invocation`` so stderr text mentioning the substring (rare but
    possible) isn't counted. Mutating verbs emit exactly ONE such line — the
    decorator never double-emits because the sentinel is set inside
    ``output.emit()``.
    """
    return sum(
        1
        for ln in output.strip().splitlines()
        if ln.strip().startswith("{") and "planctl_invocation" in ln
    )


_VALID_TASK_SPEC = """\
## Description
Implement the thing.

## Acceptance
- [ ] It works.

## Done summary

## Evidence
"""


def _two_task_yaml() -> str:
    return f"""\
epic:
  title: scaffold smoke test
  spec: |
    ## Overview
    A scaffold smoke test.
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


def _indent(text: str, n: int) -> str:
    prefix = " " * n
    return "\n".join(prefix + line if line else "" for line in text.splitlines())


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_scaffold_happy_path_emits_one_invocation(planctl_git_repo):
    yaml_path = _write_yaml(planctl_git_repo, _two_task_yaml())

    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    assert payload["success"] is True

    epic_id = payload["epic_id"]
    task_ids = payload["task_ids"]
    assert epic_id.startswith("fn-")
    assert task_ids == [f"{epic_id}.1", f"{epic_id}.2"]

    # Exactly ONE planctl_invocation line — no decorator double-emit.
    assert _count_planctl_invocation_lines(r.output) == 1

    pc = payload["planctl_invocation"]
    assert pc["op"] == "scaffold"
    assert pc["target"] == epic_id
    assert pc["subject"] == f"chore(planctl): scaffold {epic_id}"

    # files must cover epic JSON + epic spec + every task JSON + every task spec.
    expected_files = {
        f".planctl/epics/{epic_id}.json",
        f".planctl/specs/{epic_id}.md",
        f".planctl/tasks/{epic_id}.1.json",
        f".planctl/specs/{epic_id}.1.md",
        f".planctl/tasks/{epic_id}.2.json",
        f".planctl/specs/{epic_id}.2.md",
    }
    assert expected_files.issubset(set(pc["files"])), (
        f"missing files: {expected_files - set(pc['files'])} (got: {pc['files']})"
    )


def test_scaffold_writes_verbatim_specs_not_skeletons(planctl_git_repo):
    yaml_path = _write_yaml(planctl_git_repo, _two_task_yaml())
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    epic_id = _parse_envelope(r.output)["epic_id"]
    spec_1 = (planctl_git_repo / ".planctl" / "specs" / f"{epic_id}.1.md").read_text()
    # Body must include our literal "Implement the thing." line — a skeleton
    # would have an empty Description.
    assert "Implement the thing." in spec_1
    assert "- [ ] It works." in spec_1


def test_scaffold_dep_resolves_to_fn_n_m(planctl_git_repo):
    yaml_path = _write_yaml(planctl_git_repo, _two_task_yaml())
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    epic_id = _parse_envelope(r.output)["epic_id"]
    task_2 = json.loads(
        (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.2.json").read_text()
    )
    assert task_2["depends_on"] == [f"{epic_id}.1"]


def test_scaffold_forward_ref_resolves(planctl_git_repo):
    """Task 1 declares deps=[2] (forward ref) — two-pass resolution must work."""
    yaml = f"""\
epic:
  title: forward ref test
  spec: |
    ## Overview
    forward ref.
tasks:
  - title: First task
    deps: [2]
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
  - title: Second task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    epic_id = _parse_envelope(r.output)["epic_id"]
    task_1 = json.loads(
        (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.1.json").read_text()
    )
    assert task_1["depends_on"] == [f"{epic_id}.2"]


def test_scaffold_epic_carries_snippets_bundles(planctl_git_repo):
    yaml = f"""\
epic:
  title: snippet metadata
  snippets: [snip-a, snip-b]
  bundles: [bundle/dev-env, arc/snippeting/main]
  spec: |
    ## Overview
    yes.
tasks:
  - title: only task
    deps: []
    tier: medium
    snippets: [task-snip]
    bundles: [bundle/dev-env]
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    epic_id = _parse_envelope(r.output)["epic_id"]
    epic_def = json.loads(
        (planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json").read_text()
    )
    assert epic_def["snippets"] == ["snip-a", "snip-b"]
    assert epic_def["bundles"] == ["bundle/dev-env", "arc/snippeting/main"]
    # fn-587 task .3: Fresh epic from scaffold ships pre-stamped (the in-memory
    # integrity check ran clean, so we mint with last_validated_at = now_iso()).
    # Prior behaviour was None-on-write + normalize_epic filling on load.
    stamped = epic_def.get("last_validated_at")
    assert stamped is not None, (
        f"Fresh epic must ship with last_validated_at stamped: {epic_def}"
    )
    # Microsecond precision: ISO-8601 with .%fZ suffix.
    assert "." in stamped and stamped.endswith("Z"), (
        f"last_validated_at must carry microsecond precision: {stamped!r}"
    )

    task_def = json.loads(
        (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.1.json").read_text()
    )
    assert task_def["snippets"] == ["task-snip"]
    assert task_def["bundles"] == ["bundle/dev-env"]


# ---------------------------------------------------------------------------
# fn-630 advisory: empty-shell epic+tasks (no snippet/bundle metadata anywhere)
# surfaces a `warnings` entry on the success envelope `data` — exactly ONE
# emit, ONE commit, contract unchanged.
# ---------------------------------------------------------------------------


def test_scaffold_no_substrate_emits_advisory_warning(planctl_git_repo):
    """Epic + tasks with no snippets/bundles anywhere surfaces the advisory.

    The advisory rides the success envelope `data` (emit has no `warnings`
    parameter). Single emit + single commit contract is preserved — exactly
    one `planctl_invocation` line on stdout.
    """
    yaml_path = _write_yaml(planctl_git_repo, _two_task_yaml())
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    assert payload["success"] is True

    # Advisory must be present on the envelope data.
    warnings = payload.get("warnings")
    assert warnings is not None, f"Expected `warnings` on envelope: {payload}"
    assert isinstance(warnings, list)
    assert len(warnings) == 1
    # Naming the epic id keeps the warning useful in batch contexts.
    assert payload["epic_id"] in warnings[0]
    assert "snippet/bundle metadata" in warnings[0]

    # Single-emit invariant: exactly ONE planctl_invocation line on stdout.
    assert _count_planctl_invocation_lines(r.output) == 1


def test_scaffold_with_epic_substrate_no_advisory(planctl_git_repo):
    """Epic-level snippets present -> no advisory (even if tasks are empty)."""
    yaml = f"""\
epic:
  title: epic has substrate
  snippets: [some-snip]
  spec: |
    ## Overview
    yes.
tasks:
  - title: only task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    assert payload["success"] is True
    assert "warnings" not in payload, (
        f"No advisory expected when epic carries substrate: {payload}"
    )


def test_scaffold_with_task_substrate_no_advisory(planctl_git_repo):
    """Any task carrying snippets/bundles -> no advisory (even if epic is empty)."""
    yaml = f"""\
epic:
  title: task has substrate
  spec: |
    ## Overview
    yes.
tasks:
  - title: only task
    deps: []
    tier: medium
    snippets: [task-snip]
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    assert payload["success"] is True
    assert "warnings" not in payload, (
        f"No advisory expected when a task carries substrate: {payload}"
    )


# ---------------------------------------------------------------------------
# fn-610: scaffold inlines `sketch/` refs at write time (same-project happy path).
# Cross-project coverage lives in test_cross_project_sketch_inline.py.
# ---------------------------------------------------------------------------


def _write_sketch(repo, name: str, snippet_ids: list[str]) -> None:
    """Author a sketch YAML under ``<repo>/.promptctl/sketches/<name>.yaml``."""
    from datetime import UTC, datetime

    import yaml as _yaml

    sketches_dir = repo / ".promptctl" / "sketches"
    sketches_dir.mkdir(parents=True, exist_ok=True)
    (sketches_dir / f"{name}.yaml").write_text(
        _yaml.safe_dump(
            {
                "id": name,
                "snippet_ids": snippet_ids,
                "summary": None,
                "tags": [],
                "created_at": datetime.now(UTC).isoformat(),
            }
        )
    )


def test_scaffold_inlines_sketch_refs_into_snippets(planctl_git_repo):
    """Same-project sketch inlining: ids fold into snippets, sketch ref dropped."""
    _write_sketch(planctl_git_repo, "draft-epic", ["epic-snip-1", "epic-snip-2"])
    _write_sketch(planctl_git_repo, "draft-task", ["task-snip-1"])

    yaml = f"""\
epic:
  title: sketch inline
  snippets: [pre-existing]
  bundles: [bundle/dev-env, sketch/draft-epic]
  spec: |
    ## Overview
    yes.
tasks:
  - title: only task
    deps: []
    tier: medium
    snippets: [task-pre]
    bundles: [sketch/draft-task, arc/snippeting/main]
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    epic_id = _parse_envelope(r.output)["epic_id"]
    epic_def = json.loads(
        (planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json").read_text()
    )
    # Existing snippets first, then sketch ids appended; sketch ref dropped.
    assert epic_def["snippets"] == ["pre-existing", "epic-snip-1", "epic-snip-2"]
    assert epic_def["bundles"] == ["bundle/dev-env"]
    assert all(not b.startswith("sketch/") for b in epic_def["bundles"])

    task_def = json.loads(
        (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.1.json").read_text()
    )
    assert task_def["snippets"] == ["task-pre", "task-snip-1"]
    assert task_def["bundles"] == ["arc/snippeting/main"]
    assert all(not b.startswith("sketch/") for b in task_def["bundles"])


def test_scaffold_missing_sketch_emits_ref_invalid(planctl_git_repo):
    """Unresolvable sketch -> ref_invalid envelope, no writes land."""
    yaml = f"""\
epic:
  title: missing sketch
  bundles: [sketch/does-not-exist]
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "ref_invalid"
    # No tree written.
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_empty_sketch_drops_ref_keeps_snippets(planctl_git_repo):
    """Empty sketch (snippet_ids: []) drops ref, adds zero ids."""
    _write_sketch(planctl_git_repo, "empty-draft", [])

    yaml = f"""\
epic:
  title: empty sketch
  snippets: [keep-me]
  bundles: [sketch/empty-draft, bundle/dev-env]
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    epic_id = _parse_envelope(r.output)["epic_id"]
    epic_def = json.loads(
        (planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json").read_text()
    )
    assert epic_def["snippets"] == ["keep-me"]
    assert epic_def["bundles"] == ["bundle/dev-env"]


# ---------------------------------------------------------------------------
# Epic-level depends_on_epics (fn-556)
# ---------------------------------------------------------------------------


def _seed_epic(repo, title: str = "seed epic") -> str:
    """Scaffold a one-task epic and return its allocated epic_id.

    ``title`` is taken as-is — callers that need multiple sibling epics
    pass distinct titles to dodge fn-623's dup-guard (same-slug scaffolds
    now hard-error with ``duplicate_epic`` unless ``--allow-duplicate``
    is set).
    """
    yaml = f"""\
epic:
  title: {title}
  spec: |
    ## Overview
    seed.
tasks:
  - title: only task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output
    return _parse_envelope(r.output)["epic_id"]


def test_scaffold_epic_dep_happy_path_preserves_order(planctl_git_repo):
    first = _seed_epic(planctl_git_repo, title="seed epic first")
    second = _seed_epic(planctl_git_repo, title="seed epic second")
    yaml = f"""\
epic:
  title: dependent epic
  depends_on_epics: [{second}, {first}]
  spec: |
    ## Overview
    depends.
tasks:
  - title: only task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    epic_id = _parse_envelope(r.output)["epic_id"]
    epic_def = json.loads(
        (planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json").read_text()
    )
    # Declared order preserved (not sorted).
    assert epic_def["depends_on_epics"] == [second, first]


def test_scaffold_no_epic_deps_yields_empty_list(planctl_git_repo):
    """Absent field coerces to []."""
    yaml_path = _write_yaml(planctl_git_repo, _two_task_yaml())
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output
    epic_id = _parse_envelope(r.output)["epic_id"]
    epic_def = json.loads(
        (planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json").read_text()
    )
    assert epic_def["depends_on_epics"] == []


def test_scaffold_epic_dep_non_list_is_typed(planctl_git_repo):
    yaml = f"""\
epic:
  title: bad dep type
  depends_on_epics: "fn-1-foo"
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output
    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "epic_dep_invalid"
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_epic_dep_list_of_non_strings_is_typed(planctl_git_repo):
    yaml = f"""\
epic:
  title: bad dep elem type
  depends_on_epics: [1, 2]
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output
    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "epic_dep_invalid"
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_epic_dep_malformed_id_is_typed(planctl_git_repo):
    yaml = f"""\
epic:
  title: malformed dep id
  depends_on_epics: [fn-abc]
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output
    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "epic_dep_invalid"
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_epic_dep_nonexistent_is_typed(planctl_git_repo):
    yaml = f"""\
epic:
  title: nonexistent dep
  depends_on_epics: [fn-9999-nope]
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output
    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "epic_dep_invalid"
    assert any("does not exist" in d for d in env["error"]["details"]), env["error"][
        "details"
    ]
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_epic_dep_duplicate_is_typed(planctl_git_repo):
    first = _seed_epic(planctl_git_repo)
    yaml = f"""\
epic:
  title: dup dep
  depends_on_epics: [{first}, {first}]
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output
    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "epic_dep_invalid"
    assert any("duplicated" in d for d in env["error"]["details"]), env["error"][
        "details"
    ]


# ---------------------------------------------------------------------------
# Failure shapes — typed code, no writes land
# ---------------------------------------------------------------------------


def _no_epics_or_tasks_landed(repo) -> bool:
    """Assert no fn-* epic / task / spec files were written."""
    for sub in ("epics", "tasks", "specs"):
        d = repo / ".planctl" / sub
        if d.exists() and any(d.glob("fn-*.*")):
            return False
    return True


def test_scaffold_bad_yaml_non_mapping_doc(planctl_git_repo):
    yaml_path = _write_yaml(planctl_git_repo, "just a string\n")
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "bad_yaml"
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_empty_tasks_list_is_bad_yaml(planctl_git_repo):
    """An empty `tasks: []` list trips the n_tasks == 0 invariant
    (run_scaffold.py: "tasks: must contain at least one entry")."""
    yaml = """\
epic:
  title: no tasks
  spec: |
    ## Overview
    x.
tasks: []
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "bad_yaml"
    assert any(
        "tasks: must contain at least one entry" in d for d in env["error"]["details"]
    ), env["error"]["details"]
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_spec_invalid_lists_offending_task(planctl_git_repo):
    bad_spec = (
        "## Description\n\n## Acceptance\n\n## Done summary\n"  # missing Evidence
    )
    yaml = f"""\
epic:
  title: malformed spec
  spec: |
    ## Overview
    nope.
tasks:
  - title: ok
    deps: []
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
  - title: bad
    deps: []
    spec: |
{_indent(bad_spec, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "spec_invalid"
    # Must attribute to "task #2" (1-based).
    assert any("task #2" in d for d in env["error"]["details"]), env["error"]["details"]
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_dep_out_of_range_is_typed(planctl_git_repo):
    yaml = f"""\
epic:
  title: bad ordinal
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: [5]
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "dep_invalid"
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_dep_self_ref_is_typed(planctl_git_repo):
    yaml = f"""\
epic:
  title: self ref
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: [1]
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output
    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "dep_invalid"


def test_scaffold_dep_cycle_is_typed(planctl_git_repo):
    yaml = f"""\
epic:
  title: cycle
  spec: |
    ## Overview
    cycle.
tasks:
  - title: a
    deps: [2]
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
  - title: b
    deps: [1]
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "dep_cycle"
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_ref_invalid_rejects_bad_snippet_id(planctl_git_repo):
    yaml = f"""\
epic:
  title: bad refs
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    snippets: ["UPPER-SNIP"]
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "ref_invalid"
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_ref_invalid_rejects_bad_bundle_ref(planctl_git_repo):
    yaml = f"""\
epic:
  title: bad bundle
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    bundles: ["arc/foo/../etc"]
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "ref_invalid"
    assert _no_epics_or_tasks_landed(planctl_git_repo)


# ---------------------------------------------------------------------------
# Verb registration / template / not-in-VALIDATION_RESTAMP_VERBS
# ---------------------------------------------------------------------------


def test_scaffold_registered_in_verb_templates():
    from planctl.commit_messages import VERB_TEMPLATES, build_subject

    assert "scaffold" in VERB_TEMPLATES
    # build_subject must not raise.
    subject = build_subject("scaffold", "fn-7-test")
    assert subject == "chore(planctl): scaffold fn-7-test"


def test_scaffold_not_in_validation_restamp_verbs():
    """Scaffold mints a fresh epic and stamps last_validated_at itself; adding
    it to VALIDATION_RESTAMP_VERBS is redundant.  Defend against accidental
    inclusion (fn-587 task .4 renamed the tuple from VALIDATION_CLEAR_VERBS)."""
    try:
        from planctl.validation_restamp import VALIDATION_RESTAMP_VERBS
    except ImportError:
        # Older trees may not have the module; skip cleanly.
        pytest.skip("validation_restamp module not present")
        return  # unreachable; satisfies type checker (pytest.skip raises)
    assert "scaffold" not in VALIDATION_RESTAMP_VERBS


# ---------------------------------------------------------------------------
# Per-task target_repo (fn-585): deterministic replacement for the deleted
# gravity heuristic. Schema is shape-only — no filesystem checks at scaffold
# time so epic JSON stays portable across hosts (artbird auto-deploy).
# ---------------------------------------------------------------------------


def test_scaffold_default_target_repo_unchanged(planctl_git_repo):
    """Default-omit on every task: each task's target_repo == primary_repo and
    touched_repos == [primary_repo] (single-element, unchanged from pre-fn-585).

    Also asserts the success envelope's `repo_distribution` field rolls up
    every task under the primary repo (fn-613)."""
    yaml_path = _write_yaml(planctl_git_repo, _two_task_yaml())
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    epic_id = payload["epic_id"]
    primary = str(planctl_git_repo.resolve())

    # fn-613: top-level repo_distribution rides the success envelope.
    assert payload["repo_distribution"] == {primary: 2}

    epic_def = json.loads(
        (planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json").read_text()
    )
    assert epic_def["touched_repos"] == [primary]
    assert epic_def["primary_repo"] == primary

    for i in (1, 2):
        td = json.loads(
            (
                planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.{i}.json"
            ).read_text()
        )
        assert td["target_repo"] == primary


def test_scaffold_per_task_target_repo(planctl_git_repo, multi_repo_project):
    """Two distinct absolute target_repos: persisted per-task, rolled up sorted-uniq."""
    primary_other, touched_other = multi_repo_project
    # Use the planctl_git_repo as the scaffold cwd, with two foreign repos as targets.
    yaml = f"""\
epic:
  title: per task target repo
  spec: |
    ## Overview
    fan out across repos.
tasks:
  - title: task A
    deps: []
    tier: medium
    target_repo: {primary_other}
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
  - title: task B
    deps: []
    tier: medium
    target_repo: {touched_other}
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    epic_id = payload["epic_id"]
    primary_resolved = str(primary_other.resolve())
    touched_resolved = str(touched_other.resolve())

    # fn-613: per-repo split lands in the success envelope with sorted keys.
    expected_dist = {primary_resolved: 1, touched_resolved: 1}
    assert payload["repo_distribution"] == expected_dist
    # Determinism: keys must be sorted (lex order).
    assert list(payload["repo_distribution"].keys()) == sorted(expected_dist.keys())

    epic_def = json.loads(
        (planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json").read_text()
    )
    assert epic_def["touched_repos"] == sorted({primary_resolved, touched_resolved})

    t1 = json.loads(
        (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.1.json").read_text()
    )
    t2 = json.loads(
        (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.2.json").read_text()
    )
    assert t1["target_repo"] == primary_resolved
    assert t2["target_repo"] == touched_resolved


def test_scaffold_mixed_target_repo_dedup(planctl_git_repo, multi_repo_project):
    """Two tasks declare the same target_repo, third omits — sorted-uniq rollup."""
    foreign_a, foreign_b = multi_repo_project
    yaml = f"""\
epic:
  title: mixed dedup
  spec: |
    ## Overview
    mixed.
tasks:
  - title: task A
    deps: []
    tier: medium
    target_repo: {foreign_a}
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
  - title: task B
    deps: []
    tier: medium
    target_repo: {foreign_a}
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
  - title: task C (omits target_repo)
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    epic_id = _parse_envelope(r.output)["epic_id"]
    primary = str(planctl_git_repo.resolve())
    foreign_a_resolved = str(foreign_a.resolve())

    epic_def = json.loads(
        (planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json").read_text()
    )
    # Sorted-uniq: foreign_a (once, not twice) plus primary (from the omitted task).
    assert epic_def["touched_repos"] == sorted({foreign_a_resolved, primary})
    # foreign_b never appears — only declared target_repos roll up.
    assert str(foreign_b.resolve()) not in epic_def["touched_repos"]

    # Per-task target_repo unchanged.
    t1 = json.loads(
        (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.1.json").read_text()
    )
    t2 = json.loads(
        (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.2.json").read_text()
    )
    t3 = json.loads(
        (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.3.json").read_text()
    )
    assert t1["target_repo"] == foreign_a_resolved
    assert t2["target_repo"] == foreign_a_resolved
    assert t3["target_repo"] == primary


def test_scaffold_target_repo_tilde_expansion(planctl_git_repo, monkeypatch):
    """~ expansion: persisted target_repo must be the canonicalised absolute path.

    fn-589 task .1 (item 2): scaffold now asserts filesystem-repo validity at
    mint time, so the tilde must resolve to a real ``.git/``-bearing dir.
    Point ``HOME`` at the (git-init'd) test repo so ``~`` expands to a valid
    git root.
    """
    monkeypatch.setenv("HOME", str(planctl_git_repo))
    yaml = f"""\
epic:
  title: tilde expansion
  spec: |
    ## Overview
    ~.
tasks:
  - title: only task
    deps: []
    tier: medium
    target_repo: "~"
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    from pathlib import Path as _P

    expected = str(_P("~").expanduser().resolve())

    epic_id = _parse_envelope(r.output)["epic_id"]
    td = json.loads(
        (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.1.json").read_text()
    )
    assert td["target_repo"] == expected
    # Persisted form is absolute (no leading ~).
    assert not td["target_repo"].startswith("~")
    assert td["target_repo"].startswith("/")


def test_scaffold_target_repo_relative_rejected(planctl_git_repo):
    """Relative paths (CWE-22-class footgun) rejected with repo_invalid; no writes."""
    yaml = f"""\
epic:
  title: relative path
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    target_repo: "apps/foo"
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "repo_invalid"
    assert any("absolute path" in d for d in env["error"]["details"]), env["error"][
        "details"
    ]
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_target_repo_not_string_rejected(planctl_git_repo):
    """Non-string target_repo (int / list) is a shape failure → bad_yaml, no writes."""
    yaml = f"""\
epic:
  title: bad target_repo type
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    target_repo: 42
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "bad_yaml"
    assert any(
        "`target_repo` must be a string" in d for d in env["error"]["details"]
    ), env["error"]["details"]
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_target_repo_empty_string_rejected(planctl_git_repo):
    """Empty-after-strip target_repo → repo_invalid, no writes."""
    yaml = f"""\
epic:
  title: empty target_repo
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    target_repo: "   "
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "repo_invalid"
    assert any("non-empty after strip" in d for d in env["error"]["details"]), env[
        "error"
    ]["details"]
    assert _no_epics_or_tasks_landed(planctl_git_repo)


# ---------------------------------------------------------------------------
# fn-587 task .3: scaffold runs the shared integrity check at mint time and
# stamps last_validated_at on the fresh epic.  The auto-commit at emit() lands
# the whole tree in one commit covering epic JSON + epic spec + every task
# JSON + every task spec.
# ---------------------------------------------------------------------------


def test_scaffold_fresh_epic_carries_validated_marker(planctl_git_repo):
    """Acceptance (a): valid scaffold writes ``last_validated_at = now_iso()``
    on the epic JSON, with microsecond precision (``.%fZ`` suffix)."""
    yaml_path = _write_yaml(planctl_git_repo, _two_task_yaml())
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    epic_id = _parse_envelope(r.output)["epic_id"]
    epic_def = json.loads(
        (planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json").read_text()
    )
    stamped = epic_def.get("last_validated_at")
    assert stamped is not None, (
        f"Fresh epic must ship with last_validated_at stamped: {epic_def}"
    )
    # Microsecond precision: ISO-8601 with .%fZ suffix.
    assert "." in stamped and stamped.endswith("Z"), (
        f"last_validated_at must carry microsecond precision: {stamped!r}"
    )


def test_scaffold_fresh_epic_emit_covers_one_commit(planctl_git_repo):
    """Acceptance (a) part 2: the scaffold's planctl_invocation payload covers
    epic JSON + epic spec + every task JSON + every task spec, so the per-verb
    auto-commit at emit() lands the whole tree in one commit."""
    yaml_path = _write_yaml(planctl_git_repo, _two_task_yaml())
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    epic_id = payload["epic_id"]
    pc = payload["planctl_invocation"]
    expected_files = {
        f".planctl/epics/{epic_id}.json",
        f".planctl/specs/{epic_id}.md",
        f".planctl/tasks/{epic_id}.1.json",
        f".planctl/specs/{epic_id}.1.md",
        f".planctl/tasks/{epic_id}.2.json",
        f".planctl/specs/{epic_id}.2.md",
    }
    assert expected_files.issubset(set(pc["files"])), (
        f"missing files: {expected_files - set(pc['files'])} (got: {pc['files']})"
    )


def test_scaffold_integrity_failure_aborts_no_writes(planctl_git_repo, monkeypatch):
    """Acceptance (b): a structural integrity failure on the in-memory tree
    aborts the scaffold cleanly — no JSON files written, no commit landed,
    failure envelope on stdout with the ``integrity_failed`` code.

    Scaffold's Phase 2 YAML validation already catches the major structural
    classes (cycles, bad deps, bad ordinals, missing headings, ref shape) and
    its in-memory integrity call deliberately runs with
    ``check_filesystem_repos=False`` (cross-machine epic-JSON portability —
    artbird auto-deploy ships epic JSON between hosts).  That leaves the
    integrity gate as a belt-and-suspenders defense; we exercise the abort
    branch by patching the helper to return a synthetic error.  This proves:

    1. The failure envelope shape is ``integrity_failed`` with the detail list
       containing the synthetic error verbatim.
    2. No ``.planctl/`` epic / task / spec files land on disk (rollback
       removes the pre-written spec files).
    3. No git commit lands.
    """
    import subprocess

    head_before = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=planctl_git_repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

    # Patch the in-memory integrity check at its source module so the
    # scaffold-internal import (function-local) resolves to our spy.
    import planctl.integrity as _integ

    monkeypatch.setattr(
        _integ,
        "check_epic_tree_in_memory",
        lambda *_, **__: (["synthetic: integrity says no"], []),
    )

    yaml_path = _write_yaml(planctl_git_repo, _two_task_yaml())
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "integrity_failed", env["error"]
    assert any("synthetic: integrity says no" in d for d in env["error"]["details"]), (
        env["error"]["details"]
    )

    # No epic / task JSON or spec landed (the pre-written specs are rolled back
    # by scaffold on integrity failure).
    assert _no_epics_or_tasks_landed(planctl_git_repo)
    # No commit landed either.
    head_after = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=planctl_git_repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert head_before == head_after, (
        f"Scaffold integrity failure must not land a commit; "
        f"head moved {head_before} -> {head_after}"
    )


# ---------------------------------------------------------------------------
# scaffold commit-boundary behavior. (a) the env guard still fails closed on a
# missing PLANCTL_SESSION_ID BEFORE any write, so zero files land — this guard
# is independent of the seam and survives fn-640. (b) post-fn-640 the seam
# unwind is gone: a build_planctl_invocation raise AFTER the write phase
# completed leaves the fully-written tree ON DISK (§10 no-rollback); the keeper
# HEAD-gate keeps an uncommitted epic invisible to the autopilot.
# ---------------------------------------------------------------------------


def test_scaffold_missing_session_id_writes_nothing(planctl_git_repo, monkeypatch):
    """fn-630 (a): a missing PLANCTL_SESSION_ID fails closed BEFORE any write.

    Proves the orphan-epic incident can't recur via the env path: the verb
    refuses up front with ``missing_session_id``, ``scan_max_epic_id`` does not
    advance, and zero epic/task/spec files land on disk.
    """
    import subprocess

    from planctl.ids import scan_max_epic_id

    data_dir = planctl_git_repo / ".planctl"
    next_id_before = scan_max_epic_id(data_dir)
    head_before = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=planctl_git_repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

    monkeypatch.delenv("PLANCTL_SESSION_ID", raising=False)

    yaml_path = _write_yaml(planctl_git_repo, _two_task_yaml())
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "missing_session_id", env["error"]

    # Zero filesystem mutation: no orphan files, next-id unchanged, no commit.
    assert _no_epics_or_tasks_landed(planctl_git_repo)
    assert scan_max_epic_id(data_dir) == next_id_before
    head_after = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=planctl_git_repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert head_before == head_after, (
        f"missing_session_id must not land a commit; head moved "
        f"{head_before} -> {head_after}"
    )


def test_scaffold_invocation_raise_persists_written_tree(planctl_git_repo, monkeypatch):
    """fn-640: a raise in build_planctl_invocation (after the tree is on disk,
    pre-commit) leaves every written file ON DISK — the seam unwind is gone.

    The local write-phase try/except only unwinds a MID-WRITE crash; an
    invocation-build raise fires after the write phase completed, so the full
    tree persists (§10 no-rollback). The keeper HEAD-gate keeps this
    uncommitted epic invisible to the autopilot until a re-run lands the
    commit. Distinct from the env guard at (a), which fails closed BEFORE any
    write.
    """
    from planctl.ids import scan_max_epic_id

    data_dir = planctl_git_repo / ".planctl"

    import planctl.invocation as _inv

    def _boom(*_a, **_kw):
        raise RuntimeError("synthetic: invocation build blew up post-write")

    # Function-local import in run() resolves the name from the source module at
    # call time, so patching the attribute here takes effect (same mechanism as
    # the integrity-gate spy above).
    monkeypatch.setattr(_inv, "build_planctl_invocation", _boom)

    yaml_path = _write_yaml(planctl_git_repo, _two_task_yaml())
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    # The raise propagated AFTER the write phase, and there is no seam unwind:
    # the full epic + task + spec tree persists on disk. scan_max_epic_id
    # reflects the just-minted id (the tree is real, just uncommitted).
    assert not _no_epics_or_tasks_landed(planctl_git_repo)
    assert scan_max_epic_id(data_dir) >= 1


# ---------------------------------------------------------------------------
# fn-589 task .1 (item 1): stdin support via `--file -`
# ---------------------------------------------------------------------------


def test_scaffold_reads_yaml_from_stdin(planctl_git_repo):
    """`--file -` reads YAML from stdin; envelope is identical to file mode."""
    yaml = _two_task_yaml()
    runner = CliRunner()
    r = runner.invoke(cli, ["scaffold", "--file", "-"], input=yaml)
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    assert payload["success"] is True
    epic_id = payload["epic_id"]
    assert epic_id.startswith("fn-")
    assert payload["task_ids"] == [f"{epic_id}.1", f"{epic_id}.2"]
    # Exactly ONE invocation line, same as file mode.
    assert _count_planctl_invocation_lines(r.output) == 1


def test_scaffold_stdin_byte_cap_enforced(planctl_git_repo):
    """The 1 MiB cap fires on stdin via sys.stdin.buffer.read() pre-decode."""
    # Build a YAML body that comfortably exceeds 1 MiB after the comment fluff.
    big_comment = "# " + ("x" * (1024 * 1024 + 100)) + "\n"
    yaml = big_comment + _two_task_yaml()
    runner = CliRunner()
    r = runner.invoke(cli, ["scaffold", "--file", "-"], input=yaml)
    assert r.exit_code != 0, r.output
    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "bad_yaml"
    assert "exceeds" in env["error"]["message"]


# ---------------------------------------------------------------------------
# Per-task tier (fn-593, hardened by fn-594): planner-chosen reasoning tier
# rides the scaffold YAML through to the persisted task_def. Field is
# REQUIRED on every task entry; valid values are TASK_TIERS = (medium | high
# | xhigh | max). Missing field and unknown value both surface as
# tier_invalid (single bucket); type errors (non-string) surface as bad_yaml.
# Build-forward — no back-compat null default; legacy on-disk null-tier
# records remediate via `/plan:plan <epic_id>` refine.
# ---------------------------------------------------------------------------


def test_scaffold_per_task_tier_persists(planctl_git_repo):
    """Happy path: tier on each task → persisted verbatim on task_def."""
    yaml = f"""\
epic:
  title: per task tier
  spec: |
    ## Overview
    tier per task.
tasks:
  - title: task A
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
  - title: task B
    deps: []
    tier: xhigh
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    epic_id = _parse_envelope(r.output)["epic_id"]
    t1 = json.loads(
        (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.1.json").read_text()
    )
    t2 = json.loads(
        (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.2.json").read_text()
    )
    assert t1["tier"] == "medium"
    assert t2["tier"] == "xhigh"


def test_scaffold_missing_tier_field_rejected(planctl_git_repo):
    """fn-594: omitted `tier:` on a task entry → tier_invalid, no writes land.

    Replaces the prior back-compat test that accepted missing as null —
    scaffold now hard-errors at mint time so keeper's null-tier
    runtime branch can go away (build-forward).
    """
    yaml = f"""\
epic:
  title: missing tier
  spec: |
    ## Overview
    no tier.
tasks:
  - title: only task
    deps: []
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "tier_invalid"
    detail_blob = " ".join(env["error"]["details"])
    assert "missing" in detail_blob, env["error"]["details"]
    # Allowlist surfaced so the planner sees the valid bands.
    for valid in ("medium", "high", "xhigh", "max"):
        assert valid in detail_blob, env["error"]["details"]
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_tier_invalid_value_rejected(planctl_git_repo):
    """Unknown tier value (not in TASK_TIERS) → tier_invalid, no writes land."""
    yaml = f"""\
epic:
  title: bogus tier
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    tier: bogus
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "tier_invalid"
    assert any("'bogus'" in d for d in env["error"]["details"]), env["error"]["details"]
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_tier_low_rejected_with_allowlist_in_message(planctl_git_repo):
    """`low` is a tempting-but-wrong tier name; reject with allowlist in detail."""
    yaml = f"""\
epic:
  title: low tier
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    tier: low
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "tier_invalid"
    # Allowlist surfaced for the planner's debugging convenience.
    detail_blob = " ".join(env["error"]["details"])
    for valid in ("medium", "high", "xhigh", "max"):
        assert valid in detail_blob, env["error"]["details"]
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_tier_non_string_is_bad_yaml(planctl_git_repo):
    """Non-string tier (int / list) is a shape failure → bad_yaml, no writes."""
    yaml = f"""\
epic:
  title: bad tier type
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    tier: 42
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "bad_yaml"
    assert any("`tier` must be a string" in d for d in env["error"]["details"]), env[
        "error"
    ]["details"]
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_tier_all_valid_values_accepted(planctl_git_repo):
    """Every TASK_TIERS member is accepted — proves the allowlist matches the constant."""
    from planctl.models import TASK_TIERS

    tasks_block = "".join(
        f"""  - title: tier task {i}
    deps: []
    tier: {tier}
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
        for i, tier in enumerate(TASK_TIERS, start=1)
    )
    yaml = f"""\
epic:
  title: all tiers
  spec: |
    ## Overview
    all tiers.
tasks:
{tasks_block}"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    epic_id = _parse_envelope(r.output)["epic_id"]
    for i, tier in enumerate(TASK_TIERS, start=1):
        td = json.loads(
            (
                planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.{i}.json"
            ).read_text()
        )
        assert td["tier"] == tier


def test_scaffold_tier_invalid_collects_all_offenders(planctl_git_repo):
    """Collect-all: two invalid tiers in one YAML → both appear in details."""
    yaml = f"""\
epic:
  title: two bad tiers
  spec: |
    ## Overview
    x.
tasks:
  - title: task A
    deps: []
    tier: low
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
  - title: task B
    deps: []
    tier: extreme
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "tier_invalid"
    details = env["error"]["details"]
    assert any("task #1" in d and "'low'" in d for d in details), details
    assert any("task #2" in d and "'extreme'" in d for d in details), details
    assert _no_epics_or_tasks_landed(planctl_git_repo)


# ---------------------------------------------------------------------------
# fn-595: epic.queue_jump rides the planctl_invocation envelope
# ---------------------------------------------------------------------------


def _queue_jump_yaml(value_yaml: str | None) -> str:
    """Build a one-task scaffold YAML, optionally setting epic.queue_jump.

    `value_yaml` is the raw YAML literal (e.g. "true", "false", '"yes"') the
    test wants placed after `queue_jump:`. Passing None omits the key entirely
    so the default-path test is exact.
    """
    queue_line = f"  queue_jump: {value_yaml}\n" if value_yaml is not None else ""
    return f"""\
epic:
  title: queue jump test
{queue_line}  spec: |
    ## Overview
    queue jump.
tasks:
  - title: only task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""


def test_scaffold_queue_jump_true_rides_envelope(planctl_git_repo):
    """epic.queue_jump: true lands queue_jump=true on the emitted envelope."""
    yaml_path = _write_yaml(planctl_git_repo, _queue_jump_yaml("true"))
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    assert payload["success"] is True
    pc = payload["planctl_invocation"]
    assert pc["queue_jump"] is True, pc

    # Also lands on the JSON for consistency (envelope is the authoritative
    # source for keeper's projection, but the JSON carries it too).
    epic_id = payload["epic_id"]
    epic_def = json.loads(
        (planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json").read_text()
    )
    assert epic_def["queue_jump"] is True


def test_scaffold_queue_jump_false_explicit_rides_envelope(planctl_git_repo):
    """epic.queue_jump: false (explicit) lands queue_jump=false on the envelope."""
    yaml_path = _write_yaml(planctl_git_repo, _queue_jump_yaml("false"))
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    assert payload["success"] is True
    pc = payload["planctl_invocation"]
    assert pc["queue_jump"] is False, pc

    epic_id = payload["epic_id"]
    epic_def = json.loads(
        (planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json").read_text()
    )
    assert epic_def["queue_jump"] is False


def test_scaffold_queue_jump_omitted_defaults_false(planctl_git_repo):
    """Omitting epic.queue_jump entirely → envelope still carries queue_jump=false."""
    yaml_path = _write_yaml(planctl_git_repo, _queue_jump_yaml(None))
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    assert payload["success"] is True
    pc = payload["planctl_invocation"]
    # Envelope carries an explicit boolean — not absent.
    assert "queue_jump" in pc
    assert pc["queue_jump"] is False, pc

    epic_id = payload["epic_id"]
    epic_def = json.loads(
        (planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json").read_text()
    )
    assert epic_def["queue_jump"] is False

    # normalize_epic round-trip: a legacy dict missing queue_jump entirely
    # picks up the default on load (mirrors the snippets / bundles precedent).
    from planctl.models import normalize_epic

    legacy = {"id": "fn-1-x", "title": "legacy"}
    normalize_epic(legacy)
    assert legacy["queue_jump"] is False


def test_scaffold_queue_jump_non_bool_is_bad_yaml(planctl_git_repo):
    """epic.queue_jump: "yes" (non-bool) is rejected with bad_yaml and writes nothing."""
    yaml_path = _write_yaml(planctl_git_repo, _queue_jump_yaml('"yes"'))
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "bad_yaml"
    assert any("queue_jump" in d for d in env["error"]["details"]), env["error"][
        "details"
    ]
    assert _no_epics_or_tasks_landed(planctl_git_repo)


# ---------------------------------------------------------------------------
# fn-623: scaffold atomicity + dup guard. The pre-fn-623 code pre-wrote the
# epic spec (and every task spec) to its final path so the integrity check
# could read it; a non-clean exit between that pre-write and the rollback
# orphaned a `specs/fn-N-*.md`, which `scan_max_epic_id` then counted and
# silently advanced the next mint. The fix passes the epic spec to the
# integrity helper in-memory (`epic_spec_content=`), defers every disk
# write until after the gate, and adds a same-slug dup-guard before id
# allocation so a re-scaffold of the same idea hard-errors with
# `duplicate_epic` instead of silently allocating a parallel fn-N.
# ---------------------------------------------------------------------------


def test_scaffold_integrity_failure_leaves_scan_max_unchanged(
    planctl_git_repo, monkeypatch
):
    """Acceptance: a scaffold that fails the integrity gate leaves
    ``scan_max_epic_id`` unchanged AND zero orphaned ``specs/fn-N-*.md``.

    This is the fn-623 regression test — before the fix, scaffold pre-wrote
    the epic spec to its final path so the integrity helper could read it,
    and even though the rollback at integrity-failure time unlinked the
    spec, any non-clean exit between the pre-write and the rollback (or
    just the rollback racing with another reader) could orphan the file.
    The leak then advanced ``scan_max_epic_id`` on the next mint.
    """
    from planctl.ids import scan_max_epic_id

    data_dir = planctl_git_repo / ".planctl"

    # Seed one valid epic so scan_max_epic_id has a non-zero baseline that's
    # easy to assert against (the integrity failure must not advance it past
    # this).
    first_id = _seed_epic(planctl_git_repo, title="atomicity baseline")
    baseline_max = scan_max_epic_id(data_dir)
    assert baseline_max >= 1, f"expected baseline_max >= 1, got {baseline_max}"

    # Patch the integrity helper at its source module so the scaffold-internal
    # function-local import resolves to our spy. Returning an error list
    # forces scaffold's integrity_failed branch.
    import planctl.integrity as _integ

    monkeypatch.setattr(
        _integ,
        "check_epic_tree_in_memory",
        lambda *_, **__: (["synthetic: gate fails"], []),
    )

    yaml_path = _write_yaml(planctl_git_repo, _two_task_yaml())
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "integrity_failed", env["error"]

    # Acceptance (a): scan_max_epic_id is unchanged.
    after_max = scan_max_epic_id(data_dir)
    assert after_max == baseline_max, (
        f"scan_max_epic_id advanced after integrity failure: "
        f"{baseline_max} -> {after_max} (the orphan leak is back)"
    )

    # Acceptance (b): zero orphaned specs/fn-N-*.md. The only spec file that
    # should exist is the one from the seed epic.
    specs_dir = data_dir / "specs"
    orphans = [p for p in specs_dir.glob("fn-*.md") if not p.stem.startswith(first_id)]
    assert not orphans, f"integrity failure left orphan spec files behind: {orphans}"

    # No fresh epic JSON either.
    epic_jsons = [
        p for p in (data_dir / "epics").glob("fn-*.json") if p.stem != first_id
    ]
    assert not epic_jsons, (
        f"integrity failure left orphan epic JSON behind: {epic_jsons}"
    )


def test_scaffold_integrity_failure_writes_no_spec_files_at_all(
    planctl_git_repo, monkeypatch
):
    """Belt-and-suspenders: when integrity fails, neither the epic spec nor
    any task spec lands on disk — the pre-fn-623 rollback path is gone, and
    if it were ever invoked the test would still pass (no files to unlink).
    """
    import planctl.integrity as _integ

    monkeypatch.setattr(
        _integ,
        "check_epic_tree_in_memory",
        lambda *_, **__: (["synthetic: gate fails"], []),
    )

    yaml_path = _write_yaml(planctl_git_repo, _two_task_yaml())
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    # No spec / json files for any fn-N landed.
    assert _no_epics_or_tasks_landed(planctl_git_repo)


def test_scaffold_dup_slug_rejected_with_duplicate_epic(planctl_git_repo):
    """Acceptance: same-slug scaffold returns ``duplicate_epic`` (existing
    id + status in details) unless ``--allow-duplicate`` is set.
    """
    from planctl.ids import scan_max_epic_id

    data_dir = planctl_git_repo / ".planctl"

    first_id = _seed_epic(planctl_git_repo, title="duplicate guard")
    pre_dup_max = scan_max_epic_id(data_dir)

    # Second scaffold with the same title → dup-guard fires.
    yaml = f"""\
epic:
  title: duplicate guard
  spec: |
    ## Overview
    second attempt.
tasks:
  - title: only task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code != 0, r.output

    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "duplicate_epic", env["error"]
    # Existing id + status surfaced in details.
    detail_blob = " ".join(env["error"]["details"])
    assert first_id in detail_blob, env["error"]["details"]
    assert "status:" in detail_blob, env["error"]["details"]

    # Acceptance: the rejected dup did NOT advance scan_max_epic_id (dup
    # guard runs BEFORE id allocation).
    assert scan_max_epic_id(data_dir) == pre_dup_max, (
        "duplicate_epic rejection advanced scan_max_epic_id — the dup guard "
        "must run before id allocation"
    )


def test_scaffold_dup_slug_allow_duplicate_mints_distinct_fn_n(planctl_git_repo):
    """Acceptance: ``--allow-duplicate`` mints a distinct fn-N (same slug,
    different number).
    """
    first_id = _seed_epic(planctl_git_repo, title="allow duplicate")

    yaml = f"""\
epic:
  title: allow duplicate
  spec: |
    ## Overview
    second attempt.
tasks:
  - title: only task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, yaml)
    r = _invoke(["scaffold", "--file", yaml_path, "--allow-duplicate"])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    assert payload["success"] is True
    second_id = payload["epic_id"]
    assert second_id != first_id, (first_id, second_id)
    # Same slug suffix, different number.
    assert second_id.endswith("-allow-duplicate"), second_id
    assert first_id.endswith("-allow-duplicate"), first_id


def test_scaffold_dup_slug_unrelated_slug_unaffected(planctl_git_repo):
    """A different-slug second scaffold proceeds normally (dup guard is
    slug-keyed, not title-keyed)."""
    first_id = _seed_epic(planctl_git_repo, title="first slug")
    second_id = _seed_epic(planctl_git_repo, title="second slug different")
    assert first_id != second_id
    # Slugs are independent.
    assert first_id.endswith("-first-slug")
    assert second_id.endswith("-second-slug-different")


def test_scaffold_dup_slug_suffix_false_positive_regression(planctl_git_repo):
    """fn-624 regression: the dup-guard glob ``fn-*-{slug}.json`` false-matched
    any epic whose slug *ends* with ``-{slug}`` (e.g. existing ``foo-bar``
    siblings poisoned a fresh ``bar`` scaffold via fnmatch suffix semantics).
    The ``re.fullmatch`` post-filter pins exact-slug equivalence so only true
    same-slug siblings fire ``duplicate_epic``.
    """
    # Seed an epic with a multi-segment slug whose tail equals the new slug.
    foo_bar_id = _seed_epic(planctl_git_repo, title="foo bar")
    assert foo_bar_id.endswith("-foo-bar"), foo_bar_id

    # Scaffolding slug `bar` must now succeed — pre-fix, the glob
    # `fn-*-bar.json` matched `fn-<n>-foo-bar.json` and raised
    # ``duplicate_epic`` citing the wrong existing id.
    bar_yaml = f"""\
epic:
  title: bar
  spec: |
    ## Overview
    fresh slug whose tail collides with an existing multi-segment slug.
tasks:
  - title: only task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    yaml_path = _write_yaml(planctl_git_repo, bar_yaml)
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    assert payload["success"] is True
    bar_id = payload["epic_id"]
    assert bar_id.endswith("-bar"), bar_id
    assert not bar_id.endswith("-foo-bar"), bar_id
    assert bar_id != foo_bar_id

    # True-dup still fires: a second `foo bar` scaffold must hit the guard.
    dup_yaml = f"""\
epic:
  title: foo bar
  spec: |
    ## Overview
    second attempt at the multi-segment slug.
tasks:
  - title: only task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    dup_path = _write_yaml(planctl_git_repo, dup_yaml)
    r2 = _invoke(["scaffold", "--file", dup_path])
    assert r2.exit_code != 0, r2.output
    env2 = _parse_envelope(r2.output)
    assert env2["error"]["code"] == "duplicate_epic", env2["error"]
    # The error must cite the foo-bar sibling, not the freshly minted bar epic.
    detail_blob = " ".join(env2["error"]["details"])
    assert foo_bar_id in detail_blob, env2["error"]["details"]
    assert bar_id not in detail_blob, env2["error"]["details"]


def test_scaffold_normal_path_still_succeeds_post_atomicity_fix(planctl_git_repo):
    """End-to-end smoke: a valid scaffold still succeeds + commits the whole
    tree (epic JSON + epic spec + every task JSON + every task spec) after the
    atomicity restructure. Guards against the temp-write / order-of-writes
    refactor breaking the happy path.
    """
    yaml_path = _write_yaml(planctl_git_repo, _two_task_yaml())
    r = _invoke(["scaffold", "--file", yaml_path])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    assert payload["success"] is True
    epic_id = payload["epic_id"]

    # Every expected file landed on disk.
    expected = [
        planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json",
        planctl_git_repo / ".planctl" / "specs" / f"{epic_id}.md",
        planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.1.json",
        planctl_git_repo / ".planctl" / "specs" / f"{epic_id}.1.md",
        planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.2.json",
        planctl_git_repo / ".planctl" / "specs" / f"{epic_id}.2.md",
    ]
    for p in expected:
        assert p.exists(), f"missing post-scaffold file: {p}"

    # Exactly one planctl_invocation envelope (no decorator double-emit).
    assert _count_planctl_invocation_lines(r.output) == 1
