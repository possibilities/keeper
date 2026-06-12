"""Unit tests for plugin/hooks/{pre,post}-hook.py.

The hooks shell out to ``promptctl check-generated`` and translate the
envelope into ``permissionDecision: deny`` (pre-hook) or
``additionalContext`` (post-hook). Tests stub ``promptctl`` on PATH with a
tiny fake that echoes a canned envelope so we exercise the hook plumbing
without depending on the real promptctl binary.

Mirrors arthack's ``apps/hookctl/tests/unit/test_generated_guard_hook.py``
pattern — these are the canary that proves the planctl plugin's native
hook actually fires on Write/Edit/Read.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
PRE_HOOK = REPO_ROOT / "plugin" / "hooks" / "pre-hook.py"
POST_HOOK = REPO_ROOT / "plugin" / "hooks" / "post-hook.py"
COMMIT_GUARD = REPO_ROOT / "plugin" / "hooks" / "commit-guard.ts"
SUBAGENT_STOP_GUARD = REPO_ROOT / "plugin" / "hooks" / "subagent-stop-guard.ts"
STOP_GUARD = REPO_ROOT / "plugin" / "hooks" / "stop-guard.ts"
LIB_TS = REPO_ROOT / "plugin" / "hooks" / "lib.ts"


def _make_stub_promptctl(tmp_path: Path, envelope: dict) -> Path:
    """Drop a fake ``promptctl`` shim that echoes the given envelope.

    Returns a bin dir to prepend to PATH. The shim ignores its args and
    always emits the same envelope — sufficient for hook-plumbing tests.
    """
    bin_dir = tmp_path / "stub-bin"
    bin_dir.mkdir()
    shim = bin_dir / "promptctl"
    shim.write_text(
        textwrap.dedent(
            f"""\
            #!/usr/bin/env python3
            import json, sys
            sys.stdout.write(json.dumps({envelope!r}) + "\\n")
            """
        )
    )
    shim.chmod(0o755)
    return bin_dir


def _run_hook(
    hook: Path, stdin_data: dict, path_prefix: Path
) -> subprocess.CompletedProcess:
    env = {**os.environ, "PATH": f"{path_prefix}:{os.environ.get('PATH', '')}"}
    return subprocess.run(
        ["python3", str(hook)],
        input=json.dumps(stdin_data),
        capture_output=True,
        text=True,
        env=env,
    )


# ---------------------------------------------------------------------------
# hooks.json wiring sanity — co-location + matcher shape (CC #45296 guard)
# ---------------------------------------------------------------------------


def test_hooks_json_colocated_at_plugin_root() -> None:
    """``hooks/hooks.json`` must live at the plugin root (next to
    ``.claude-plugin/``). CC bug #45296 silently deletes externally-placed
    hooks.json files — co-location is mandatory.
    """
    hooks_json = REPO_ROOT / "hooks" / "hooks.json"
    plugin_manifest = REPO_ROOT / ".claude-plugin" / "plugin.json"
    assert hooks_json.is_file(), f"missing {hooks_json}"
    assert plugin_manifest.is_file(), f"missing {plugin_manifest}"


def test_hooks_json_wires_pre_and_post() -> None:
    """hooks.json registers PreToolUse(Write|Edit) and PostToolUse(Read)
    handlers pointing at the in-repo hook scripts via ``${CLAUDE_PLUGIN_ROOT}``.
    """
    data = json.loads((REPO_ROOT / "hooks" / "hooks.json").read_text())
    hooks = data["hooks"]
    assert "PreToolUse" in hooks
    assert "PostToolUse" in hooks

    pre_entry = hooks["PreToolUse"][0]
    assert pre_entry["matcher"] == "Write|Edit"
    pre_cmd = pre_entry["hooks"][0]["command"]
    assert "${CLAUDE_PLUGIN_ROOT}" in pre_cmd
    assert pre_cmd.endswith("plugin/hooks/pre-hook.py")

    post_entry = hooks["PostToolUse"][0]
    assert post_entry["matcher"] == "Read"
    post_cmd = post_entry["hooks"][0]["command"]
    assert "${CLAUDE_PLUGIN_ROOT}" in post_cmd
    assert post_cmd.endswith("plugin/hooks/post-hook.py")


def test_hook_scripts_are_executable() -> None:
    """Both hook scripts must be marked executable — CC invokes them
    directly via the command string, not via a python3 prefix.
    """
    assert os.access(PRE_HOOK, os.X_OK), f"{PRE_HOOK} not executable"
    assert os.access(POST_HOOK, os.X_OK), f"{POST_HOOK} not executable"


# ---------------------------------------------------------------------------
# orchestrator guard wiring — commit-guard / subagent-stop-guard / stop-guard
# ---------------------------------------------------------------------------


def _exec_form_cmd(entry: dict, basename: str) -> dict:
    """Find the inner hook within ``entry`` whose exec-form args point at the
    ``plugin/hooks/<basename>`` bun script. Asserts exec form along the way.
    """
    for inner in entry["hooks"]:
        if inner.get("command") != "bun":
            continue
        args = inner.get("args", [])
        if args and args[0].endswith(f"plugin/hooks/{basename}"):
            assert inner["type"] == "command"
            assert "${CLAUDE_PLUGIN_ROOT}" in args[0]
            return inner
    raise AssertionError(f"no exec-form bun entry for {basename} in {entry!r}")


def test_hooks_json_registers_commit_guard() -> None:
    """PreToolUse carries a Bash-matcher exec-form entry → commit-guard.ts,
    alongside the untouched Write|Edit pre-hook entry.
    """
    hooks = json.loads((REPO_ROOT / "hooks" / "hooks.json").read_text())["hooks"]
    pre = hooks["PreToolUse"]

    write_edit = next(e for e in pre if e.get("matcher") == "Write|Edit")
    assert write_edit["hooks"][0]["command"].endswith("plugin/hooks/pre-hook.py")

    bash_entry = next(e for e in pre if e.get("matcher") == "Bash")
    _exec_form_cmd(bash_entry, "commit-guard.ts")


def test_hooks_json_registers_subagent_stop_guard() -> None:
    """SubagentStop matches the four plan:worker-* agent types and execs the
    subagent-stop-guard.ts dispatcher.
    """
    hooks = json.loads((REPO_ROOT / "hooks" / "hooks.json").read_text())["hooks"]
    entry = hooks["SubagentStop"][0]
    matcher = entry["matcher"]
    for tier in ("medium", "high", "xhigh", "max"):
        assert f"plan:worker-{tier}" in matcher
    _exec_form_cmd(entry, "subagent-stop-guard.ts")


def test_hooks_json_registers_stop_guard() -> None:
    """Stop carries a matcher-less exec-form entry → stop-guard.ts."""
    hooks = json.loads((REPO_ROOT / "hooks" / "hooks.json").read_text())["hooks"]
    entry = hooks["Stop"][0]
    assert "matcher" not in entry
    _exec_form_cmd(entry, "stop-guard.ts")


def test_hooks_json_post_read_entry_intact() -> None:
    """The PostToolUse(Read) warn entry is untouched by the guard wiring."""
    hooks = json.loads((REPO_ROOT / "hooks" / "hooks.json").read_text())["hooks"]
    post = hooks["PostToolUse"][0]
    assert post["matcher"] == "Read"
    assert post["hooks"][0]["command"].endswith("plugin/hooks/post-hook.py")


# ---------------------------------------------------------------------------
# guard stubs — fail-open: read stdin, exit 0, no stdout (slow bucket: bun)
# ---------------------------------------------------------------------------

_GUARD_FIXTURES = {
    COMMIT_GUARD: {
        "hook_event_name": "PreToolUse",
        "session_id": "smoke",
        "tool_name": "Bash",
        "tool_input": {"command": "git commit -m x"},
    },
    SUBAGENT_STOP_GUARD: {
        "hook_event_name": "SubagentStop",
        "session_id": "smoke",
        "agent_id": "agent-1",
        "agent_type": "plan:worker-high",
    },
    STOP_GUARD: {
        "hook_event_name": "Stop",
        "session_id": "smoke",
        "stop_hook_active": False,
    },
}


@pytest.mark.integration
@pytest.mark.parametrize("guard", list(_GUARD_FIXTURES), ids=lambda p: p.name)
def test_guard_stub_reads_stdin_and_exits_clean(guard: Path) -> None:
    """Each dispatcher stub consumes its fixture stdin, exits 0, and writes
    nothing to stdout — the fail-open baseline tasks 3-5 build on.
    """
    bun = shutil.which("bun")
    if bun is None:
        pytest.skip("bun not on PATH")
    result = subprocess.run(
        [bun, str(guard)],
        input=json.dumps(_GUARD_FIXTURES[guard]),
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == "", result.stdout


@pytest.mark.integration
@pytest.mark.parametrize("guard", list(_GUARD_FIXTURES), ids=lambda p: p.name)
def test_guard_stub_bypass_exits_clean(guard: Path) -> None:
    """With PLANCTL_GUARD_BYPASS=1 the stub short-circuits before any I/O and
    still exits 0 silently.
    """
    bun = shutil.which("bun")
    if bun is None:
        pytest.skip("bun not on PATH")
    result = subprocess.run(
        [bun, str(guard)],
        input=json.dumps(_GUARD_FIXTURES[guard]),
        capture_output=True,
        text=True,
        timeout=30,
        env={**os.environ, "PLANCTL_GUARD_BYPASS": "1"},
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == ""


# ---------------------------------------------------------------------------
# pre-hook (PreToolUse Write/Edit → deny)
# ---------------------------------------------------------------------------


def test_pre_hook_marked_file_emits_deny(tmp_path: Path) -> None:
    """A `marked: true` envelope from promptctl → permissionDecision: deny."""
    envelope = {
        "marked": True,
        "mode": "block",
        "source_template": "/path/to/template/agents/worker.md.tmpl",
        "source_template_relative": "template/agents/worker.md.tmpl",
        "regenerate_cmd": "promptctl render-plugin-templates --project-root /repo",
        "message": (
            "BLOCKED: this is a generated file. "
            "Edit /path/to/template/agents/worker.md.tmpl instead."
        ),
    }
    bin_dir = _make_stub_promptctl(tmp_path, envelope)

    target = tmp_path / "agents" / "worker-high.md"
    target.parent.mkdir(parents=True)
    target.write_text("doesn't matter — stub doesn't read it\n")

    result = _run_hook(
        PRE_HOOK,
        {
            "tool_name": "Write",
            "tool_input": {"file_path": str(target)},
        },
        bin_dir,
    )
    assert result.returncode == 0, result.stderr
    output = json.loads(result.stdout)
    spec = output["hookSpecificOutput"]
    assert spec["hookEventName"] == "PreToolUse"
    assert spec["permissionDecision"] == "deny"
    assert "BLOCKED" in spec["permissionDecisionReason"]
    assert "/path/to/template/agents/worker.md.tmpl" in spec["permissionDecisionReason"]


def test_pre_hook_unmarked_file_passes_silently(tmp_path: Path) -> None:
    """`marked: false` → silent pass-through, no stdout."""
    bin_dir = _make_stub_promptctl(tmp_path, {"marked": False})
    target = tmp_path / "plain.md"
    target.write_text("plain body\n")

    result = _run_hook(
        PRE_HOOK,
        {
            "tool_name": "Write",
            "tool_input": {"file_path": str(target)},
        },
        bin_dir,
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_pre_hook_no_file_path_passes(tmp_path: Path) -> None:
    """Missing file_path → silent pass-through, no subprocess call."""
    bin_dir = _make_stub_promptctl(tmp_path, {"marked": True, "message": "irrelevant"})
    result = _run_hook(
        PRE_HOOK,
        {"tool_name": "Write", "tool_input": {}},
        bin_dir,
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_pre_hook_broken_promptctl_passes_silently(tmp_path: Path) -> None:
    """promptctl returning a non-zero exit → silent pass-through (fail-open).

    The pre-hook must NEVER block a Write/Edit just because promptctl is
    broken — a hot-path hook that fails closed would brick every write
    across the agent surface.
    """
    bin_dir = tmp_path / "stub-bin"
    bin_dir.mkdir()
    shim = bin_dir / "promptctl"
    shim.write_text("#!/usr/bin/env python3\nimport sys\nsys.exit(99)\n")
    shim.chmod(0o755)

    target = tmp_path / "marked.md"
    target.write_text("---\n_promptctl_path: foo.tmpl\n---\nbody\n")

    result = _run_hook(
        PRE_HOOK,
        {"tool_name": "Write", "tool_input": {"file_path": str(target)}},
        bin_dir,
    )
    assert result.returncode == 0
    assert result.stdout == ""


# ---------------------------------------------------------------------------
# post-hook (PostToolUse Read → additionalContext)
# ---------------------------------------------------------------------------


def test_post_hook_marked_file_emits_additional_context(tmp_path: Path) -> None:
    """A `marked: true` envelope from promptctl → additionalContext message."""
    envelope = {
        "marked": True,
        "mode": "warn",
        "source_template": "/repo/template/agents/worker.md.tmpl",
        "source_template_relative": "template/agents/worker.md.tmpl",
        "regenerate_cmd": "promptctl render-plugin-templates --project-root /repo",
        "message": (
            "Heads-up: this is a generated file. "
            "Source: /repo/template/agents/worker.md.tmpl."
        ),
    }
    bin_dir = _make_stub_promptctl(tmp_path, envelope)
    target = tmp_path / "agents" / "worker.md"
    target.parent.mkdir()
    target.write_text("body\n")

    result = _run_hook(
        POST_HOOK,
        {
            "tool_name": "Read",
            "tool_input": {"file_path": str(target)},
        },
        bin_dir,
    )
    assert result.returncode == 0, result.stderr
    output = json.loads(result.stdout)
    spec = output["hookSpecificOutput"]
    assert spec["hookEventName"] == "PostToolUse"
    assert "Heads-up" in spec["additionalContext"]
    assert "/repo/template/agents/worker.md.tmpl" in spec["additionalContext"]


def test_post_hook_non_read_tool_passes(tmp_path: Path) -> None:
    """post-hook only fires on Read — anything else is a no-op."""
    bin_dir = _make_stub_promptctl(tmp_path, {"marked": True, "message": "x"})
    result = _run_hook(
        POST_HOOK,
        {
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
        },
        bin_dir,
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_post_hook_unmarked_file_passes_silently(tmp_path: Path) -> None:
    """`marked: false` → no additionalContext injection."""
    bin_dir = _make_stub_promptctl(tmp_path, {"marked": False})
    target = tmp_path / "plain.md"
    target.write_text("plain\n")
    result = _run_hook(
        POST_HOOK,
        {
            "tool_name": "Read",
            "tool_input": {"file_path": str(target)},
        },
        bin_dir,
    )
    assert result.returncode == 0
    assert result.stdout == ""

# ---------------------------------------------------------------------------
# cross-language marker round-trip — Python _write_marker → TS readMarker
# (slow bucket: real bun subprocess + real Python write path)
# ---------------------------------------------------------------------------

# A bun probe that imports the REAL readMarker from lib.ts, reads the marker for
# the session id in argv[1], and prints {kind, task_id, epic_id, schema_version}
# as JSON. Reading through the production reader is the point: a field-name or
# `kind` rename on either side surfaces as a missing/mismatched field here.
_TS_READ_PROBE = """\
import {{ readMarker }} from {lib_import};
const marker = await readMarker(process.argv[2]);
if (marker === null) {{
  process.stdout.write(JSON.stringify({{ ok: false }}) + "\\n");
}} else {{
  process.stdout.write(
    JSON.stringify({{
      ok: true,
      kind: marker.kind,
      task_id: marker.task_id,
      epic_id: marker.epic_id,
      schema_version: marker.schema_version,
    }}) + "\\n",
  );
}}
"""


def _write_marker_via_python(home: Path, session_id: str, task_id: str) -> None:
    """Drive the real Python success-path writer (``write_work_marker``) in a
    subprocess so the marker dir resolves from ``HOME`` exactly as production
    does — no monkeypatch, no hand-rolled JSON.
    """
    code = (
        "from planctl.session_markers import write_work_marker; "
        f"write_work_marker({task_id!r})"
    )
    env = {
        **os.environ,
        "HOME": str(home),
        "CLAUDE_CODE_SESSION_ID": session_id,
    }
    result = subprocess.run(
        ["python3", "-c", code],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env=env,
    )
    assert result.returncode == 0, result.stderr


def _read_marker_via_bun(bun: str, home: Path, session_id: str) -> dict:
    """Read the marker back through the real TS ``readMarker`` via bun."""
    probe = home / "read_probe.ts"
    probe.write_text(
        _TS_READ_PROBE.format(lib_import=json.dumps(str(LIB_TS))),
        encoding="utf-8",
    )
    env = {**os.environ, "HOME": str(home)}
    result = subprocess.run(
        [bun, str(probe), session_id],
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout.strip())


@pytest.mark.integration
def test_marker_round_trips_python_write_to_ts_read(tmp_path: Path) -> None:
    """A marker written by the Python success path (``write_work_marker``) is
    read back through the real TS ``readMarker`` (true bun subprocess), and the
    task identity survives the crossing.

    This pins the cross-language contract: ``_write_marker`` and the TS reader
    agree on field names and ``kind`` values. Drift on either side fails this
    test (verify locally by renaming ``task_id`` on one side — the assert below
    on the round-tripped id breaks).
    """
    bun = shutil.which("bun")
    if bun is None:
        pytest.skip("bun not on PATH")

    home = tmp_path / "home"
    home.mkdir()
    session_id = "round-trip-session"
    task_id = "fn-99-some-epic.3"

    _write_marker_via_python(home, session_id, task_id)
    parsed = _read_marker_via_bun(bun, home, session_id)

    assert parsed["ok"] is True, "TS reader returned null for a freshly written marker"
    assert parsed["kind"] == "work"
    assert parsed["task_id"] == task_id
    # A work marker carries no epic_id — JSON.stringify drops the undefined key.
    assert "epic_id" not in parsed
    assert parsed["schema_version"] == 1
