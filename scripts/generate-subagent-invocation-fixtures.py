#!/usr/bin/env python3
"""Regenerate the golden-fixture JSONL for the TS subagent-invocations port.

Imports jobctl's source-of-truth Python parser
(`apps/cli_common/cli_common/subagent_invocations.py:parse_rows`) and runs it
against a curated set of synthetic event sequences. Emits one JSONL line per
case to `test/fixtures/subagent_invocation_cases.jsonl`.

Each fixture line is a JSON object with the keys:

- `desc`: human-readable case label.
- `events`: list of event dicts shaped like the rows the TS reducer feeds
  into its per-event helpers. Each event carries the minimal set of fields
  the TS reducer reads — `id`, `session_id`, `ts`, `hook_event`, `tool_name`,
  `agent_id`, `agent_type`, `tool_use_id`, `subagent_agent_id`, `data` (JSON
  string).
- `expected`: list of canonical-row dicts the Python parser produces (in
  spawn-ts order, MINUS the `tokens` / `tool_use_count` fields — keeper
  drops those per the epic spec).

**Field drop.** The Python `parse_rows` produces entries with `tokens` and
`tool_use_count` fields. Keeper's projection table omits both (billing-flavored;
belongs in usagectl). The generator strips them at fixture-emit time so the TS
test compares only the v1 field set.

**Regeneration is explicit.** Run via `uv run python
scripts/generate-subagent-invocation-fixtures.py` from the `arthack/` checkout
(where `cli_common` lives). Never auto-update in CI — diff against the
checked-in file in the keeper repo and ship a deliberate commit.

Usage:
    cd /Users/mike/code/arthack
    uv run python /Users/mike/code/keeper/scripts/generate-subagent-invocation-fixtures.py
"""
# ruff: noqa: E501

from __future__ import annotations

import json
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Boilerplate to import cli_common from the arthack checkout
# ---------------------------------------------------------------------------

ARTHACK_ROOT = Path("/Users/mike/code/arthack")
if not (
    ARTHACK_ROOT
    / "apps"
    / "cli_common"
    / "cli_common"
    / "subagent_invocations.py"
).exists():
    sys.stderr.write(
        f"error: cli_common not found at {ARTHACK_ROOT}/apps/cli_common — "
        "run this script from a checkout that has arthack at /Users/mike/code/arthack\n"
    )
    sys.exit(2)

try:
    from cli_common.subagent_invocations import (  # type: ignore[import-not-found]
        EventsRow,
        parse_rows,
    )
except ImportError:
    sys.path.insert(0, str(ARTHACK_ROOT / "apps" / "cli_common"))
    from cli_common.subagent_invocations import (  # type: ignore[import-not-found]
        EventsRow,
        parse_rows,
    )


# ---------------------------------------------------------------------------
# Event builders — produce events in the TS-reducer shape AND the
# `parse_rows`-compatible `EventsRow` shape.
# ---------------------------------------------------------------------------

# v1 field drop — Python entries carry these, keeper does not. Stripped at
# fixture-emit time so the TS test compares only the v1 field set.
DROPPED_FIELDS = ("tokens", "tool_use_count")


def _ts_event(
    *,
    id: int,
    session_id: str,
    ts: float,
    hook_event: str,
    tool_name: str | None = None,
    agent_id: str | None = None,
    agent_type: str | None = None,
    tool_use_id: str | None = None,
    subagent_agent_id: str | None = None,
    data: dict | None = None,
) -> dict:
    """Build a TS-reducer-shaped event dict.

    `data` is serialized to a JSON string (matches `events.data TEXT`).
    """
    return {
        "id": id,
        "session_id": session_id,
        "ts": ts,
        "hook_event": hook_event,
        "tool_name": tool_name,
        "agent_id": agent_id,
        "agent_type": agent_type,
        "tool_use_id": tool_use_id,
        "subagent_agent_id": subagent_agent_id,
        "data": json.dumps(data or {}, sort_keys=True, separators=(",", ":")),
    }


