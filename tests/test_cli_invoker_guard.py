"""Guard: the unified ``run_cli`` invoker is the sole CLI entry seam.

Every test that drives the real ``planctl`` CLI routes through
``tests.conftest.run_cli`` so a single switch (``PLANCTL_BIN``) flips the whole
suite between the in-process and the subprocess (conformance) engine. A stray
``CliRunner()`` instantiation would silently pin that callsite to the
in-process engine forever, eroding the conformance gate — so this test fails the
moment one reappears outside the sanctioned allowlist.

Allowlist (the only files permitted to instantiate ``CliRunner`` directly):

* ``conftest.py`` — the invoker implementation itself (its in-process engine
  is intentionally CliRunner-free, but the allowlist keeps the seam honest if
  that ever changes).
* ``test_util_vendored.py`` and ``cli_decorator/test_decorator_hardening.py`` —
  these drive *synthetic* click groups they build inline (a bare
  ``FormattedGroup`` / ``InvocationTrackedGroup``), never ``planctl.cli.cli``.
  ``run_cli`` only knows the real CLI, so it cannot stand in for them.
"""

from __future__ import annotations

import ast
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent

# Files allowed to instantiate CliRunner directly. Relative to ``tests/``.
_ALLOWLIST = frozenset(
    {
        "conftest.py",
        "test_util_vendored.py",
        "cli_decorator/test_decorator_hardening.py",
    }
)


def _instantiates_cli_runner(source: str) -> bool:
    """True iff *source* contains a real ``CliRunner(...)`` call.

    Parses the AST so string-literal or comment mentions of ``CliRunner`` (which
    pepper the conftest docstrings) never count — only an actual call node does.
    """
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = (
            func.id
            if isinstance(func, ast.Name)
            else func.attr
            if isinstance(func, ast.Attribute)
            else None
        )
        if name == "CliRunner":
            return True
    return False


def test_no_cli_runner_outside_invoker():
    """No test file instantiates ``CliRunner`` outside the sanctioned allowlist."""
    offenders: list[str] = []
    for path in _TESTS_DIR.rglob("test_*.py"):
        rel = path.relative_to(_TESTS_DIR).as_posix()
        if rel in _ALLOWLIST:
            continue
        if _instantiates_cli_runner(path.read_text(encoding="utf-8")):
            offenders.append(rel)
    # conftest.py is not matched by the test_*.py glob, but assert it stays
    # CliRunner-free anyway so the in-process engine never regrows the dependency.
    conftest = _TESTS_DIR / "conftest.py"
    assert not _instantiates_cli_runner(conftest.read_text(encoding="utf-8")), (
        "tests/conftest.py must not instantiate CliRunner — the in-process "
        "engine drives cli.main directly."
    )
    assert offenders == [], (
        "These files instantiate CliRunner directly instead of routing through "
        f"the unified run_cli invoker: {offenders}. Route CLI calls through "
        "tests.conftest.run_cli so the conformance engine can drive them."
    )
