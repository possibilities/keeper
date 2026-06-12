"""Tests for planctl task set-tier — worker reasoning tier persistence.

Mutating verbs resolve the session id from CLAUDE_CODE_SESSION_ID; these
tests set it explicitly.

Cases:
- normalize_task: legacy task missing `tier` gets null default; existing value preserved.
- Happy path: set-tier `medium` writes the field on the task JSON.
- Round-trip: warm-write `medium` → cold-read returns `medium` (not xhigh).
- Fallback: tier null → cold-resume falls through to the Phase 3c heuristic.
- Validation: invalid tier rejected.
- Validation: NOT in VALIDATION_RESTAMP_VERBS — set-tier is runtime, not structural.
"""

from __future__ import annotations

import contextlib
import json

from planctl.models import normalize_task

from .conftest import run_cli
from planctl.validation_restamp import VALIDATION_RESTAMP_VERBS

_ENV = {"CLAUDE_CODE_SESSION_ID": "test-task-set-tier-fixture"}


def _create_project(tmp_path, monkeypatch):
    """Init a planctl project under a fresh git repo."""
    import subprocess

    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-task-set-tier-fixture")
    monkeypatch.chdir(tmp_path)
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    result = run_cli(["init"], env=_ENV)
    assert result.exit_code == 0, result.output
    return tmp_path


def _invoke(args: list[str]) -> tuple[int, dict | None, str]:
    """Run a CLI command and return (exit_code, parsed_envelope, raw_output).

    `planctl show` emits a multi-line pretty-printed JSON envelope (when format
    is JSON, which is the default), followed by a one-line `planctl_invocation`
    NDJSON envelope. The mutating verbs in this file all emit compact one-line
    envelopes. Parse the FIRST `{...}` document in stdout that does not start
    with `{"planctl_invocation"` — works for both shapes.
    """
    result = run_cli(args, env=_ENV)
    obj = _first_envelope(result.output)
    return result.exit_code, obj, result.output


def _first_envelope(output: str) -> dict | None:
    """Return the first JSON object in *output* that is NOT a planctl_invocation
    envelope. Tolerates both compact one-line and pretty-printed multi-line
    JSON. Skips a leading OSC-8 hyperlink prelude if any tool injected one.
    """
    decoder = json.JSONDecoder()
    text = output
    # Find every `{` candidate and try to decode from there.
    i = 0
    while i < len(text):
        if text[i] == "{":
            with contextlib.suppress(json.JSONDecodeError):
                obj, end = decoder.raw_decode(text[i:])
                # Skip the planctl_invocation NDJSON wrapper.
                if (
                    isinstance(obj, dict)
                    and "planctl_invocation" in obj
                    and len(obj) == 1
                ):
                    i += end
                    continue
                return obj
        i += 1
    return None


def _read_task(project_path, task_id) -> dict:
    task_path = project_path / ".planctl" / "tasks" / f"{task_id}.json"
    return json.loads(task_path.read_text())


def _make_epic_with_task():
    from pathlib import Path

    from .conftest import seed_epic

    epic_id, task_ids = seed_epic(Path.cwd(), title="Tier epic", n_tasks=1, env=_ENV)
    return epic_id, task_ids[0]


# ---------------------------------------------------------------------------
# normalize_task — null default + grandfather
# ---------------------------------------------------------------------------


def test_normalize_task_adds_null_tier_on_legacy():
    """Legacy task dict missing `tier` gets null default."""
    data = {"id": "fn-1-test.1", "epic": "fn-1-test", "title": "Task"}
    normalize_task(data)
    assert "tier" in data
    assert data["tier"] is None


def test_normalize_task_preserves_existing_tier():
    """normalize_task does not overwrite an existing tier."""
    data = {"tier": "medium"}
    normalize_task(data)
    assert data["tier"] == "medium"


# ---------------------------------------------------------------------------
# Happy path: set-tier writes the field
# ---------------------------------------------------------------------------


def test_set_tier_writes_medium(tmp_path, monkeypatch):
    """planctl task set-tier --tier medium writes `tier=medium` on the task JSON.

    scaffold requires tier at mint time and the conftest helper writes
    `tier: medium` by default. Hand-null the persisted task_def to simulate a
    legacy record, then verify set-tier overwrites null → medium.
    """
    _create_project(tmp_path, monkeypatch)
    _, task_id = _make_epic_with_task()

    # Hand-null the task to simulate a legacy on-disk record.
    task_path = tmp_path / ".planctl" / "tasks" / f"{task_id}.json"
    task_def = json.loads(task_path.read_text(encoding="utf-8"))
    task_def["tier"] = None
    task_path.write_text(json.dumps(task_def), encoding="utf-8")

    before = _read_task(tmp_path, task_id)
    # Hand-nulled to simulate legacy state.
    assert before.get("tier") in (None,)

    code, obj, output = _invoke(["task", "set-tier", task_id, "--tier", "medium"])
    assert code == 0, f"set-tier failed:\n{output}"
    assert obj is not None
    assert obj.get("task_id") == task_id
    assert obj.get("tier") == "medium"

    after = _read_task(tmp_path, task_id)
    assert after.get("tier") == "medium"


def test_set_tier_overwrites_existing(tmp_path, monkeypatch):
    """set-tier overwrites a previously-set tier."""
    _create_project(tmp_path, monkeypatch)
    _, task_id = _make_epic_with_task()

    code, _, output = _invoke(["task", "set-tier", task_id, "--tier", "medium"])
    assert code == 0, output
    code, _, output = _invoke(["task", "set-tier", task_id, "--tier", "xhigh"])
    assert code == 0, output

    after = _read_task(tmp_path, task_id)
    assert after.get("tier") == "xhigh"