def _py_row(ts_event: dict) -> tuple:
    """Translate a TS-reducer event into a `parse_rows`-compatible tuple.

    `EventsRow` is the canonical column order. The Python pulls subagent_type
    / description / prompt_chars / tool_response from JSON via SQL
    `json_extract`; we precompute those here from the TS event's `data` dict
    so the Python parser can consume positional rows.
    """
    data_str = ts_event["data"]
    try:
        data_obj = json.loads(data_str)
    except json.JSONDecodeError:
        data_obj = {}
    tool_input = (
        data_obj.get("tool_input", {})
        if isinstance(data_obj.get("tool_input"), dict)
        else {}
    )
    tool_response_raw = data_obj.get("tool_response")
    tool_response_json: str | None
    if tool_response_raw is None:
        tool_response_json = None
    elif isinstance(tool_response_raw, str):
        tool_response_json = tool_response_raw
    else:
        tool_response_json = json.dumps(
            tool_response_raw, sort_keys=True, separators=(",", ":")
        )

    description = tool_input.get("description")
    subagent_type_from_input = tool_input.get("subagent_type")
    prompt_raw = tool_input.get("prompt")
    prompt_chars = len(prompt_raw) if isinstance(prompt_raw, str) else None

    row = EventsRow(
        ts=ts_event["ts"],
        hook_event=ts_event["hook_event"],
        tool_use_id=ts_event["tool_use_id"],
        subagent_type=subagent_type_from_input,
        description=description,
        prompt_chars=prompt_chars,
        tool_response=tool_response_json,
        agent_id=ts_event["agent_id"],
        agent_type=ts_event["agent_type"],
        subagent_agent_id=ts_event["subagent_agent_id"],
    )
    return tuple(row)


def _strip_v1_fields(entries: list[dict]) -> list[dict]:
    out: list[dict] = []
    for e in entries:
        clean = {k: v for k, v in e.items() if k not in DROPPED_FIELDS}
        out.append(clean)
    return out


# ---------------------------------------------------------------------------
# Fixture cases
# ---------------------------------------------------------------------------


def _case_clean_close() -> dict:
    sid = "sess-clean"
    tool_use_id = "toolu_clean"
    agent_id = "agent_clean"
    events = [
        _ts_event(
            id=1,
            session_id=sid,
            ts=100.0,
            hook_event="PreToolUse",
            tool_name="Agent",
            tool_use_id=tool_use_id,
            data={
                "tool_use_id": tool_use_id,
                "tool_input": {
                    "subagent_type": "Explore",
                    "description": "Find auth code",
                    "prompt": "Search the codebase for authentication helpers",
                },
            },
        ),
        _ts_event(
            id=2,
            session_id=sid,
            ts=100.5,
            hook_event="SubagentStart",
            agent_id=agent_id,
            agent_type="Explore",
        ),
        _ts_event(
            id=3,
            session_id=sid,
            ts=101.5,
            hook_event="SubagentStop",
            agent_id=agent_id,
        ),
        _ts_event(
            id=4,
            session_id=sid,
            ts=102.0,
            hook_event="PostToolUse",
            tool_name="Agent",
            tool_use_id=tool_use_id,
            subagent_agent_id=agent_id,
            data={
                "tool_use_id": tool_use_id,
                "tool_response": {"agentId": agent_id},
            },
        ),
    ]
    return {"desc": "clean-close", "events": events}


def _case_still_running() -> dict:
    sid = "sess-running"
    tool_use_id = "toolu_running"
    agent_id = "agent_running"
    events = [
        _ts_event(
            id=1,
            session_id=sid,
            ts=200.0,
            hook_event="PreToolUse",
            tool_name="Agent",
            tool_use_id=tool_use_id,
            data={
                "tool_use_id": tool_use_id,
                "tool_input": {
                    "subagent_type": "Explore",
                    "description": "Long-running search",
                    "prompt": "Examine all files",
                },
            },
        ),
        _ts_event(
            id=2,
            session_id=sid,
            ts=200.5,
            hook_event="SubagentStart",
            agent_id=agent_id,
            agent_type="Explore",
        ),
    ]
    return {"desc": "still-running", "events": events}


def _case_orphan_stop() -> dict:
    sid = "sess-orphan-stop"
    agent_id = "agent_no_start"
    events = [
        _ts_event(
            id=1,
            session_id=sid,
            ts=300.0,
            hook_event="SubagentStop",
            agent_id=agent_id,
        ),
    ]
    return {"desc": "orphan-stop", "events": events}


