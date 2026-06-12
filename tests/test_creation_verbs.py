"""Engine-agnostic conformance spec for the creation/deletion surface.

The mutating-creation companion to ``tests/test_restamp_verbs.py``: the
executable spec the ``planctl-bun`` port targets for ``scaffold`` /
``refine-apply`` / ``epic rm`` and the net-new machinery beneath them (the
pyyaml-parity YAML input wrapper, the 1 MiB stdin/file cap, the duplicate_epic
flock guard, the epic-rm unlink set). Every assertion is on the emitted
envelope or on ``.planctl/`` files — never on Python internals.

The keystone contract is the ``scaffold`` success envelope
``{epic_id, task_ids, repo_distribution}`` (sorted ``repo_distribution``) that
``conftest.seed_epic`` rides: every fixture-dependent test file in the suite
depends on it being byte-compatible across engines.

The YAML scalar matrix is pinned EMPIRICALLY against the real Python binary
(pyyaml ``safe_load`` is YAML 1.1), not transcribed from pyyaml docs — implicit
typing is version-sensitive:

* norway booleans: ``branch: no`` / ``tier: no`` parse to ``bool`` (not the
  string ``"no"``), so the string guards fire — ``branch`` lands under
  ``bad_yaml`` ("must be a string when present"), ``tier`` under ``bad_yaml``
  ("must be a string") via the coercion-guard-first / type-vs-value fork (a bad
  *string* tier is the distinct ``tier_invalid`` bucket).
* octal ``010`` → int ``8`` and underscore ``1_0`` → int ``10`` in dep ordinal
  position → ``dep_invalid`` out-of-range, with the COERCED integer in the
  message.
* an ISO-date-shaped scalar (``2024-01-01``) parses to a ``date`` → not a string
  → the ``title`` guard fires.
* duplicate keys are silent last-wins (pyyaml does NOT throw; the eemeli wrapper
  must match) — the second ``branch:`` value is what lands on disk.

These run against a real ``.git/`` (scaffold's mint-time integrity gate uses
``check_filesystem_repos=True``), so every test driving a creation/deletion verb
is ``@pytest.mark.integration`` (slow bucket; ``--run-slow``). The gate is green
three ways: the default in-process engine under ``--run-slow``, the Python
binary via ``PLANCTL_BIN=... --run-slow``, and the fast gate unchanged (these
tests skip-visible there). No existing test file is touched.
"""

from __future__ import annotations

import json

import pytest

from .conftest import parse_cli_output, run_cli

# ---------------------------------------------------------------------------
# Helpers — disk + envelope, no Python internals.
# ---------------------------------------------------------------------------

_VALID_TASK_SPEC = """\
## Description
Implement the thing.

## Acceptance
- [ ] It works.

## Done summary

## Evidence
"""


def _indent(text: str, n: int) -> str:
    prefix = " " * n
    return "\n".join(prefix + line if line else "" for line in text.splitlines())


def _write_yaml(tmp_path, content: str) -> str:
    path = tmp_path / "plan.yaml"
    path.write_text(content, encoding="utf-8")
    return str(path)


def _scaffold_yaml(
    *, epic_extra: str = "", tier: str = "medium", deps: str = "[]"
) -> str:
    """One epic + one task. ``epic_extra`` injects extra epic-node lines
    (already 2-space indented). ``tier`` / ``deps`` are written verbatim into
    the single task so the YAML scalar matrix can exercise their parse path."""
    return f"""\
epic:
  title: creation matrix
{epic_extra}  spec: |
    ## Overview
    A creation-verb conformance fixture.
tasks:
  - title: First task
    deps: {deps}
    tier: {tier}
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""


def _scaffold(tmp_path, yaml: str):
    return run_cli(["scaffold", "--file", _write_yaml(tmp_path, yaml)])


def _epic_def(tmp_path, epic_id: str) -> dict:
    p = tmp_path / ".planctl" / "epics" / f"{epic_id}.json"
    return json.loads(p.read_text(encoding="utf-8"))


# ===========================================================================
# Keystone: the scaffold success envelope seed_epic rides.
# ===========================================================================


@pytest.mark.integration
def test_scaffold_success_envelope_keystone(planctl_git_repo):
    """The {epic_id, task_ids, repo_distribution} contract every
    fixture-dependent file depends on, with repo_distribution a sorted counter
    object keyed by repo path."""
    yaml = f"""\
epic:
  title: keystone epic
  spec: |
    ## Overview
    keystone.