# ---------------------------------------------------------------------------
# Round-trip: warm-write → cold-read returns the same value
# ---------------------------------------------------------------------------


def test_warm_write_cold_read_round_trip(tmp_path, monkeypatch):
    """Warm Phase 3c writes `medium`; cold Phase 3d reads it back via show.

    Pins the cold-resume contract: the persisted tier survives across
    invocations so the cold path does not silently re-derive to xhigh.
    """
    _create_project(tmp_path, monkeypatch)
    _, task_id = _make_epic_with_task()

    # Warm path writes the chosen tier.
    code, _, output = _invoke(["task", "set-tier", task_id, "--tier", "medium"])
    assert code == 0, output

    # Cold path re-reads via `planctl show` — this is what the skill template
    # uses (`planctl show <task_id> --format json | jq -r '.task.tier // empty'`).
    code, obj, output = _invoke(["show", task_id])
    assert code == 0, output
    assert obj is not None
    task = obj.get("task") or obj
    assert task.get("tier") == "medium", (
        f"cold-read got {task.get('tier')!r}, expected 'medium' — "
        "warm→cold round-trip broken"
    )


# ---------------------------------------------------------------------------
# Fallback: tier null → cold path falls through to the heuristic
# ---------------------------------------------------------------------------


def test_tier_null_triggers_heuristic_fallback(tmp_path, monkeypatch):
    """A legacy task with persisted tier=null still surfaces null
    via `planctl show` so /plan:work's cold-resume can branch on the missing
    tier signal.

    scaffold requires tier at mint time, so the only path to a null-tier
    on-disk record is a legacy task. Hand-null the persisted task_def to
    recreate that state, then confirm `show` returns
    `tier: null` cleanly (the runtime contract keeper and skill
    consumers branch on).
    """
    _create_project(tmp_path, monkeypatch)
    _, task_id = _make_epic_with_task()

    # Hand-null to simulate a legacy on-disk record.
    task_path = tmp_path / ".planctl" / "tasks" / f"{task_id}.json"
    task_def = json.loads(task_path.read_text(encoding="utf-8"))
    task_def["tier"] = None
    task_path.write_text(json.dumps(task_def), encoding="utf-8")

    code, obj, output = _invoke(["show", task_id])
    assert code == 0, output
    assert obj is not None
    task = obj.get("task") or obj
    assert task.get("tier") is None, (
        "hand-nulled legacy task should surface tier=null via show so "
        "/plan:work's cold-resume can branch on it"
    )


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


def test_set_tier_rejects_invalid_tier(tmp_path, monkeypatch):
    """An out-of-vocabulary tier is rejected by Click's choice validator."""
    _create_project(tmp_path, monkeypatch)
    _, task_id = _make_epic_with_task()

    code, _, output = _invoke(["task", "set-tier", task_id, "--tier", "ultra"])
    assert code != 0
    # Click's Choice validator surfaces the value as invalid.
    assert "invalid" in output.lower() or "ultra" in output.lower()


def test_set_tier_unknown_task_errors(tmp_path, monkeypatch):
    """set-tier on a non-existent task fails non-zero with a 'not found' message."""
    _create_project(tmp_path, monkeypatch)
    code, _, output = _invoke(
        ["task", "set-tier", "fn-9999-no-task.1", "--tier", "medium"]
    )
    assert code != 0
    assert "not found" in output.lower() or "fn-9999" in output


def test_set_tier_invalid_id_type_errors(tmp_path, monkeypatch):
    """Setting tier on an epic id (not a task id) fails-visibly."""
    _create_project(tmp_path, monkeypatch)
    epic_id, _ = _make_epic_with_task()
    code, _, output = _invoke(["task", "set-tier", epic_id, "--tier", "medium"])
    assert code != 0
    assert "invalid" in output.lower()


# ---------------------------------------------------------------------------
# VALIDATION_RESTAMP_VERBS — set-tier is runtime, not structural
# ---------------------------------------------------------------------------


def test_set_tier_not_in_validation_restamp_verbs():
    """task set-tier must NOT be in VALIDATION_RESTAMP_VERBS.

    set-tier is a runtime detail (which reasoning effort the cold-resume
    spawns the worker with) — it does not change task/dep/spec structure,
    so it must NOT re-stamp `last_validated_at` on the parent epic.
    """
    assert "task-set-tier" not in VALIDATION_RESTAMP_VERBS, (
        "'task-set-tier' must not appear in VALIDATION_RESTAMP_VERBS — "
        "it's a runtime detail, not a structural change"
    )
    assert "set-tier" not in VALIDATION_RESTAMP_VERBS, (
        "'set-tier' must not appear in VALIDATION_RESTAMP_VERBS — "
        "it's a runtime detail, not a structural change"
    )


# ---------------------------------------------------------------------------
# Envelope shape
# ---------------------------------------------------------------------------


def test_set_tier_envelope_carries_planctl_invocation(tmp_path, monkeypatch):
    """The CLI envelope includes a planctl_invocation payload with op=task-set-tier."""
    _create_project(tmp_path, monkeypatch)
    _, task_id = _make_epic_with_task()
    result = run_cli(
        ["task", "set-tier", task_id, "--tier", "medium"],
        env=_ENV,
    )
    assert result.exit_code == 0
    assert '"planctl_invocation"' in result.output
    # The op should be task-set-tier.
    assert '"task-set-tier"' in result.output or "task-set-tier" in result.output