def _case_orphan_failure() -> dict:
    sid = "sess-orphan-fail"
    tool_use_id = "toolu_failure"
    events = [
        _ts_event(
            id=1,
            session_id=sid,
            ts=400.0,
            hook_event="PostToolUseFailure",
            tool_name="Agent",
            tool_use_id=tool_use_id,
            data={"tool_use_id": tool_use_id},
        ),
    ]
    return {"desc": "orphan-failure", "events": events}


def _case_post_before_stop() -> dict:
    """PostToolUse:Agent arrives before SubagentStop (Anthropic-confirmed Task ordering)."""
    sid = "sess-post-before-stop"
    tool_use_id = "toolu_pbs"
    agent_id = "agent_pbs"
    events = [
        _ts_event(
            id=1,
            session_id=sid,
            ts=500.0,
            hook_event="PreToolUse",
            tool_name="Agent",
            tool_use_id=tool_use_id,
            data={
                "tool_use_id": tool_use_id,
                "tool_input": {
                    "subagent_type": "Plan",
                    "description": "Plan it",
                    "prompt": "Plan this feature",
                },
            },
        ),
        _ts_event(
            id=2,
            session_id=sid,
            ts=500.5,
            hook_event="SubagentStart",
            agent_id=agent_id,
            agent_type="Plan",
        ),
        # PostToolUse arrives first — flips status to "ok" before SubagentStop.
        _ts_event(
            id=3,
            session_id=sid,
            ts=501.5,
            hook_event="PostToolUse",
            tool_name="Agent",
            tool_use_id=tool_use_id,
            subagent_agent_id=agent_id,
            data={
                "tool_use_id": tool_use_id,
                "tool_response": {"agentId": agent_id},
            },
        ),
        # SubagentStop arrives later — duration_ms IS NULL gate still matches.
        _ts_event(
            id=4,
            session_id=sid,
            ts=502.0,
            hook_event="SubagentStop",
            agent_id=agent_id,
        ),
    ]
    return {"desc": "post-before-stop", "events": events}


def _case_multi_turn() -> dict:
    """Same agent_id, two SubagentStart/Stop pairs — turn_seq increments per agent_id."""
    sid = "sess-multi-turn"
    agent_id = "agent_mt"
    tool_use_id_1 = "toolu_mt_1"
    tool_use_id_2 = "toolu_mt_2"
    events = [
        # Turn 0
        _ts_event(
            id=1,
            session_id=sid,
            ts=600.0,
            hook_event="PreToolUse",
            tool_name="Agent",
            tool_use_id=tool_use_id_1,
            data={
                "tool_use_id": tool_use_id_1,
                "tool_input": {
                    "subagent_type": "Explore",
                    "description": "First turn",
                    "prompt": "First request",
                },
            },
        ),
        _ts_event(
            id=2,
            session_id=sid,
            ts=600.5,
            hook_event="SubagentStart",
            agent_id=agent_id,
            agent_type="Explore",
        ),
        _ts_event(
            id=3,
            session_id=sid,
            ts=601.5,
            hook_event="SubagentStop",
            agent_id=agent_id,
        ),
        _ts_event(
            id=4,
            session_id=sid,
            ts=602.0,
            hook_event="PostToolUse",
            tool_name="Agent",
            tool_use_id=tool_use_id_1,
            subagent_agent_id=agent_id,
            data={
                "tool_use_id": tool_use_id_1,
                "tool_response": {"agentId": agent_id},
            },
        ),
        # Turn 1 — same agent_id
        _ts_event(
            id=5,
            session_id=sid,
            ts=700.0,
            hook_event="PreToolUse",
            tool_name="Agent",
            tool_use_id=tool_use_id_2,
            data={
                "tool_use_id": tool_use_id_2,
                "tool_input": {
                    "subagent_type": "Explore",
                    "description": "Second turn",
                    "prompt": "Follow up",
                },
            },
        ),
        _ts_event(
            id=6,
            session_id=sid,
            ts=700.5,
            hook_event="SubagentStart",
            agent_id=agent_id,
            agent_type="Explore",
        ),
        _ts_event(
            id=7,
            session_id=sid,
            ts=701.5,
            hook_event="SubagentStop",
            agent_id=agent_id,
        ),
    ]
    return {"desc": "multi-turn", "events": events}


