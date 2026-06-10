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
import subprocess
import textwrap
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PRE_HOOK = REPO_ROOT / "plugin" / "hooks" / "pre-hook.py"
POST_HOOK = REPO_ROOT / "plugin" / "hooks" / "post-hook.py"


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
