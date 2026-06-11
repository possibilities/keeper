#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# one-shot for fn-18-investigate-worker-dropoffs.1
#
# Scan plan:worker subagent invocations in recent Claude Code JSONL
# sessions under ~/.claude-profiles/multi-claude-1/projects/-Users-mike-code-arthack/
# and classify each as healthy or dropped.
#
# Healthy == the subagent called `planctl done` AT LEAST ONCE AND the final
# assistant stop_reason is `end_turn` (i.e. the Phase 6 summary was actually
# emitted).
# Dropped == everything else, with sub-categories:
#   - drop_midtool: final stop_reason is `tool_use` and no `planctl done` fired
#   - drop_nodone: final stop_reason is `end_turn` but no `planctl done`
#     (worker summarised without ever marking task done — rare but distinct)
#   - drop_tool_error: drop_midtool AND the last tool_result contained an
#     `is_error: true` or starts with `Error`
#
# Also captures: concurrency (count of sibling `plan:worker` spawns whose
# run-window overlaps ours, from the parent session), respawn_needed (a
# second parent-session Agent spawn targeting the same TASK_ID on the same
# day), and stream-ordered last-text excerpt.
#
# Output: markdown table + per-row evidence lines citing file:line of the
# source JSONL so reviewers can grep back.
#
# Read-only. No planctl CLI calls. Writes nothing by itself — pipe to file.

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

PROJECT_DIR = Path(
    "/Users/mike/.claude-profiles/multi-claude-1/projects/-Users-mike-code-arthack"
)

TASK_ID_RE = re.compile(r"\b(fn-\d+-[a-z0-9-]+\.\d+)\b")
TASK_NOTIF_TASK_ID_RE = re.compile(r"<task-id>([a-f0-9]+)</task-id>")
TASK_NOTIF_TU_ID_RE = re.compile(r"<tool-use-id>(toolu_[A-Za-z0-9]+)</tool-use-id>")
TASK_NOTIF_USAGE_RE = re.compile(
    r"<usage><total_tokens>(\d+)</total_tokens><tool_uses>(\d+)</tool_uses>"
    r"<duration_ms>(\d+)</duration_ms></usage>"
)
TASK_NOTIF_RESULT_RE = re.compile(r"<result>(.*?)</result>", re.DOTALL)
TASK_NOTIF_STATUS_RE = re.compile(r"<status>(\w+)</status>")


@dataclass
class Spawn:
    """One parent-side Agent spawn of plan:worker."""

    parent_session: str
    parent_file: Path
    parent_line_no: int  # 1-indexed
    ts: datetime | None
    tool_use_id: str
    task_id: str  # fn-N-slug.M
    epic_id: str
    agent_id: str | None = None  # assigned when we see the tool_result
    notif_line_no: int | None = None  # parent line of the completion notification
    notif_status: str | None = None
    notif_total_tokens: int | None = None
    notif_tool_uses: int | None = None
    notif_duration_ms: int | None = None
    notif_result_text: str = ""
    ctx_preamble_in_prompt: bool = False

    # Derived from subagent JSONL
    sub_file: Path | None = None
    sub_last_stop_reason: str | None = None
    sub_last_text_tail: str = ""
    sub_planctl_done_calls: int = 0
    sub_total_tool_uses: int = 0
    sub_last_cache_read_tokens: int | None = None
    sub_last_tool_result_is_error: bool = False
    sub_start_ts: datetime | None = None
    sub_end_ts: datetime | None = None
    sub_duration_ms: int | None = None
    sub_total_output_tokens: int = 0
    sub_phase6_summary_emitted: bool = False

    # Classification
    classification: str = "unknown"
    classification_reason: str = ""

    # Concurrency: count of sibling plan:worker runs active during our window
    concurrent_siblings: int = 0


def iter_jsonl(path: Path):
    """Yield (line_no, dict) for each JSON line (1-indexed line_no)."""
    with path.open() as f:
        for i, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                yield i, json.loads(line)
            except Exception:
                continue