def _case_interleaved() -> dict:
    """Two distinct agents' events interleaved in one session."""
    sid = "sess-inter"
    agent_a = "agent_A"
    agent_b = "agent_B"
    tu_a = "toolu_A"
    tu_b = "toolu_B"
    events = [
        _ts_event(
            id=1,
            session_id=sid,
            ts=800.0,
            hook_event="PreToolUse",
            tool_name="Agent",
            tool_use_id=tu_a,
            data={
                "tool_use_id": tu_a,
                "tool_input": {
                    "subagent_type": "Explore",
                    "description": "A search",
                    "prompt": "Find stuff A",
                },
            },
        ),
        _ts_event(
            id=2,
            session_id=sid,
            ts=800.5,
            hook_event="SubagentStart",
            agent_id=agent_a,
            agent_type="Explore",
        ),
        _ts_event(
            id=3,
            session_id=sid,
            ts=801.0,
            hook_event="PreToolUse",
            tool_name="Agent",
            tool_use_id=tu_b,
            data={
                "tool_use_id": tu_b,
                "tool_input": {
                    "subagent_type": "Plan",
                    "description": "B plan",
                    "prompt": "Plan stuff B",
                },
            },
        ),
        _ts_event(
            id=4,
            session_id=sid,
            ts=801.5,
            hook_event="SubagentStart",
            agent_id=agent_b,
            agent_type="Plan",
        ),
        _ts_event(
            id=5,
            session_id=sid,
            ts=802.0,
            hook_event="SubagentStop",
            agent_id=agent_a,
        ),
        _ts_event(
            id=6,
            session_id=sid,
            ts=802.5,
            hook_event="PostToolUse",
            tool_name="Agent",
            tool_use_id=tu_a,
            subagent_agent_id=agent_a,
            data={
                "tool_use_id": tu_a,
                "tool_response": {"agentId": agent_a},
            },
        ),
        _ts_event(
            id=7,
            session_id=sid,
            ts=803.0,
            hook_event="SubagentStop",
            agent_id=agent_b,
        ),
        _ts_event(
            id=8,
            session_id=sid,
            ts=803.5,
            hook_event="PostToolUse",
            tool_name="Agent",
            tool_use_id=tu_b,
            subagent_agent_id=agent_b,
            data={
                "tool_use_id": tu_b,
                "tool_response": {"agentId": agent_b},
            },
        ),
    ]
    return {"desc": "interleaved", "events": events}


def _case_pre_without_post() -> dict:
    """PreToolUse + SubagentStart + SubagentStop without PostToolUse — bridge fold never fires.

    Description / prompt_chars stay unset on the turn-0 row (matches Python's
    bridge-fold-never-fires behavior).
    """
    sid = "sess-pre-no-post"
    tool_use_id = "toolu_pwp"
    agent_id = "agent_pwp"
    events = [
        _ts_event(
            id=1,
            session_id=sid,
            ts=900.0,
            hook_event="PreToolUse",
            tool_name="Agent",
            tool_use_id=tool_use_id,
            data={
                "tool_use_id": tool_use_id,
                "tool_input": {
                    "subagent_type": "Explore",
                    "description": "Unfinished spawn",
                    "prompt": "This will not see PostToolUse",
                },
            },
        ),
        _ts_event(
            id=2,
            session_id=sid,
            ts=900.5,
            hook_event="SubagentStart",
            agent_id=agent_id,
            agent_type="Explore",
        ),
        _ts_event(
            id=3,
            session_id=sid,
            ts=901.5,
            hook_event="SubagentStop",
            agent_id=agent_id,
        ),
    ]
    return {"desc": "pre-without-post", "events": events}


