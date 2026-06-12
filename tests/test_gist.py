"""Tests for ``planctl gist <epic_id>``.

``gist`` renders an epic's TOC + epic spec + every task spec into a temp dir and
shells ``gh gist create --desc <desc> [--public] <files...>``, taking the last
stdout line as the gist URL and (unless ``--no-open``) opening it in a browser.
It is read-only locally — no ``.planctl/`` commit — but the ``gh`` dependency is
the whole contract, so these tests stub ``gh`` with a PATH-shim fake binary (an
executable temp script that records its argv + env and emits a controlled
URL / exit code), mirroring the fake-binary pattern in
``tests/test_generated_guard_hook.py``.

Every test passes ``--no-open`` so the real ``webbrowser.open`` never fires and
pops a browser during the suite.

Engine-agnostic via ``run_cli``: the shim dir is prepended to ``PATH`` through
the per-call ``env`` (honoured by both the in-process engine, which patches
``os.environ``, and the conformance subprocess engine, which layers ``env`` over
its minimal explicit env). Marked ``wire`` — a fake-binary test belongs with its
stub-contract kin in the slow bucket.
"""

from __future__ import annotations

import json
import os
import textwrap
from pathlib import Path

import pytest

from .conftest import run_cli, seed_state

pytestmark = pytest.mark.wire


def _make_fake_gh(
    bin_dir: Path, *, url: str = "https://gist.github.com/abc123", exit_code: int = 0
) -> Path:
    """Drop a fake ``gh`` on PATH that records argv + env and emits *url*.

    Writes ``<bin_dir>/gh-argv`` (one arg per line) and ``<bin_dir>/gh-cwd``, then
    prints *url* on stdout and exits *exit_code*. On a non-zero exit it prints an
    error line to stderr so the failure path has something to surface.
    """
    bin_dir.mkdir(parents=True, exist_ok=True)
    record = bin_dir / "gh-argv"
    shim = bin_dir / "gh"
    shim.write_text(
        textwrap.dedent(
            f"""\
            #!/usr/bin/env python3
            import sys
            with open({str(record)!r}, "w") as fh:
                fh.write("\\n".join(sys.argv[1:]) + "\\n")
            if {exit_code} != 0:
                sys.stderr.write("fake gh: simulated failure\\n")
                sys.exit({exit_code})
            sys.stdout.write({url!r} + "\\n")
            """
        )
    )
    shim.chmod(0o755)
    return record


def _gist_env(bin_dir: Path) -> dict:
    return {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"}


def _envelope(output: str) -> dict:
    """First JSON object on stdout carrying a gist/error key.

    Scans with ``raw_decode`` rather than line-by-line: ``format_output``
    pretty-prints with ``indent=2``, so an envelope spans multiple lines.
    """
    decoder = json.JSONDecoder()
    idx = 0
    while idx < len(output):
        brace = output.find("{", idx)
        if brace == -1:
            break
        try:
            obj, end = decoder.raw_decode(output, brace)
        except json.JSONDecodeError:
            idx = brace + 1
            continue
        if isinstance(obj, dict) and (
            "gist_url" in obj or "error" in obj or "success" in obj
        ):
            return obj
        idx = end
    raise AssertionError(f"no gist envelope in {output!r}")


def _seed(tmp_path: Path, *, n_tasks: int = 2):
    return seed_state(tmp_path, epic_id="fn-7-gist-demo", n_tasks=n_tasks)


def test_gist_success_envelope(tmp_path):
    """Happy path pins {gist_url, epic_id, file_count, public}."""
    bin_dir = tmp_path / "stub-bin"
    _make_fake_gh(bin_dir, url="https://gist.github.com/deadbeef")
    epic_id, _ = _seed(tmp_path, n_tasks=2)

    result = run_cli(
        ["gist", epic_id, "--no-open"], cwd=tmp_path, env=_gist_env(bin_dir)
    )
    assert result.exit_code == 0, result.output
    env = _envelope(result.output)
    assert env["gist_url"] == "https://gist.github.com/deadbeef"
    assert env["epic_id"] == epic_id
    # TOC + epic spec + one file per task.
    assert env["file_count"] == 2 + 2
    assert env["public"] is False


def test_gist_file_set_passed_to_gh(tmp_path):
    """gh receives `gist create --desc <desc> <files...>`; files == file_count."""
    bin_dir = tmp_path / "stub-bin"
    record = _make_fake_gh(bin_dir)
    epic_id, _ = _seed(tmp_path, n_tasks=2)

    result = run_cli(
        ["gist", epic_id, "--no-open"], cwd=tmp_path, env=_gist_env(bin_dir)
    )
    assert result.exit_code == 0, result.output

    argv = record.read_text(encoding="utf-8").splitlines()
    assert argv[:3] == ["gist", "create", "--desc"]
    assert "--public" not in argv
    files = [a for a in argv[4:] if a.endswith(".md")]
    # TOC + epic spec + 2 task specs.
    assert len(files) == 4
    assert any(f.endswith("00-TOC.md") for f in files)


def test_gist_public_flag(tmp_path):
    """--public adds `--public` to the gh argv and rides into the envelope."""
    bin_dir = tmp_path / "stub-bin"
    record = _make_fake_gh(bin_dir)
    epic_id, _ = _seed(tmp_path, n_tasks=1)

    result = run_cli(
        ["gist", epic_id, "--public", "--no-open"],
        cwd=tmp_path,
        env=_gist_env(bin_dir),
    )
    assert result.exit_code == 0, result.output
    assert _envelope(result.output)["public"] is True
    assert "--public" in record.read_text(encoding="utf-8").splitlines()


def test_gist_gh_failure(tmp_path):
    """A non-zero gh exit surfaces an error envelope, not a URL."""
    bin_dir = tmp_path / "stub-bin"
    _make_fake_gh(bin_dir, exit_code=1)
    epic_id, _ = _seed(tmp_path, n_tasks=1)

    result = run_cli(
        ["gist", epic_id, "--no-open"], cwd=tmp_path, env=_gist_env(bin_dir)
    )
    assert result.exit_code != 0
    env = _envelope(result.output)
    assert "gh gist create failed" in (
        env.get("error", {}).get("message", "")
        if isinstance(env.get("error"), dict)
        else str(env.get("error", ""))
    )