def parse_ts(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def scan_parent_session(path: Path) -> list[Spawn]:
    """Walk a parent-session JSONL; return one Spawn per plan:worker Agent call."""
    spawns: list[Spawn] = []
    tu_to_spawn: dict[str, Spawn] = {}
    session_id = path.stem
    for line_no, d in iter_jsonl(path):
        t = d.get("type")

        # 1) Detect a spawn: assistant tool_use with name=Agent and subagent_type=plan:worker
        if t == "assistant":
            msg = d.get("message") or {}
            for c in msg.get("content") or []:
                if not isinstance(c, dict):
                    continue
                if c.get("type") != "tool_use":
                    continue
                if c.get("name") != "Agent":
                    continue
                inp = c.get("input") or {}
                if inp.get("subagent_type") != "plan:worker":
                    continue
                prompt = inp.get("prompt") or ""
                m = TASK_ID_RE.search(prompt)
                if not m:
                    continue
                task_id = m.group(1)
                epic_id = task_id.rsplit(".", 1)[0]
                ctx_preamble = "CONTEXT:" in prompt
                tu_id = c.get("id") or ""
                sp = Spawn(
                    parent_session=session_id,
                    parent_file=path,
                    parent_line_no=line_no,
                    ts=parse_ts(d.get("timestamp")),
                    tool_use_id=tu_id,
                    task_id=task_id,
                    epic_id=epic_id,
                    ctx_preamble_in_prompt=ctx_preamble,
                )
                spawns.append(sp)
                if tu_id:
                    tu_to_spawn[tu_id] = sp

        # 2) Resolve agent_id from the Agent tool_result immediately after
        if t == "user":
            msg = d.get("message") or {}
            content = msg.get("content") or []
            if not isinstance(content, list):
                continue
            for c in content:
                if not isinstance(c, dict):
                    continue
                if c.get("type") != "tool_result":
                    continue
                tu_id = c.get("tool_use_id")
                if tu_id not in tu_to_spawn:
                    continue
                sp = tu_to_spawn[tu_id]
                tc = c.get("content")
                text = ""
                if isinstance(tc, str):
                    text = tc
                elif isinstance(tc, list):
                    for x in tc:
                        if isinstance(x, dict) and x.get("type") == "text":
                            text += x.get("text", "")
                m = re.search(r"agentId:\s*([a-f0-9]{10,})", text)
                if m:
                    sp.agent_id = m.group(1)

        # 3) Task-notification payload: user-type msg whose content str contains <task-notification>
        if t == "user":
            msg = d.get("message") or {}
            content = msg.get("content")
            text_blob = ""
            if isinstance(content, str):
                text_blob = content
            elif isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "text":
                        text_blob += c.get("text", "")
            if "<task-notification>" not in text_blob:
                continue
            m_tu = TASK_NOTIF_TU_ID_RE.search(text_blob)
            if not m_tu:
                continue
            tu_id = m_tu.group(1)
            if tu_id not in tu_to_spawn:
                continue
            sp = tu_to_spawn[tu_id]
            sp.notif_line_no = line_no
            m_status = TASK_NOTIF_STATUS_RE.search(text_blob)
            if m_status:
                sp.notif_status = m_status.group(1)
            m_usage = TASK_NOTIF_USAGE_RE.search(text_blob)
            if m_usage:
                sp.notif_total_tokens = int(m_usage.group(1))
                sp.notif_tool_uses = int(m_usage.group(2))
                sp.notif_duration_ms = int(m_usage.group(3))
            m_res = TASK_NOTIF_RESULT_RE.search(text_blob)
            if m_res:
                sp.notif_result_text = m_res.group(1).strip()

    return spawns


def enrich_from_subagent(sp: Spawn) -> None:
    if not sp.agent_id:
        return
    sub_file = (
        PROJECT_DIR / sp.parent_session / "subagents" / f"agent-{sp.agent_id}.jsonl"
    )
    if not sub_file.exists():
        return
    sp.sub_file = sub_file

    last_stop = None
    last_text = ""
    last_cache_read = None
    tool_uses = 0
    done_calls = 0
    last_tool_result_err = False
    last_tool_use_id = None
    first_ts = None
    last_ts = None
    total_output_tokens = 0
    phase6_summary_seen = False
    for _, d in iter_jsonl(sub_file):
        t = d.get("type")
        ts = parse_ts(d.get("timestamp"))
        if ts and t in ("assistant", "user"):
            if first_ts is None:
                first_ts = ts
            last_ts = ts
        if t == "assistant":
            msg = d.get("message") or {}
            sr = msg.get("stop_reason")
            content = msg.get("content") or []
            this_turn_text = ""
            this_turn_last_tu_id = None
            for c in content:
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "text":
                    txt = c.get("text", "")
                    if txt:
                        this_turn_text = txt
                        # Phase 6 summary template check
                        if "Implemented:" in txt and "Files changed:" in txt:
                            phase6_summary_seen = True
                elif c.get("type") == "tool_use":
                    tool_uses += 1
                    this_turn_last_tu_id = c.get("id")
                    inp = c.get("input") or {}
                    cmd = inp.get("command", "") if isinstance(inp, dict) else ""
                    if isinstance(cmd, str) and "planctl done" in cmd:
                        done_calls += 1
            usage = msg.get("usage") or {}
            cr = usage.get("cache_read_input_tokens")
            if cr:
                last_cache_read = cr
            out = usage.get("output_tokens")
            if out:
                total_output_tokens += out
            if sr:
                last_stop = sr
                if this_turn_text:
                    last_text = this_turn_text
                if this_turn_last_tu_id:
                    last_tool_use_id = this_turn_last_tu_id
        elif t == "user":
            msg = d.get("message") or {}
            content = msg.get("content") or []
            if isinstance(content, list):
                for c in content:
                    if not isinstance(c, dict):
                        continue
                    if c.get("type") != "tool_result":
                        continue
                    if c.get("tool_use_id") == last_tool_use_id:
                        if c.get("is_error"):
                            last_tool_result_err = True
                        tc = c.get("content")
                        text = ""
                        if isinstance(tc, str):
                            text = tc
                        elif isinstance(tc, list):
                            for x in tc:
                                if isinstance(x, dict) and x.get("type") == "text":
                                    text += x.get("text", "")
                        if text.lstrip().startswith("Error"):
                            last_tool_result_err = True

    sp.sub_last_stop_reason = last_stop
    sp.sub_last_text_tail = last_text.strip()[-250:]
    sp.sub_planctl_done_calls = done_calls
    sp.sub_total_tool_uses = tool_uses
    sp.sub_last_cache_read_tokens = last_cache_read
    sp.sub_last_tool_result_is_error = last_tool_result_err
    sp.sub_start_ts = first_ts
    sp.sub_end_ts = last_ts
    if first_ts and last_ts:
        sp.sub_duration_ms = int((last_ts - first_ts).total_seconds() * 1000)
    sp.sub_total_output_tokens = total_output_tokens
    sp.sub_phase6_summary_emitted = phase6_summary_seen


def classify(sp: Spawn) -> None:
    done_ok = sp.sub_planctl_done_calls >= 1
    end_turn = sp.sub_last_stop_reason == "end_turn"
    phase6 = sp.sub_phase6_summary_emitted
    if done_ok and end_turn and phase6:
        sp.classification = "healthy"
        sp.classification_reason = (
            f"planctl done x{sp.sub_planctl_done_calls}, end_turn, phase6 summary"
        )
        return
    if done_ok and end_turn and not phase6:
        sp.classification = "healthy_nosummary"
        sp.classification_reason = "done fired, end_turn, no Phase 6 summary"
        return
    if done_ok and sp.sub_last_stop_reason == "tool_use":
        sp.classification = "healthy_postdone_cut"
        sp.classification_reason = (
            f"done fired; last stop_reason=tool_use after done "
            f"(tool_uses={sp.sub_total_tool_uses})"
        )
        return
    if sp.sub_last_stop_reason == "tool_use" and not done_ok:
        if sp.sub_last_tool_result_is_error:
            sp.classification = "drop_tool_error"
        else:
            sp.classification = "drop_midtool"
        sp.classification_reason = (
            f"stop_reason=tool_use, planctl done={sp.sub_planctl_done_calls}, "
            f"tool_uses={sp.sub_total_tool_uses}"
        )
        return
    if end_turn and not done_ok:
        sp.classification = "drop_nodone"
        sp.classification_reason = "end_turn but no planctl done fired"
        return
    if sp.sub_file is None:
        sp.classification = "unknown_nosub"
        sp.classification_reason = f"no subagent jsonl (agent_id={sp.agent_id!r}, notif_status={sp.notif_status})"
        return
    sp.classification = "unknown"
    sp.classification_reason = f"stop_reason={sp.sub_last_stop_reason}, done={done_ok}"


def compute_concurrency(spawns: list[Spawn]) -> None:
    """For each spawn, count sibling spawns whose run-window overlaps.
    Run-window = [sub_start_ts, sub_end_ts] from the subagent JSONL
    (most reliable source). Falls back to parent spawn_ts + sub_duration_ms
    if sub_start_ts is missing.
    """

    def window(sp: Spawn) -> tuple[float, float] | None:
        if sp.sub_start_ts and sp.sub_end_ts:
            return (sp.sub_start_ts.timestamp(), sp.sub_end_ts.timestamp())
        if sp.ts and sp.sub_duration_ms:
            s = sp.ts.timestamp()
            return (s, s + sp.sub_duration_ms / 1000)
        return None

    by_sess: dict[str, list[Spawn]] = defaultdict(list)
    for sp in spawns:
        by_sess[sp.parent_session].append(sp)
    for group in by_sess.values():
        for a in group:
            wa = window(a)
            if wa is None:
                continue
            cnt = 0
            for b in group:
                if b is a:
                    continue
                wb = window(b)
                if wb is None:
                    continue
                if wa[0] < wb[1] and wb[0] < wa[1]:
                    cnt += 1
            a.concurrent_siblings = cnt


def discover_sessions(recent_days: int = 12) -> list[Path]:
    """Return JSONL session files modified in the last N days that contain
    at least one plan:worker spawn. Cheap prefilter by grepping for the
    literal subagent_type string.
    """
    now = datetime.now().timestamp()
    window = recent_days * 86400
    out: list[Path] = []
    for p in PROJECT_DIR.iterdir():
        if not p.is_file() or p.suffix != ".jsonl":
            continue
        try:
            st = p.stat()
        except Exception:
            continue
        if now - st.st_mtime > window:
            continue
        # Prefilter: cheap substring check
        try:
            with p.open("rb") as f:
                # Quick scan, up to a few MB
                blob = f.read(8 * 1024 * 1024)
                if b'"subagent_type":"plan:worker"' not in blob:
                    continue
        except Exception:
            continue
        out.append(p)
    return out


def main() -> int:
    sessions = discover_sessions(recent_days=30)
    # Also ensure the two scout-cited sessions are always included.
    must = [
        PROJECT_DIR / "12c59647-8bc1-46a0-983e-b3420edf9e5e.jsonl",
        PROJECT_DIR / "605d6fe5-8331-4850-b718-f8a3866dd146.jsonl",
    ]
    for m in must:
        if m.exists() and m not in sessions:
            sessions.append(m)
    sessions.sort(key=lambda p: p.stat().st_mtime, reverse=True)

    all_spawns: list[Spawn] = []
    for sess in sessions:
        all_spawns.extend(scan_parent_session(sess))

    for sp in all_spawns:
        enrich_from_subagent(sp)
        classify(sp)
    compute_concurrency(all_spawns)

    # Sort chronologically
    all_spawns.sort(key=lambda s: (s.ts or datetime.min, s.task_id))

    print(
        "| n | epic | task_id | parent_session[:8] | agent_id[:10] | ts_utc | tool_uses | duration_s | tokens_out | cache_read | stop_reason | classification | sibling# | ctx_preamble | done# | parent_file:line | last_text_tail |"
    )
    print(
        "|---|------|---------|--------------------|---------------|--------|----------:|-----------:|-----------:|----------:|-------------|----------------|---------:|:------------:|------:|------------------|-----------------|"
    )
    for i, sp in enumerate(all_spawns, start=1):
        tail = (
            (sp.sub_last_text_tail or sp.notif_result_text or "")
            .replace("\n", " ")
            .replace("|", "¦")
        )
        if len(tail) > 90:
            tail = tail[:87] + "..."
        ts = sp.ts.strftime("%Y-%m-%dT%H:%M:%SZ") if sp.ts else ""
        # Prefer subagent-derived duration (always available) over notif
        dur_ms = sp.sub_duration_ms or sp.notif_duration_ms
        dur = f"{dur_ms / 1000:.1f}" if dur_ms else ""
        tu = (
            sp.sub_total_tool_uses
            if sp.sub_total_tool_uses
            else (sp.notif_tool_uses or 0)
        )
        cache = (
            sp.sub_last_cache_read_tokens
            if sp.sub_last_cache_read_tokens is not None
            else ""
        )
        tok_out = sp.sub_total_output_tokens or sp.notif_total_tokens or ""
        sess = sp.parent_session[:8]
        aid = (sp.agent_id or "")[:10]
        line_ref = f"{sp.parent_file.name}:{sp.parent_line_no}"
        print(
            f"| {i} | {sp.epic_id} | {sp.task_id} | {sess} | {aid} | {ts} | {tu} | {dur} | {tok_out} | {cache} | {sp.sub_last_stop_reason or ''} | {sp.classification} | {sp.concurrent_siblings} | {'Y' if sp.ctx_preamble_in_prompt else ''} | {sp.sub_planctl_done_calls} | {line_ref} | {tail} |"
        )

    # Summary block
    print()
    HEALTHY = {"healthy", "healthy_nosummary", "healthy_postdone_cut"}
    DROPPED = {"drop_midtool", "drop_tool_error", "drop_nodone"}
    counts = defaultdict(int)
    for s in all_spawns:
        counts[s.classification] += 1
    total = len(all_spawns)
    epics = sorted({s.epic_id for s in all_spawns})
    sessions_sig = sorted({s.parent_session for s in all_spawns})
    print(f"Total invocations: {total}")
    print(f"Epics covered: {len(epics)} -> {epics}")
    print(f"Sessions: {len(sessions_sig)}")
    print("Classification counts:")
    for k in sorted(counts.keys()):
        print(f"  {k}: {counts[k]}")
    healthy_n = sum(counts[k] for k in HEALTHY)
    dropped_n = sum(counts[k] for k in DROPPED)
    print(f"Healthy (all variants): {healthy_n}/{total}")
    print(f"Dropped (all variants): {dropped_n}/{total}")

    # Concurrency breakdown -- only compare classified-either-way rows
    classified = [s for s in all_spawns if s.classification in HEALTHY | DROPPED]
    conc_rows = [s for s in classified if s.concurrent_siblings >= 1]
    serial_rows = [s for s in classified if s.concurrent_siblings == 0]
    conc_drop = sum(1 for s in conc_rows if s.classification in DROPPED)
    serial_drop = sum(1 for s in serial_rows if s.classification in DROPPED)
    print()
    print("Concurrency breakdown (classified rows only):")
    print(
        f"  with >=1 concurrent sibling: {conc_drop}/{len(conc_rows)} dropped "
        f"({(conc_drop / len(conc_rows) * 100 if conc_rows else 0):.0f}%)"
    )
    print(
        f"  serial (0 siblings):          {serial_drop}/{len(serial_rows)} dropped "
        f"({(serial_drop / len(serial_rows) * 100 if serial_rows else 0):.0f}%)"
    )

    # Respawn signal
    resumes = sum(1 for s in all_spawns if s.ctx_preamble_in_prompt)
    print(f"CONTEXT:-preamble respawns: {resumes}")

    # Signature stats on drops: tool_uses, duration, cache_read tokens
    drops = [s for s in all_spawns if s.classification in DROPPED]
    if drops:
        tu_list = [s.sub_total_tool_uses for s in drops if s.sub_total_tool_uses]
        cr_list = [
            s.sub_last_cache_read_tokens for s in drops if s.sub_last_cache_read_tokens
        ]
        dur_list = [s.sub_duration_ms for s in drops if s.sub_duration_ms]
        print()
        print("Drop signature stats (subagent-derived):")
        if tu_list:
            print(
                f"  tool_uses: min={min(tu_list)}, median={sorted(tu_list)[len(tu_list) // 2]}, max={max(tu_list)}"
            )
        if dur_list:
            print(
                f"  duration_s: min={min(dur_list) / 1000:.0f}, median={sorted(dur_list)[len(dur_list) // 2] / 1000:.0f}, max={max(dur_list) / 1000:.0f}"
            )
        if cr_list:
            print(
                f"  cache_read: min={min(cr_list)}, median={sorted(cr_list)[len(cr_list) // 2]}, max={max(cr_list)}"
            )
        drop_tool_err = sum(1 for s in drops if s.classification == "drop_tool_error")
        print(f"  with tool_result error: {drop_tool_err}/{len(drops)}")
    # Same stats on healthy for comparison
    healthies = [s for s in all_spawns if s.classification in HEALTHY]
    if healthies:
        tu_list = [s.sub_total_tool_uses for s in healthies if s.sub_total_tool_uses]
        dur_list = [s.sub_duration_ms for s in healthies if s.sub_duration_ms]
        cr_list = [
            s.sub_last_cache_read_tokens
            for s in healthies
            if s.sub_last_cache_read_tokens
        ]
        print()
        print("Healthy signature stats (for comparison):")
        if tu_list:
            print(
                f"  tool_uses: min={min(tu_list)}, median={sorted(tu_list)[len(tu_list) // 2]}, max={max(tu_list)}"
            )
        if dur_list:
            print(
                f"  duration_s: min={min(dur_list) / 1000:.0f}, median={sorted(dur_list)[len(dur_list) // 2] / 1000:.0f}, max={max(dur_list) / 1000:.0f}"
            )
        if cr_list:
            print(
                f"  cache_read: min={min(cr_list)}, median={sorted(cr_list)[len(cr_list) // 2]}, max={max(cr_list)}"
            )

    return 0


if __name__ == "__main__":
    sys.exit(main())
