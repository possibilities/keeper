#!/usr/bin/env python3
"""Regenerate the golden-fixture JSONL for the TS plan-classifier port.

Imports jobctl's source-of-truth Python derivers
(`apps/cli_common/cli_common/planctl_invocations.py:304-746`) and runs them
against a curated set of synthetic invocation streams. Emits one JSONL
line per case to `test/fixtures/plan_classifier_cases.jsonl`.

Each fixture line is a JSON object with the keys:

- `desc`: human-readable case label.
- `mode`: `"epic_links"` or `"job_links"`.
- For `epic_links`:
  - `openers`: list of `/plan:plan` opener `ts` values (seconds, float).
  - `invocations`: list of `ClassifierInvocation`-shaped dicts
    (`ts`, `op`, `target`, `epic_id`, `subject_present`) in seconds.
  - `windows`: derived from `openers` via the Python `_compute_plan_windows`,
    emitted as `[[start_s, end_s], ...]`. The last window's end is the
    Python `math.inf` translated to JS `Number.MAX_SAFE_INTEGER` for the
    TS port (SQLite has no infinity type — see plan-classifier.ts).
  - `expected`: list of `{kind, target}` dicts returned by the Python.
- For `job_links`:
  - `epic_id`: target epic id to filter against.
  - `sessions`: map of `job_id` → `{"openers": [...], "invocations": [...]}`.
  - `expected`: list of `{kind, job_id}` dicts returned by the Python.

**Unit divergence.** The Python compares `int ms` throughout
(skill_invocations stores `int(seconds * 1000)`, planctl invocations are
float seconds — converted via `int(ts * 1000)` inside the classifier). This
script's fixture EMITS seconds — the TS port compares seconds throughout
(see plan-classifier.ts module docstring). At fixture-emit time we convert
the Python's window output (ms) back to seconds (`/ 1000`) and pin
`math.inf` → `Number.MAX_SAFE_INTEGER` (2**53 - 1). The classifier
arithmetic is unit-invariant — only the absolute scale matters, and we
keep it consistent end-to-end.

**Regeneration is explicit.** Run via `uv run python
scripts/gen-plan-classifier-fixture.py` from the `arthack/` checkout (where
`cli_common` lives). Never auto-update in CI — diff against the
checked-in file in the keeper repo and ship a deliberate commit.

Usage:
    cd /Users/mike/code/arthack
    uv run python /Users/mike/code/keeper/scripts/gen-plan-classifier-fixture.py
"""
# ruff: noqa: E501

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

# JS Number.MAX_SAFE_INTEGER mirror — keeper's plan-classifier.ts uses this as
# the sentinel for the last window's upper bound (SQLite has no infinity type).
MAX_TS_SENTINEL = (1 << 53) - 1  # 9007199254740991

# ---------------------------------------------------------------------------
# Boilerplate to import cli_common from the arthack checkout
# ---------------------------------------------------------------------------

ARTHACK_ROOT = Path("/Users/mike/code/arthack")
if not (ARTHACK_ROOT / "apps" / "cli_common" / "cli_common" / "planctl_invocations.py").exists():
    sys.stderr.write(
        f"error: cli_common not found at {ARTHACK_ROOT}/apps/cli_common — "
        "run this script from a checkout that has arthack at /Users/mike/code/arthack\n"
    )
    sys.exit(2)

# Try direct import first (uv-run inside arthack); fall back to sys.path injection.
try:
    from cli_common.planctl_invocations import (  # type: ignore[import-not-found]
        _compute_plan_windows,
        derive_epic_links,
        derive_job_links,
    )
except ImportError:
    sys.path.insert(0, str(ARTHACK_ROOT / "apps" / "cli_common"))
    sys.path.insert(0, str(ARTHACK_ROOT / "apps" / "planctl"))
    from cli_common.planctl_invocations import (  # type: ignore[import-not-found]
        _compute_plan_windows,
        derive_epic_links,
        derive_job_links,
    )


# ---------------------------------------------------------------------------
# Helpers for shape translation between TS-side (seconds) and Python-side (ms)
# ---------------------------------------------------------------------------


