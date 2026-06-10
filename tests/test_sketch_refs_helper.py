"""Tests for `planctl.sketch_refs.inline_sketch_refs_batch`.

The helper shells `promptctl inline-sketch-refs`, parses the per-slot JSON
array, and maps each slot to either a `_OkSlot` or a `SketchRefError`.
Distinct error modes (fail-visibly contract):

- ref-level failure → returned as a `SketchRefError` slot
- tooling failure (spawn / non-zero / timeout / non-JSON / malformed
  envelope) → raised as `SketchToolingError`

The 4-path integration is covered end-to-end by
`test_cross_project_sketch_inline.py` (spawns a real promptctl subprocess).
This file fakes `subprocess.run` so we can exercise the tooling-failure
branches without depending on the verb's wiring or the user's PATH.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import pytest
from planctl.sketch_refs import (
    SketchRefError,
    SketchToolingError,
    _OkSlot,
    inline_sketch_refs_batch,
)


class _FakeProc:
    """Mimic the bits of CompletedProcess `inline_sketch_refs_batch` reads."""

    def __init__(self, *, returncode: int, stdout: str, stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _patch_subprocess_run(
    monkeypatch: pytest.MonkeyPatch,
    handler: Any,
) -> list[dict[str, Any]]:
    """Replace `subprocess.run` in `planctl.sketch_refs`; record each call."""
    calls: list[dict[str, Any]] = []

    def _fake_run(argv: list[str], **kwargs: Any) -> _FakeProc:
        calls.append({"argv": argv, "kwargs": kwargs})
        return handler(argv, kwargs)

    monkeypatch.setattr("planctl.sketch_refs.subprocess.run", _fake_run)
    return calls


# ---------------------------------------------------------------------------
# Happy path — verb argv / cwd / stdin shape, per-slot routing
# ---------------------------------------------------------------------------


def test_argv_and_cwd_use_project_root_explicit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls = _patch_subprocess_run(
        monkeypatch,
        lambda argv, kw: _FakeProc(
            returncode=0,
            stdout='[{"remaining_bundles": [], "merged_snippets": []}]',
        ),
    )

    result = inline_sketch_refs_batch(
        [{"bundles": ["sketch/x"], "snippets": []}], project_root=tmp_path
    )
    assert len(result) == 1
    assert isinstance(result[0], _OkSlot)

    assert len(calls) == 1
    call = calls[0]
    # Literal argv shape — matches lint's SUBPROCESS_EXEMPTIONS expectation.
    assert call["argv"] == [
        "promptctl",
        "inline-sketch-refs",
        "--project-root",
        str(tmp_path),
    ]
    # cwd is the project root (not inherited).
    assert call["kwargs"]["cwd"] == str(tmp_path)
    # stdin carries the JSON-encoded groups payload.
    assert call["kwargs"]["input"] == '[{"bundles": ["sketch/x"], "snippets": []}]'
    # encoding pinned to utf-8; check=False; capture_output set.
    assert call["kwargs"]["encoding"] == "utf-8"
    assert call["kwargs"]["check"] is False
    assert call["kwargs"]["capture_output"] is True
    # Timeout set so a hung promptctl surfaces as a tooling failure.
    assert call["kwargs"]["timeout"] > 0


def test_ok_slot_carries_remaining_and_merged(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_subprocess_run(
        monkeypatch,
        lambda argv, kw: _FakeProc(
            returncode=0,
            stdout=(
                '[{"remaining_bundles": ["bundle/keep"], '
                '"merged_snippets": ["a", "b"]}]'
            ),
        ),
    )
    result = inline_sketch_refs_batch(
        [{"bundles": ["sketch/x"], "snippets": ["a"]}], project_root=tmp_path
    )
    slot = result[0]
    assert isinstance(slot, _OkSlot)
    assert slot.remaining_bundles == ["bundle/keep"]
    assert slot.merged_snippets == ["a", "b"]


def test_error_slot_returned_as_sketch_ref_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_subprocess_run(
        monkeypatch,
        lambda argv, kw: _FakeProc(
            returncode=0,
            stdout=(
                '[{"error": "ref_invalid", "ref": "sketch/nope", '
                '"reason": "sketch file not found"}]'
            ),
        ),
    )
    result = inline_sketch_refs_batch(
        [{"bundles": ["sketch/nope"], "snippets": []}], project_root=tmp_path
    )
    slot = result[0]
    assert isinstance(slot, SketchRefError)
    # Two-attr contract identical to legacy SketchResolutionError so the
    # caller's existing error envelopes stay byte-identical.
    assert slot.ref == "sketch/nope"
    assert slot.reason == "sketch file not found"


def test_mixed_slots_each_get_their_own_shape(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_subprocess_run(
        monkeypatch,
        lambda argv, kw: _FakeProc(
            returncode=0,
            stdout=(
                "["
                '{"remaining_bundles": [], "merged_snippets": ["from-good"]},'
                '{"error": "ref_invalid", "ref": "sketch/bad", "reason": "missing"},'
                '{"remaining_bundles": ["bundle/x"], "merged_snippets": []}'
                "]"
            ),
        ),
    )
    result = inline_sketch_refs_batch(
        [
            {"bundles": ["sketch/good"], "snippets": []},
            {"bundles": ["sketch/bad"], "snippets": []},
            {"bundles": ["bundle/x"], "snippets": []},
        ],
        project_root=tmp_path,
    )
    assert isinstance(result[0], _OkSlot)
    assert isinstance(result[1], SketchRefError)
    assert isinstance(result[2], _OkSlot)
    assert result[1].ref == "sketch/bad"
    assert result[2].remaining_bundles == ["bundle/x"]


# ---------------------------------------------------------------------------
# Sketch-free fast path — no subprocess spawn, local pass-through + dedup
# ---------------------------------------------------------------------------


def test_no_sketch_ref_skips_subprocess(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A batch with no ``sketch/`` ref must NOT spawn promptctl.

    ``inline-sketch-refs`` only acts on ``sketch/`` refs, so for sketch-free
    input the ~240ms interpreter spawn is pure overhead. The helper replicates
    the verb's pass-through locally and skips it.
    """
    calls = _patch_subprocess_run(
        monkeypatch,
        lambda argv, kw: pytest.fail("subprocess must not run for sketch-free input"),
    )
    result = inline_sketch_refs_batch(
        [
            {"bundles": ["bundle/keep", "bundle/x/y"], "snippets": ["a", "b"]},
            {"bundles": [], "snippets": []},
        ],
        project_root=tmp_path,
    )
    assert calls == []
    assert isinstance(result[0], _OkSlot)
    # bundle/ refs pass through verbatim, order preserved.
    assert result[0].remaining_bundles == ["bundle/keep", "bundle/x/y"]
    assert result[0].merged_snippets == ["a", "b"]
    assert isinstance(result[1], _OkSlot)
    assert result[1].remaining_bundles == []
    assert result[1].merged_snippets == []


