"""Tests for InvocationTrackedGroup decorator hardening.

Covers:
- Raise path: a verb that raises does NOT emit a planctl_invocation line.
- Raise path: after a raise, cmd.invoke is restored to the original function.
- _extract_target canonical arg-name preference over positional order.
- _extract_target fallback policy (a): non-``fn-`` first-arg returns None.
"""

from __future__ import annotations

import click
from click.testing import CliRunner
from planctl.cli import _TARGET_ARG_NAMES, InvocationTrackedGroup, _extract_target

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_group_with_raising_cmd() -> tuple[click.Group, click.Command, list]:
    """Build a tiny InvocationTrackedGroup with one command that raises RuntimeError.

    Returns (group, cmd, original_invoke_store) where original_invoke_store is a
    one-element list so the test can compare against the pre-patch function.
    """
    original_store: list = []

    @click.group(cls=InvocationTrackedGroup)
    def grp():
        pass

    @grp.command("boom")
    @click.argument("task_id")
    def boom_cmd(task_id):
        raise RuntimeError("intentional test failure")

    # Capture the original invoke before the decorator patches it.
    # We do this by looking it up after registration.
    original_store.append(boom_cmd.invoke)
    return grp, boom_cmd, original_store


# ---------------------------------------------------------------------------
# Test 1: raise path does NOT emit a planctl_invocation line
# ---------------------------------------------------------------------------


def test_raise_path_does_not_emit_invocation():
    """A verb that raises must not produce a planctl_invocation JSON line."""
    grp, _, _ = _make_group_with_raising_cmd()
    runner = CliRunner()
    result = runner.invoke(grp, ["boom", "fn-1-test.1"], catch_exceptions=True)

    # The exception is captured by CliRunner; the exit code is non-zero.
    assert result.exit_code != 0

    # No planctl_invocation line should appear anywhere in output.
    for line in result.output.splitlines():
        stripped = line.strip()
        if stripped:
            assert "planctl_invocation" not in stripped, (
                f"Unexpected planctl_invocation line in output: {line!r}"
            )


# ---------------------------------------------------------------------------
# Test 2: raise path restores original invoke
# ---------------------------------------------------------------------------


def test_raise_path_restores_original_invoke():
    """After a raise, cmd.invoke must be restored to the pre-decorator function.

    ``cmd.invoke`` is a bound method so each attribute access yields a fresh
    object — identity (``is``) comparisons always fail.  The decorator patches
    via instance-dict assignment (``cmd.invoke = _tracked_invoke``), so the
    correct assertion is that the restored value's ``__func__`` matches the
    original class-level ``invoke`` implementation, not the ``_tracked_invoke``
    closure.
    """
    grp, boom_cmd, _ = _make_group_with_raising_cmd()

    runner = CliRunner()
    runner.invoke(grp, ["boom", "fn-1-test.1"], catch_exceptions=True)

    # After finally: restores, the instance invoke must NOT be the closure.
    # A closure has no __func__ referencing click.Command.invoke.
    restored = boom_cmd.__dict__.get("invoke")
    assert restored is not None, (
        "cmd.invoke not present in instance __dict__ after restore"
    )

    # The restored function must be the class-level invoke, not a plain closure.
    # Closures (like _tracked_invoke) have no __func__ attribute.
    assert hasattr(restored, "__func__"), (
        "cmd.invoke was not restored to a bound method — "
        "the _tracked_invoke closure was left in place"
    )
    assert restored.__func__ is click.core.Command.invoke, (
        f"cmd.invoke.__func__ is not Command.invoke after restore; got {restored.__func__!r}"
    )


# ---------------------------------------------------------------------------
# Test 3: _extract_target prefers canonical arg name over positional order
# ---------------------------------------------------------------------------


def test_extract_target_prefers_canonical_arg_name():
    """_extract_target returns the canonical-named arg's value, not the first positional."""

    @click.command("mv")
    @click.argument("path")
    @click.argument("task_id")
    def mv_cmd(path, task_id):
        pass  # pragma: no cover

    # Build a context with params that simulate a parsed invocation.
    ctx = click.Context(mv_cmd)
    ctx.params = {"path": "fn-foo-something", "task_id": "fn-7-real.1"}

    result = _extract_target(ctx)

    assert result == "fn-7-real.1", (
        f"Expected canonical arg value 'fn-7-real.1', got {result!r}"
    )


# ---------------------------------------------------------------------------
# Test 4: _extract_target prefers canonical name even when first arg is non-fn-
# ---------------------------------------------------------------------------


def test_extract_target_prefers_canonical_name_over_first_arg():
    """_extract_target returns the canonical-named arg, ignoring non-canonical first arg.

    The non-canonical first arg has a value that does NOT start with ``fn-``,
    confirming that the canonical-name branch has no ``fn-`` shape gate and
    returns any string value unconditionally.
    """

    @click.command("assign")
    @click.argument("name")
    @click.argument("epic_id")
    def assign_cmd(name, epic_id):
        pass  # pragma: no cover

    ctx = click.Context(assign_cmd)
    ctx.params = {"name": "alice", "epic_id": "fn-42-some-epic"}

    result = _extract_target(ctx)

    assert result == "fn-42-some-epic", (
        f"Expected canonical arg value 'fn-42-some-epic', got {result!r}"
    )


# ---------------------------------------------------------------------------
# Test 5: _extract_target fallback policy (a) — non-fn- first arg returns None
# ---------------------------------------------------------------------------


def test_extract_target_fallback_policy_non_fn_returns_none():
    """_extract_target returns None when the only positional arg value lacks the fn- prefix.

    Policy (a): the fallback branch gates on ``val.startswith("fn-")``.  A
    value like ``"alice"`` does not pass the gate, so None is returned rather
    than leaking an arbitrary string into the envelope's ``target`` field.
    """

    @click.command("greet")
    @click.argument("name")
    def greet_cmd(name):
        pass  # pragma: no cover

    ctx = click.Context(greet_cmd)
    ctx.params = {"name": "alice"}

    result = _extract_target(ctx)

    assert result is None, (
        f"Expected None for non-fn- first-arg value under policy (a), got {result!r}"
    )


# ---------------------------------------------------------------------------
# Sanity: _TARGET_ARG_NAMES contains the expected canonical names
# ---------------------------------------------------------------------------


def test_target_arg_names_constant():
    """_TARGET_ARG_NAMES must contain the four canonical planctl arg names."""
    assert {"id", "task_id", "epic_id", "dep_id"} <= set(_TARGET_ARG_NAMES)