def _to_skill_invocations(openers_seconds: list[float]) -> list[dict]:
    """Build a `_compute_plan_windows`-compatible list from seconds-shaped openers.

    Python ts unit is int ms — we convert seconds × 1000.
    """
    return [
        {"name": "plan:plan", "kind": "skill", "ts": int(s * 1000)}
        for s in openers_seconds
    ]


def _to_planctl_invocations_python(invs_seconds: list[dict]) -> list[dict]:
    """Translate a `ClassifierInvocation`-shaped TS list to Python `derive_epic_links` input shape.

    Maps `subject_present: bool` → `subject: str | None` (the Python's
    readonly gate is `subject is None`). Keeps `ts` in float seconds (the
    Python's `derive_epic_links` does the `ts * 1000` conversion internally).
    """
    out: list[dict] = []
    for inv in invs_seconds:
        out.append(
            {
                "ts": float(inv["ts"]),
                "op": inv["op"],
                "target": inv["target"],
                "epic_id": inv.get("epic_id"),
                "task_id": inv.get("task_id"),
                # Readonly entries in the Python carry subject=None.
                "subject": "x" if inv["subject_present"] else None,
            }
        )
    return out


def _windows_python_to_seconds(windows_ms: list[tuple[int, float]]) -> list[list[int | float]]:
    """Translate the Python's int-ms windows to seconds-shaped TS pairs.

    The last window's end is `math.inf` in Python; we pin it to
    `MAX_TS_SENTINEL` (JS `Number.MAX_SAFE_INTEGER`) for the TS port.
    Intermediate windows convert `ms / 1000` to seconds.
    """
    out: list[list[int | float]] = []
    for start_ms, end_ms in windows_ms:
        start_s: int | float = start_ms / 1000
        end_s: int | float
        if end_ms == math.inf:
            end_s = MAX_TS_SENTINEL
        else:
            end_s = end_ms / 1000
        out.append([start_s, end_s])
    return out


# ---------------------------------------------------------------------------
# Fixture cases
# ---------------------------------------------------------------------------