tasks:
  - title: First task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
  - title: Second task
    deps: [1]
    tier: high
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    r = _scaffold(planctl_git_repo, yaml)
    assert r.exit_code == 0, r.output
    payload = parse_cli_output(r.output)

    assert payload["success"] is True
    epic_id = payload["epic_id"]
    assert epic_id.startswith("fn-")
    assert payload["task_ids"] == [f"{epic_id}.1", f"{epic_id}.2"]

    repo_dist = payload["repo_distribution"]
    assert isinstance(repo_dist, dict)
    assert sum(repo_dist.values()) == 2
    # Sorted counter: keys emitted in sorted order.
    assert list(repo_dist) == sorted(repo_dist)
    # The repo the tasks landed in is the primary repo.
    assert str(planctl_git_repo) in {str(k) for k in repo_dist} or any(
        str(planctl_git_repo).endswith(str(k).lstrip("/")) for k in repo_dist
    )


# ===========================================================================
# YAML scalar divergence matrix — pinned empirically (pyyaml safe_load 1.1).
# ===========================================================================


@pytest.mark.integration
def test_yaml_norway_boolean_branch_is_bad_yaml(planctl_git_repo):
    """`branch: no` parses to bool False (norway), tripping the string guard."""
    r = _scaffold(planctl_git_repo, _scaffold_yaml(epic_extra="  branch: no\n"))
    assert r.exit_code != 0
    env = parse_cli_output(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "bad_yaml"
    assert env["error"]["details"] == ["epic: `branch` must be a string when present"]


@pytest.mark.integration
def test_yaml_norway_boolean_tier_is_bad_yaml_not_tier_invalid(planctl_git_repo):
    """`tier: no` → bool → the type guard (bad_yaml `must be a string`), NOT the
    value guard tier_invalid. This is the coercion-guard-first / type-vs-value
    fork: a non-string tier is bad_yaml, a bad-string tier is tier_invalid."""
    r = _scaffold(planctl_git_repo, _scaffold_yaml(tier="no"))
    assert r.exit_code != 0
    env = parse_cli_output(r.output)
    assert env["error"]["code"] == "bad_yaml"
    assert env["error"]["details"] == ["task #1: `tier` must be a string"]


@pytest.mark.integration
def test_yaml_bad_string_tier_is_tier_invalid(planctl_git_repo):
    """A genuine string tier outside TASK_TIERS is the value bucket
    (tier_invalid) — the other arm of the type-vs-value fork."""
    r = _scaffold(planctl_git_repo, _scaffold_yaml(tier="ultrahigh"))
    assert r.exit_code != 0
    env = parse_cli_output(r.output)
    assert env["error"]["code"] == "tier_invalid"
    assert env["error"]["details"] == [
        "task #1: `tier` 'ultrahigh' is not one of medium, high, xhigh, max"
    ]


@pytest.mark.integration
def test_yaml_octal_dep_ordinal_coerces_to_decimal(planctl_git_repo):
    """`deps: [010]` → pyyaml octal → int 8 → dep_invalid out-of-range, with the
    COERCED integer (8, not 010) in the message."""
    r = _scaffold(planctl_git_repo, _scaffold_yaml(deps="[010]"))
    assert r.exit_code != 0
    env = parse_cli_output(r.output)
    assert env["error"]["code"] == "dep_invalid"
    assert env["error"]["details"] == [
        "task #1: dep ordinal 8 out of range (must be 1..1)"
    ]


@pytest.mark.integration
def test_yaml_underscore_dep_ordinal_coerces_to_decimal(planctl_git_repo):
    """`deps: [1_0]` → pyyaml underscore numeric → int 10 → dep_invalid, with 10
    (not 1_0) in the message."""
    r = _scaffold(planctl_git_repo, _scaffold_yaml(deps="[1_0]"))
    assert r.exit_code != 0
    env = parse_cli_output(r.output)
    assert env["error"]["code"] == "dep_invalid"
    assert env["error"]["details"] == [
        "task #1: dep ordinal 10 out of range (must be 1..1)"
    ]


@pytest.mark.integration
def test_yaml_iso_date_title_is_not_a_string(planctl_git_repo):
    """An ISO-date-shaped title scalar parses to a date object → fails the
    non-empty-string guard."""
    yaml = f"""\
epic:
  title: 2024-01-01
  spec: |
    ## Overview
    iso date title.
tasks:
  - title: First task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    r = _scaffold(planctl_git_repo, yaml)
    assert r.exit_code != 0
    env = parse_cli_output(r.output)
    assert env["error"]["code"] == "bad_yaml"
    assert env["error"]["details"] == ["epic: `title` must be a non-empty string"]


@pytest.mark.integration
def test_yaml_duplicate_key_silent_last_wins(planctl_git_repo):
    """pyyaml does NOT throw on duplicate keys (js-yaml default does); the SECOND
    `branch:` value silently wins and lands on disk as branch_name."""
    yaml = f"""\
epic:
  title: dup key matrix
  branch: feat-first
  branch: feat-second
  spec: |
    ## Overview
    duplicate key.
tasks:
  - title: First task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    r = _scaffold(planctl_git_repo, yaml)
    assert r.exit_code == 0, r.output
    epic_id = parse_cli_output(r.output)["epic_id"]
    assert _epic_def(planctl_git_repo, epic_id)["branch_name"] == "feat-second"


# ===========================================================================
# Gap cases: duplicate_epic guard + --allow-duplicate escape hatch.
# ===========================================================================


@pytest.mark.integration
def test_duplicate_epic_guard_details_shape(planctl_git_repo):
    """A second scaffold of the same title (same slug) hard-errors with
    duplicate_epic; details name the existing id + status, zero writes."""
    yaml = _scaffold_yaml()  # title: creation matrix → slug creation-matrix
    first = _scaffold(planctl_git_repo, yaml)
    assert first.exit_code == 0, first.output
    existing_id = parse_cli_output(first.output)["epic_id"]

    second = _scaffold(planctl_git_repo, yaml)
    assert second.exit_code != 0
    env = parse_cli_output(second.output)
    assert env["error"]["code"] == "duplicate_epic"
    assert env["error"]["details"] == [f"{existing_id} (status: open)"]
    # No second epic minted: epics dir holds exactly the one.
    epics = list((planctl_git_repo / ".planctl" / "epics").glob("fn-*.json"))
    assert len(epics) == 1


@pytest.mark.integration
def test_allow_duplicate_mints_distinct_fn_n(planctl_git_repo):
    """--allow-duplicate skips the guard and mints a distinct fn-N with the same
    slug."""
    yaml = _scaffold_yaml()
    first = _scaffold(planctl_git_repo, yaml)
    assert first.exit_code == 0, first.output
    first_id = parse_cli_output(first.output)["epic_id"]

    r = run_cli(
        ["scaffold", "--file", _write_yaml(planctl_git_repo, yaml), "--allow-duplicate"]
    )
    assert r.exit_code == 0, r.output
    second_id = parse_cli_output(r.output)["epic_id"]
    assert second_id != first_id
    # Same slug stem, distinct ordinal.
    assert first_id.split("-", 2)[2] == second_id.split("-", 2)[2]


# ===========================================================================
# Gap cases: the 1 MiB cap message with its truncated-read byte count.
# ===========================================================================


@pytest.mark.integration
def test_scaffold_file_cap_reports_full_byte_count(planctl_git_repo):
    """A >1 MiB --file is read whole, so the cap message carries the ACTUAL
    file size (got M where M == real length)."""
    over = 1024 * 1024 + 50
    big = planctl_git_repo / "big.yaml"
    big.write_text("# " + "x" * (over - 2), encoding="utf-8")
    r = run_cli(["scaffold", "--file", str(big)])
    assert r.exit_code != 0
    env = parse_cli_output(r.output)
    assert env["error"]["code"] == "bad_yaml"
    assert env["error"]["message"] == f"YAML file exceeds 1048576 bytes (got {over})"
    assert env["error"]["details"] == [f"file: {big}"]


@pytest.mark.integration
def test_scaffold_stdin_cap_reports_truncated_read_count(planctl_git_repo):
    """`--file -` reads MAX+1 bytes (chunked, reject-don't-truncate), so the cap
    message reports the truncated-read count 1048577 regardless of how many bytes
    were actually piped, with details ['file: -']."""
    payload = "# " + "x" * (1024 * 1024 + 500)
    r = run_cli(["scaffold", "--file", "-"], input_text=payload)
    assert r.exit_code != 0
    env = parse_cli_output(r.output)
    assert env["error"]["code"] == "bad_yaml"
    assert env["error"]["message"] == "YAML file exceeds 1048576 bytes (got 1048577)"
    assert env["error"]["details"] == ["file: -"]


# ===========================================================================
# Gap cases: refine-apply delta parse + stdin cap.
# ===========================================================================


@pytest.mark.integration
def test_refine_apply_empty_delta_is_bad_yaml(planctl_git_repo):
    """An empty delta (no epic.spec / add_tasks / rewrite_specs / rewire_deps) is
    bad_yaml with empty details."""
    first = _scaffold(planctl_git_repo, _scaffold_yaml())
    assert first.exit_code == 0, first.output
    epic_id = parse_cli_output(first.output)["epic_id"]

    delta = planctl_git_repo / "delta.yaml"
    delta.write_text("epic: {}\n", encoding="utf-8")
    r = run_cli(["refine-apply", epic_id, "--file", str(delta)])
    assert r.exit_code != 0
    env = parse_cli_output(r.output)
    assert env["error"]["code"] == "bad_yaml"
    assert env["error"]["message"].startswith("Delta is empty")
    assert env["error"]["details"] == []


@pytest.mark.integration
def test_refine_apply_stdin_cap_reports_truncated_read_count(planctl_git_repo):
    """refine-apply shares the scaffold cap wrapper: a >1 MiB stdin delta caps at
    the same truncated-read count with details ['file: -']."""
    first = _scaffold(planctl_git_repo, _scaffold_yaml())
    assert first.exit_code == 0, first.output
    epic_id = parse_cli_output(first.output)["epic_id"]

    payload = "# " + "x" * (1024 * 1024 + 500)
    r = run_cli(["refine-apply", epic_id, "--file", "-"], input_text=payload)
    assert r.exit_code != 0
    env = parse_cli_output(r.output)
    assert env["error"]["code"] == "bad_yaml"
    assert env["error"]["message"] == "YAML file exceeds 1048576 bytes (got 1048577)"
    assert env["error"]["details"] == ["file: -"]


# ===========================================================================
# Gap cases: epic rm --dry-run (preview, zero writes) + --force (live override).
# ===========================================================================


@pytest.mark.integration
def test_epic_rm_dry_run_previews_without_writing(planctl_git_repo):
    """--dry-run emits {dry_run: true} with the full unlink set, leaves every
    file on disk, and writes no commit."""
    first = _scaffold(planctl_git_repo, _scaffold_yaml())
    assert first.exit_code == 0, first.output
    epic_id = parse_cli_output(first.output)["epic_id"]

    head_before = _head_sha(planctl_git_repo)
    r = run_cli(["epic", "rm", epic_id, "--dry-run"])
    assert r.exit_code == 0, r.output
    env = parse_cli_output(r.output)
    assert env["dry_run"] is True
    assert env["epic_id"] == epic_id
    assert env["task_count"] == 1
    removed = set(env["removed_files"])
    assert f".planctl/epics/{epic_id}.json" in removed
    assert f".planctl/specs/{epic_id}.md" in removed
    assert f".planctl/specs/{epic_id}.1.md" in removed
    assert f".planctl/tasks/{epic_id}.1.json" in removed

    # Files intact, no commit.
    assert (planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json").exists()
    assert (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.1.json").exists()
    assert _head_sha(planctl_git_repo) == head_before


@pytest.mark.integration
def test_epic_rm_live_lock_blocks_without_force(planctl_git_repo):
    """A held lock file (state/locks/<id>.M.lock) marks the task live; rm refuses
    without --force and names the locked task."""
    first = _scaffold(planctl_git_repo, _scaffold_yaml())
    assert first.exit_code == 0, first.output
    epic_id = parse_cli_output(first.output)["epic_id"]

    locks = planctl_git_repo / ".planctl" / "state" / "locks"
    locks.mkdir(parents=True, exist_ok=True)
    (locks / f"{epic_id}.1.lock").write_text("held", encoding="utf-8")

    r = run_cli(["epic", "rm", epic_id])
    assert r.exit_code != 0
    env = parse_cli_output(r.output)
    assert env["success"] is False
    assert f"{epic_id}.1 (locked)" in env["error"]
    # Epic still present — the guard fired before any unlink.
    assert (planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json").exists()


@pytest.mark.integration
def test_epic_rm_force_overrides_live_lock(planctl_git_repo):
    """--force short-circuits the live-work check and removes the tree even with a
    held lock."""
    first = _scaffold(planctl_git_repo, _scaffold_yaml())
    assert first.exit_code == 0, first.output
    epic_id = parse_cli_output(first.output)["epic_id"]

    locks = planctl_git_repo / ".planctl" / "state" / "locks"
    locks.mkdir(parents=True, exist_ok=True)
    (locks / f"{epic_id}.1.lock").write_text("held", encoding="utf-8")

    r = run_cli(["epic", "rm", epic_id, "--force"])
    assert r.exit_code == 0, r.output
    env = parse_cli_output(r.output)
    assert env["success"] is True
    assert env["epic_id"] == epic_id
    assert not (planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json").exists()
    assert not (planctl_git_repo / ".planctl" / "tasks" / f"{epic_id}.1.json").exists()


def _head_sha(repo) -> str:
    import subprocess

    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