def _case_cross_job_tool_use_id_collision() -> dict:
    """Two sessions with the same tool_use_id — session_id WHERE prevents contamination.

    Each session has its own agent + spawn. The TS test verifies
    `findBridgePreToolUse(db, sess_b, shared_tu)` returns sess_b's payload, not
    sess_a's — proving the WHERE includes session_id.

    Python `parse_rows` is single-session at a time; we run it per session and
    flatten so the fixture's `expected` reflects both sessions' final rows.
    """
    sid_a = "sess-collide-A"
    sid_b = "sess-collide-B"
    shared_tu = "toolu_shared"
    agent_a = "agent_collide_A"
    agent_b = "agent_collide_B"
    events_a = [
        _ts_event(
            id=1,
            session_id=sid_a,
            ts=1000.0,
            hook_event="PreToolUse",
            tool_name="Agent",
            tool_use_id=shared_tu,
            data={
                "tool_use_id": shared_tu,
                "tool_input": {
                    "subagent_type": "Explore",
                    "description": "A payload",
                    "prompt": "Session A prompt",
                },
            },
        ),
        _ts_event(
            id=2,
            session_id=sid_a,
            ts=1000.5,
            hook_event="SubagentStart",
            agent_id=agent_a,
            agent_type="Explore",
        ),
        _ts_event(
            id=3,
            session_id=sid_a,
            ts=1001.5,
            hook_event="SubagentStop",
            agent_id=agent_a,
        ),
        _ts_event(
            id=4,
            session_id=sid_a,
            ts=1002.0,
            hook_event="PostToolUse",
            tool_name="Agent",
            tool_use_id=shared_tu,
            subagent_agent_id=agent_a,
            data={
                "tool_use_id": shared_tu,
                "tool_response": {"agentId": agent_a},
            },
        ),
    ]
    events_b = [
        _ts_event(
            id=5,
            session_id=sid_b,
            ts=1100.0,
            hook_event="PreToolUse",
            tool_name="Agent",
            tool_use_id=shared_tu,
            data={
                "tool_use_id": shared_tu,
                "tool_input": {
                    "subagent_type": "Plan",
                    "description": "B payload",
                    "prompt": "Session B prompt — longer",
                },
            },
        ),
        _ts_event(
            id=6,
            session_id=sid_b,
            ts=1100.5,
            hook_event="SubagentStart",
            agent_id=agent_b,
            agent_type="Plan",
        ),
        _ts_event(
            id=7,
            session_id=sid_b,
            ts=1101.5,
            hook_event="SubagentStop",
            agent_id=agent_b,
        ),
        _ts_event(
            id=8,
            session_id=sid_b,
            ts=1102.0,
            hook_event="PostToolUse",
            tool_name="Agent",
            tool_use_id=shared_tu,
            subagent_agent_id=agent_b,
            data={
                "tool_use_id": shared_tu,
                "tool_response": {"agentId": agent_b},
            },
        ),
    ]
    return {
        "desc": "cross-job-tool-use-id-collision",
        "events": events_a + events_b,
        "split_by_session": True,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def _run_case(case: dict) -> dict:
    """Drive the Python parser over the case's events and capture the expected rows."""
    events = case["events"]
    split = case.get("split_by_session", False)

    if split:
        # Run parse_rows once per session_id, then concatenate by spawn ts.
        by_session: dict[str, list[dict]] = {}
        for ev in events:
            by_session.setdefault(ev["session_id"], []).append(ev)
        expected: list[dict] = []
        for _sid, evs in by_session.items():
            evs_sorted = sorted(evs, key=lambda e: (e["ts"], e["id"]))
            py_rows = [_py_row(ev) for ev in evs_sorted]
            entries = parse_rows(py_rows, group_by=None)
            expected.extend(entries)
    else:
        evs_sorted = sorted(events, key=lambda e: (e["ts"], e["id"]))
        py_rows = [_py_row(ev) for ev in evs_sorted]
        expected = parse_rows(py_rows, group_by=None)

    expected = _strip_v1_fields(expected)
    return {
        "desc": case["desc"],
        "events": events,
        "expected": expected,
    }


def main() -> int:
    here = Path(__file__).resolve()
    keeper_root = here.parent.parent
    out_dir = keeper_root / "test" / "fixtures"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "subagent_invocation_cases.jsonl"

    cases = [
        _case_clean_close(),
        _case_still_running(),
        _case_orphan_stop(),
        _case_orphan_failure(),
        _case_post_before_stop(),
        _case_multi_turn(),
        _case_interleaved(),
        _case_pre_without_post(),
        _case_cross_job_tool_use_id_collision(),
    ]

    rows = [_run_case(case) for case in cases]

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