def _epic_links_cases() -> list[dict]:
    """Curated `derive_epic_links` cases — one fixture row per edge case.

    Each case is a single-session scenario. `openers` and `invocations` are
    in seconds.
    """
    cases: list[dict] = []

    # 1. Empty session.
    cases.append(
        {
            "desc": "empty session — no openers, no invocations",
            "openers": [],
            "invocations": [],
        }
    )

    # 2. Single planctl event with no opener — drops everything.
    cases.append(
        {
            "desc": "no /plan:plan opener — single mutation dropped",
            "openers": [],
            "invocations": [
                {
                    "ts": 100.0,
                    "op": "create",
                    "target": "fn-1-foo",
                    "epic_id": "fn-1-foo",
                    "subject_present": True,
                }
            ],
        }
    )

    # 3. Single planctl event inside a single window (one creator, no next_start boundary).
    cases.append(
        {
            "desc": "single window, single creator",
            "openers": [50.0],
            "invocations": [
                {
                    "ts": 100.0,
                    "op": "create",
                    "target": "fn-1-foo",
                    "epic_id": "fn-1-foo",
                    "subject_present": True,
                }
            ],
        }
    )

    # 4. Creator-then-refiner-same-epic-same-window — refiner suppressed.
    cases.append(
        {
            "desc": "creator-then-refiner same epic same window — only creator emitted",
            "openers": [50.0],
            "invocations": [
                {
                    "ts": 100.0,
                    "op": "create",
                    "target": "fn-1-foo",
                    "epic_id": "fn-1-foo",
                    "subject_present": True,
                },
                {
                    "ts": 150.0,
                    "op": "set-title",
                    "target": "fn-1-foo",
                    "epic_id": "fn-1-foo",
                    "subject_present": True,
                },
            ],
        }
    )

    # 5. Creator-then-refiner-same-epic-multi-window — BOTH edges emitted.
    cases.append(
        {
            "desc": "creator window-1, refiner window-2 — BOTH edges emitted",
            "openers": [50.0, 200.0],
            "invocations": [
                {
                    "ts": 100.0,
                    "op": "create",
                    "target": "fn-1-foo",
                    "epic_id": "fn-1-foo",
                    "subject_present": True,
                },
                {
                    "ts": 250.0,
                    "op": "set-title",
                    "target": "fn-1-foo",
                    "epic_id": "fn-1-foo",
                    "subject_present": True,
                },
            ],
        }
    )

    # 6. Refiner-without-creator — refiner emitted.
    cases.append(
        {
            "desc": "refiner without prior creator — refiner emitted",
            "openers": [50.0],
            "invocations": [
                {
                    "ts": 100.0,
                    "op": "set-title",
                    "target": "fn-1-foo",
                    "epic_id": "fn-1-foo",
                    "subject_present": True,
                }
            ],
        }
    )

    # 7. Read-only verb in window (subject_present=False) — no edges.
    cases.append(
        {
            "desc": "read-only verb in window — no edges",
            "openers": [50.0],
            "invocations": [
                {
                    "ts": 100.0,
                    "op": "cat",
                    "target": "fn-1-foo",
                    "epic_id": "fn-1-foo",
                    "subject_present": False,
                }
            ],
        }
    )

    # 8. Mutation BEFORE the first window — dropped.
    cases.append(
        {
            "desc": "mutation strictly before first window — dropped",
            "openers": [200.0],
            "invocations": [
                {
                    "ts": 100.0,
                    "op": "create",
                    "target": "fn-1-foo",
                    "epic_id": "fn-1-foo",
                    "subject_present": True,
                }
            ],
        }
    )

    # 9. Mutation at the EXACT window boundary (ts == win_start) — inside the window.
    cases.append(
        {
            "desc": "mutation at exact window-start ts — inside the window",
            "openers": [100.0],
            "invocations": [
                {
                    "ts": 100.0,
                    "op": "create",
                    "target": "fn-1-foo",
                    "epic_id": "fn-1-foo",
                    "subject_present": True,
                }
            ],
        }
    )

    # 10. Window opener at last event — extends to MAX_SAFE_INTEGER.
    cases.append(
        {
            "desc": "window opener at last event — extends to MAX_SAFE_INTEGER",
            "openers": [100.0],
            "invocations": [
                {
                    "ts": 1_000_000.0,
                    "op": "create",
                    "target": "fn-1-foo",
                    "epic_id": "fn-1-foo",
                    "subject_present": True,
                }
            ],
        }
    )

    # 11. Two windows back-to-back, creator in first, refiner-on-different-epic in second.
    cases.append(
        {
            "desc": "two windows, creator-X in 1, refiner-Y in 2 — both emitted",
            "openers": [50.0, 200.0],
            "invocations": [
                {
                    "ts": 100.0,
                    "op": "create",
                    "target": "fn-1-foo",
                    "epic_id": "fn-1-foo",
                    "subject_present": True,
                },
                {
                    "ts": 250.0,
                    "op": "set-title",
                    "target": "fn-2-bar",
                    "epic_id": "fn-2-bar",
                    "subject_present": True,
                },
            ],
        }
    )

    # 12. Three windows with creator in middle — exercises pointer advance past first window.
    cases.append(
        {
            "desc": "three windows, creator in middle window",
            "openers": [50.0, 200.0, 400.0],
            "invocations": [
                {
                    "ts": 250.0,
                    "op": "create",
                    "target": "fn-9-mid",
                    "epic_id": "fn-9-mid",
                    "subject_present": True,
                }
            ],
        }
    )

    # 13. Mutation with epic_id=null and not a create-epic — skipped.
    cases.append(
        {
            "desc": "mutation with no epic_id and not create-epic — skipped",
            "openers": [50.0],
            "invocations": [
                {
                    "ts": 100.0,
                    "op": "init",
                    "target": None,
                    "epic_id": None,
                    "subject_present": True,
                }
            ],
        }
    )

    # 14. Task-form target (create on a task ref) — NOT a creator (only epic-ids match).
    cases.append(
        {
            "desc": "create op on task-form target — refiner via epic_id, not creator",
            "openers": [50.0],
            "invocations": [
                {
                    "ts": 100.0,
                    "op": "create",
                    "target": "fn-1-foo.3",
                    "epic_id": "fn-1-foo",
                    "subject_present": True,
                }
            ],
        }
    )

    # 15. Final-sort verification: refiner on epic-A then creator on epic-B —
    # sorted by (kind, target): creator-B comes first, then refiner-A.
    cases.append(
        {
            "desc": "final sort: refiner-A then creator-B → creator-B sorted first",
            "openers": [50.0],
            "invocations": [
                {
                    "ts": 100.0,
                    "op": "set-title",
                    "target": "fn-1-aaa",
                    "epic_id": "fn-1-aaa",
                    "subject_present": True,
                },
                {
                    "ts": 110.0,
                    "op": "create",
                    "target": "fn-2-bbb",
                    "epic_id": "fn-2-bbb",
                    "subject_present": True,
                },
            ],
        }
    )

    # 16. Defensive sort: out-of-order ts feeds.
    cases.append(
        {
            "desc": "defensive sort: out-of-order ts input still produces window-correct edges",
            "openers": [50.0, 200.0],
            "invocations": [
                {
                    "ts": 250.0,
                    "op": "set-title",
                    "target": "fn-1-foo",
                    "epic_id": "fn-1-foo",
                    "subject_present": True,
                },
                {
                    "ts": 100.0,
                    "op": "create",
                    "target": "fn-1-foo",
                    "epic_id": "fn-1-foo",
                    "subject_present": True,
                },
            ],
        }
    )

    return cases