def test_fast_path_dedups_snippets_first_seen(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The sole transform on a sketch-free group is a first-seen snippet dedup,
    matching ``promptctl.api.inline_sketch_refs``'s ``_push`` semantics."""
    _patch_subprocess_run(
        monkeypatch,
        lambda argv, kw: pytest.fail("subprocess must not run for sketch-free input"),
    )
    result = inline_sketch_refs_batch(
        [{"bundles": ["bundle/x"], "snippets": ["a", "b", "a", "c", "b"]}],
        project_root=tmp_path,
    )
    slot = result[0]
    assert isinstance(slot, _OkSlot)
    assert slot.merged_snippets == ["a", "b", "c"]


def test_any_sketch_ref_in_batch_still_spawns(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """One ``sketch/`` ref anywhere in the batch routes the WHOLE batch to the
    real verb — resolution stays single-sourced in promptctl, never split."""
    calls = _patch_subprocess_run(
        monkeypatch,
        lambda argv, kw: _FakeProc(
            returncode=0,
            stdout=(
                "["
                '{"remaining_bundles": [], "merged_snippets": []},'
                '{"remaining_bundles": ["bundle/x"], "merged_snippets": []}'
                "]"
            ),
        ),
    )
    inline_sketch_refs_batch(
        [
            {"bundles": ["sketch/x"], "snippets": []},
            {"bundles": ["bundle/x"], "snippets": []},
        ],
        project_root=tmp_path,
    )
    assert len(calls) == 1


# ---------------------------------------------------------------------------
# Tooling failures — each surfaces as SketchToolingError (fail-visibly)
# ---------------------------------------------------------------------------


def test_spawn_oserror_raises_tooling_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def _raise(*_a: Any, **_kw: Any) -> _FakeProc:
        raise FileNotFoundError("promptctl not on PATH")

    monkeypatch.setattr("planctl.sketch_refs.subprocess.run", _raise)
    with pytest.raises(SketchToolingError) as exc_info:
        inline_sketch_refs_batch(
            [{"bundles": ["sketch/x"], "snippets": []}], project_root=tmp_path
        )
    assert "failed to spawn" in str(exc_info.value)


def test_non_zero_exit_raises_tooling_error_with_stderr(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_subprocess_run(
        monkeypatch,
        lambda argv, kw: _FakeProc(
            returncode=2,
            stdout="",
            stderr='{"success": false, "error": "stdin is empty"}\n',
        ),
    )
    with pytest.raises(SketchToolingError) as exc_info:
        inline_sketch_refs_batch(
            [{"bundles": ["sketch/x"], "snippets": []}], project_root=tmp_path
        )
    assert "exited 2" in str(exc_info.value)
    assert "stdin is empty" in exc_info.value.stderr


def test_timeout_raises_tooling_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def _raise(argv: list[str], **kw: Any) -> _FakeProc:
        raise subprocess.TimeoutExpired(cmd=argv, timeout=0.001)

    monkeypatch.setattr("planctl.sketch_refs.subprocess.run", _raise)
    with pytest.raises(SketchToolingError) as exc_info:
        inline_sketch_refs_batch(
            [{"bundles": ["sketch/x"], "snippets": []}], project_root=tmp_path
        )
    assert "timeout" in str(exc_info.value).lower()


def test_non_json_stdout_raises_tooling_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_subprocess_run(
        monkeypatch,
        lambda argv, kw: _FakeProc(returncode=0, stdout="not json at all"),
    )
    with pytest.raises(SketchToolingError) as exc_info:
        inline_sketch_refs_batch(
            [{"bundles": ["sketch/x"], "snippets": []}], project_root=tmp_path
        )
    assert "non-JSON" in str(exc_info.value)


def test_stdout_not_list_raises_tooling_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_subprocess_run(
        monkeypatch,
        lambda argv, kw: _FakeProc(returncode=0, stdout='{"remaining_bundles": []}'),
    )
    with pytest.raises(SketchToolingError) as exc_info:
        inline_sketch_refs_batch(
            [{"bundles": ["sketch/x"], "snippets": []}], project_root=tmp_path
        )
    assert "array" in str(exc_info.value)


def test_slot_count_mismatch_raises_tooling_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_subprocess_run(
        monkeypatch,
        lambda argv, kw: _FakeProc(
            returncode=0,
            stdout='[{"remaining_bundles": [], "merged_snippets": []}]',
        ),
    )
    with pytest.raises(SketchToolingError) as exc_info:
        inline_sketch_refs_batch(
            [
                {"bundles": ["sketch/x"], "snippets": []},
                {"bundles": [], "snippets": []},
            ],
            project_root=tmp_path,
        )
    assert "1 slots for 2 input groups" in str(exc_info.value)


def test_malformed_error_envelope_raises_tooling_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_subprocess_run(
        monkeypatch,
        lambda argv, kw: _FakeProc(
            returncode=0,
            stdout='[{"error": "ref_invalid"}]',  # missing ref / reason
        ),
    )
    with pytest.raises(SketchToolingError) as exc_info:
        inline_sketch_refs_batch(
            [{"bundles": ["sketch/x"], "snippets": []}], project_root=tmp_path
        )
    assert "malformed error envelope" in str(exc_info.value)


def test_malformed_success_envelope_raises_tooling_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_subprocess_run(
        monkeypatch,
        lambda argv, kw: _FakeProc(
            returncode=0,
            stdout='[{"remaining_bundles": []}]',  # missing merged
        ),
    )
    with pytest.raises(SketchToolingError) as exc_info:
        inline_sketch_refs_batch(
            [{"bundles": ["sketch/x"], "snippets": []}], project_root=tmp_path
        )
    assert "remaining_bundles / merged_snippets" in str(exc_info.value)


# ---------------------------------------------------------------------------
# Invariant: planctl no longer imports promptctl or cli_common
# ---------------------------------------------------------------------------


def test_no_promptctl_or_cli_common_imports_remain_in_planctl() -> None:
    """Locks the no-promptctl/no-cli_common-import criterion in code.

    `grep -rn "from promptctl\\|from cli_common" apps/planctl/planctl` must
    return nothing. Anyone re-introducing an import has to update this test
    by either swapping the import out or explicitly carving an exception
    here — which is the conversation the lint should force.
    """
    import re

    planctl_pkg = Path(__file__).resolve().parent.parent / "planctl"
    pattern = re.compile(r"^\s*(from|import)\s+(promptctl|cli_common)\b")
    offenders: list[str] = []
    for py_file in planctl_pkg.rglob("*.py"):
        for line_no, line in enumerate(
            py_file.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if pattern.match(line):
                offenders.append(
                    f"{py_file.relative_to(planctl_pkg.parent)}:{line_no}: {line.rstrip()}"
                )
    assert offenders == [], (
        "planctl must not import promptctl or cli_common — extraction-blocker:\n"
        + "\n".join(offenders)
    )