def _job_links_cases() -> list[dict]:
    """Curated `derive_job_links` cases — one fixture row per scenario.

    Each case carries `epic_id` + `sessions: {job_id: {openers, invocations}}`.
    """
    cases: list[dict] = []

    # 1. Single session, single creator — single creator edge.
    cases.append(
        {
            "desc": "single session creator-of-X",
            "epic_id": "fn-1-foo",
            "sessions": {
                "sess-a": {
                    "openers": [50.0],
                    "invocations": [
                        {
                            "ts": 100.0,
                            "op": "create",
                            "target": "fn-1-foo",
                            "epic_id": "fn-1-foo",
                            "subject_present": True,
                        }
                    ],
                }
            },
        }
    )

    # 2. Two sessions: A creator, B refiner — both emitted, sorted (kind, job_id).
    cases.append(
        {
            "desc": "session-A creator, session-B refiner — both edges",
            "epic_id": "fn-1-foo",
            "sessions": {
                "sess-a": {
                    "openers": [50.0],
                    "invocations": [
                        {
                            "ts": 100.0,
                            "op": "create",
                            "target": "fn-1-foo",
                            "epic_id": "fn-1-foo",
                            "subject_present": True,
                        }
                    ],
                },
                "sess-b": {
                    "openers": [500.0],
                    "invocations": [
                        {
                            "ts": 600.0,
                            "op": "set-title",
                            "target": "fn-1-foo",
                            "epic_id": "fn-1-foo",
                            "subject_present": True,
                        }
                    ],
                },
            },
        }
    )

    # 3. Session with no /plan:plan window — no edges.
    cases.append(
        {
            "desc": "session with no /plan:plan window — no edges",
            "epic_id": "fn-1-foo",
            "sessions": {
                "sess-a": {
                    "openers": [],
                    "invocations": [
                        {
                            "ts": 100.0,
                            "op": "create",
                            "target": "fn-1-foo",
                            "epic_id": "fn-1-foo",
                            "subject_present": True,
                        }
                    ],
                }
            },
        }
    )

    # 4. Session touched DIFFERENT epic — no edges for queried epic.
    cases.append(
        {
            "desc": "session touched different epic — no edges for queried epic",
            "epic_id": "fn-1-foo",
            "sessions": {
                "sess-a": {
                    "openers": [50.0],
                    "invocations": [
                        {
                            "ts": 100.0,
                            "op": "create",
                            "target": "fn-2-bar",
                            "epic_id": "fn-2-bar",
                            "subject_present": True,
                        }
                    ],
                }
            },
        }
    )

    # 5. Session creator-then-refiner-same-window — only creator edge.
    cases.append(
        {
            "desc": "session creator-then-refiner same window — only creator edge",
            "epic_id": "fn-1-foo",
            "sessions": {
                "sess-a": {
                    "openers": [50.0],
                    "invocations": [
                        {
                            "ts": 100.0,
                            "op": "create",
                            "target": "fn-1-foo",
                            "epic_id": "fn-1-foo",
                            "subject_present": True,
                        },
                        {
                            "ts": 150.0,
                            "op": "set-title",
                            "target": "fn-1-foo",
                            "epic_id": "fn-1-foo",
                            "subject_present": True,
                        },
                    ],
                }
            },
        }
    )

    # 6. Session creator-window-1 + refiner-window-2 — BOTH edges (deduped to creator only at job level).
    cases.append(
        {
            "desc": "single session creator w1 + refiner w2 — both edges for that session",
            "epic_id": "fn-1-foo",
            "sessions": {
                "sess-a": {
                    "openers": [50.0, 300.0],
                    "invocations": [
                        {
                            "ts": 100.0,
                            "op": "create",
                            "target": "fn-1-foo",
                            "epic_id": "fn-1-foo",
                            "subject_present": True,
                        },
                        {
                            "ts": 400.0,
                            "op": "set-title",
                            "target": "fn-1-foo",
                            "epic_id": "fn-1-foo",
                            "subject_present": True,
                        },
                    ],
                }
            },
        }
    )

    # 7. Multiple sessions, some empty — only non-empty contribute.
    cases.append(
        {
            "desc": "many sessions, some empty — only meaningful ones contribute",
            "epic_id": "fn-1-foo",
            "sessions": {
                "sess-empty": {"openers": [], "invocations": []},
                "sess-readonly": {
                    "openers": [50.0],
                    "invocations": [
                        {
                            "ts": 100.0,
                            "op": "cat",
                            "target": "fn-1-foo",
                            "epic_id": "fn-1-foo",
                            "subject_present": False,
                        }
                    ],
                },
                "sess-creator": {
                    "openers": [50.0],
                    "invocations": [
                        {
                            "ts": 100.0,
                            "op": "create",
                            "target": "fn-1-foo",
                            "epic_id": "fn-1-foo",
                            "subject_present": True,
                        }
                    ],
                },
            },
        }
    )

    return cases


# ---------------------------------------------------------------------------
# Main: build fixture file
# ---------------------------------------------------------------------------


def _run_epic_link_case(case: dict) -> dict:
    """Resolve the expected output for one epic_links case using the Python derivers."""
    openers = case["openers"]
    invs_seconds = case["invocations"]
    skill = _to_skill_invocations(openers)
    py_invs = _to_planctl_invocations_python(invs_seconds)
    windows_ms = _compute_plan_windows(skill)
    expected = derive_epic_links(py_invs, skill)
    windows_seconds = _windows_python_to_seconds(windows_ms)
    return {
        "desc": case["desc"],
        "mode": "epic_links",
        "openers": openers,
        "invocations": invs_seconds,
        "windows": windows_seconds,
        "expected": expected,
    }


def _run_job_link_case(case: dict) -> dict:
    """Resolve the expected output for one job_links case using the Python derivers."""
    epic_id = case["epic_id"]
    sessions = case["sessions"]

    py_invs_namespace: dict[str, dict] = {}
    py_skill_namespace: dict[str, list[dict]] = {}
    windows_by_session_seconds: dict[str, list[list[int | float]]] = {}

    for job_id, payload in sessions.items():
        openers = payload["openers"]
        invs = payload["invocations"]
        skill = _to_skill_invocations(openers)
        py_invs_namespace[job_id] = {
            "invocations": _to_planctl_invocations_python(invs)
        }
        py_skill_namespace[job_id] = skill
        windows_ms = _compute_plan_windows(skill)
        windows_by_session_seconds[job_id] = _windows_python_to_seconds(windows_ms)

    expected = derive_job_links(py_invs_namespace, py_skill_namespace, epic_id)
    return {
        "desc": case["desc"],
        "mode": "job_links",
        "epic_id": epic_id,
        "sessions": sessions,
        "windows_by_session": windows_by_session_seconds,
        "expected": expected,
    }


def main() -> int:
    here = Path(__file__).resolve()
    keeper_root = here.parent.parent
    out_dir = keeper_root / "test" / "fixtures"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "plan_classifier_cases.jsonl"

    rows: list[dict] = []
    for case in _epic_links_cases():
        rows.append(_run_epic_link_case(case))
    for case in _job_links_cases():
        rows.append(_run_job_link_case(case))

    # Single-line-per-row, sorted keys for byte-stable diffs across regenerations.
    with out_path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, sort_keys=True, separators=(",", ":")))
            f.write("\n")

    sys.stderr.write(
        f"wrote {len(rows)} fixture rows to {out_path.relative_to(keeper_root)}\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
