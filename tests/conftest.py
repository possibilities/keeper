"""Shared pytest fixtures for planctl tests."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest
from click.testing import CliRunner
from planctl.cli import cli


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "real_git: exercise the real .planctl/ auto-commit (status+add+commit+"
        "rev-parse). Default tests no-op it — git is tested only where asserted.",
    )


@pytest.fixture(autouse=True)
def _mock_autocommit(request, monkeypatch):
    """No-op the ``.planctl/`` auto-commit unless a test opts into real git.

    The commit-at-mutation-boundary machinery is the product, so it IS tested
    for real — but only in the modules that assert on git state (marked
    ``real_git``: ``test_commit``/``test_emit``/``test_init`` and friends).
    Every other test merely needs the verb to succeed and the on-disk
    ``.planctl/`` files to exist (planctl reads state from disk, never from
    HEAD), so the real status+add+commit+rev-parse cycle is pure overhead —
    ~4 git subprocesses per mutating verb.

    Mocking (rather than a production bypass flag) keeps the speed-up entirely
    in the harness: prod code carries no test-only branch. The stub mirrors the
    real return contract (``None`` for a no-op payload, a sentinel sha
    otherwise) so truthiness checks still behave.
    """
    if request.node.get_closest_marker("real_git"):
        return

    import planctl.commit as _commit

    def _noop(payload: dict) -> str | None:
        return None if not payload.get("files") else "0" * 40

    monkeypatch.setattr(_commit, "auto_commit_from_invocation", _noop)


@pytest.fixture(scope="session", autouse=True)
def _git_global_config(tmp_path_factory):
    """Hoist the per-repo git config out of every fixture into one global file.

    Each test repo needs the same four settings — committer identity,
    ``commit.gpgsign=false``, ``core.hooksPath=/dev/null`` — to commit
    hermetically without prompts or signing. Setting them per-repo cost four
    ``git config`` subprocesses (~6.6ms each) in every fixture instantiation.

    Instead we write one throwaway gitconfig and point ``GIT_CONFIG_GLOBAL`` at
    it for the whole session, so every ``git`` subprocess inherits the settings
    — the fixtures below only ``git init``.  ``GIT_CONFIG_SYSTEM=/dev/null``
    isolates the tests from a machine's ``/etc/gitconfig`` (e.g. a forced
    ``commit.gpgsign=true``).  Session-scoped: fires once per worker process
    under xdist, not once per test.
    """
    cfg = tmp_path_factory.mktemp("gitcfg") / "gitconfig"
    cfg.write_text(
        "[user]\n"
        "\temail = test@example.com\n"
        "\tname = Test User\n"
        "[commit]\n"
        "\tgpgsign = false\n"
        "[core]\n"
        "\thooksPath = /dev/null\n",
        encoding="utf-8",
    )
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("GIT_CONFIG_GLOBAL", str(cfg))
        mp.setenv("GIT_CONFIG_SYSTEM", "/dev/null")
        yield


@pytest.fixture
def project(tmp_path, monkeypatch):
    """Create a throwaway planctl project and chdir to it.

    Sets CLAUDE_CODE_SESSION_ID so any mutating verb's session-id resolution
    finds a non-None value (planctl mutating verbs fail closed when the env
    is unset — there is no fallback).

    fn-587 task .3: ``scaffold`` (used by many tests via ``seed_epic``) now
    runs the shared integrity check at mint time, which asserts the resolved
    ``primary_repo`` / ``touched_repos`` / per-task ``target_repo`` paths
    point at real ``.git/``-bearing directories.  We ``git init`` the project
    root so the integrity check passes — production-mode planctl projects
    always live inside a git repo, so this fixture matches the deployed
    invariant.  Committer identity, ``commit.gpgsign=false``, and
    ``core.hooksPath=/dev/null`` ride the session-scoped ``GIT_CONFIG_GLOBAL``
    set by :func:`_git_global_config`, so commits stay hermetic without a
    per-repo config subprocess here.
    """
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-session-fixture")
    monkeypatch.chdir(tmp_path)
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    runner = CliRunner()
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output
    return tmp_path


@pytest.fixture
def planctl_git_repo(tmp_path, monkeypatch):
    """A tmp_path with git init + planctl init, configured for commit tests.

    Committer identity, commit.gpgsign=false, and core.hooksPath=/dev/null ride
    the session-scoped ``GIT_CONFIG_GLOBAL`` set by :func:`_git_global_config`,
    so commits succeed without prompts or signing overhead and without a
    per-repo config subprocess here.

    CLAUDE_CODE_SESSION_ID is set to a fixed test value so build_planctl_commit()
    can resolve the session id without depending on any sidecar database.

    Scope: function — each test gets a fresh repo.
    """
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-session-fixture")
    monkeypatch.chdir(tmp_path)

    # Initialise git repo
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)

    # Create an initial commit so HEAD exists
    readme = tmp_path / "README.md"
    readme.write_text("# Test repo\n")
    subprocess.run(
        ["git", "add", "README.md"], cwd=tmp_path, check=True, capture_output=True
    )
    subprocess.run(
        ["git", "commit", "-m", "chore: initial commit"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
    )

    # Initialise planctl project. `init` self-commits its bootstrap files
    # inline (a `chore(planctl): init <name>` commit), so the repo baseline is
    # clean once the verb returns — no manual stage+commit needed here.
    runner = CliRunner()
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output

    return tmp_path


@pytest.fixture
def multi_repo_project(tmp_path, monkeypatch):
    """Two git-initialised tmp dirs for multi-repo tests.

    Returns (primary_path, touched_path) — both are bare git repos with no
    planctl project; callers run ``planctl init`` themselves if needed.

    Committer identity, commit.gpgsign=false, and core.hooksPath=/dev/null ride
    the session-scoped ``GIT_CONFIG_GLOBAL`` set by :func:`_git_global_config`,
    so the per-repo config subprocesses are gone from this loop.

    CLAUDE_CODE_SESSION_ID is pre-set so any mutating verb's session-id resolution
    short-circuits cleanly.
    """
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-session-fixture")

    primary = tmp_path / "primary"
    touched = tmp_path / "touched"
    primary.mkdir()
    touched.mkdir()

    for repo_dir in (primary, touched):
        subprocess.run(["git", "init"], cwd=repo_dir, check=True, capture_output=True)
        readme = repo_dir / "README.md"
        readme.write_text("# Test repo\n")
        subprocess.run(
            ["git", "add", "README.md"], cwd=repo_dir, check=True, capture_output=True
        )
        subprocess.run(
            ["git", "commit", "-m", "chore: initial commit"],
            cwd=repo_dir,
            check=True,
            capture_output=True,
        )

    return primary, touched


class _CliResult:
    """``subprocess.CompletedProcess``-compatible shim for in-process CliRunner.

    Exposes ``returncode`` / ``stdout`` / ``stderr`` so call sites that were
    written against ``subprocess.run(["planctl", ...])`` keep their assertions
    unchanged after switching to :func:`run_cli`.
    """

    def __init__(self, returncode: int, stdout: str, stderr: str) -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def run_cli(
    args,
    *,
    cwd=None,
    env: dict | None = None,
    input_text: str | None = None,
) -> _CliResult:
    """Invoke the planctl CLI in-process, mimicking
    ``subprocess.run(["planctl", *args], cwd=cwd, env=env)``.

    Replaces a real ``planctl`` subprocess — which boots a fresh Python
    interpreter (~0.3s) — by driving ``cli.main(..., standalone_mode=False)``,
    the exact entry the console script (``planctl._util.run_cli``) uses. That
    faithfully reproduces the shell contract a ``CliRunner`` invocation does
    not: a command callback's int return value becomes the exit code (e.g.
    ``validate`` returning 1), and stdout/stderr are captured separately so
    callers asserting on stderr (``WARN:`` lines) keep working.
    """
    import contextlib
    import io
    import sys

    import click

    out, err = io.StringIO(), io.StringIO()
    saved_env: dict[str, str | None] = {}
    if env:
        for key, val in env.items():
            saved_env[key] = os.environ.get(key)
            os.environ[key] = val
    saved_stdin = sys.stdin
    try:
        cd = contextlib.chdir(cwd) if cwd is not None else contextlib.nullcontext()
        with cd, contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            if input_text is not None:
                sys.stdin = io.StringIO(input_text)
            try:
                rv = cli.main(list(args), standalone_mode=False)
                rc = rv if isinstance(rv, int) else 0
            except SystemExit as exc:
                rc = exc.code if isinstance(exc.code, int) else 0
            except click.ClickException as exc:
                exc.show()
                rc = exc.exit_code
    finally:
        sys.stdin = saved_stdin
        for key, val in saved_env.items():
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val
    return _CliResult(rc, out.getvalue(), err.getvalue())


def _first_json_payload(output: str) -> dict:
    """Return the first stdout line that parses as a JSON object.

    `CliRunner` mixes stderr into `output`, so an incidental stderr warning
    can land ahead of the envelope. Scan for the first JSON-parseable line
    and skip the trailing `{"planctl_invocation": ...}` decorator line.
    """
    for line in output.strip().splitlines():
        line = line.strip()
        if not line.startswith("{") or line.startswith('{"planctl_invocation"'):
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    raise AssertionError(f"no JSON payload in CLI output:\n{output}")


def _task_spec(marker: str = "seed") -> str:
    """A minimal four-section task spec carrying a marker in its Description.

    Used by the scaffold-based seed helpers below — `task create` was removed
    in fn-565, so tests mint epics + tasks transactionally via `scaffold`.
    """
    return (
        f"## Description\n{marker}\n\n## Acceptance\n- [ ] x\n\n"
        "## Done summary\n\n## Evidence\n"
    )


def _scaffold_plan_yaml(
    *,
    title: str,
    n_tasks: int,
    branch: str | None = None,
    task_deps: dict[int, list[int]] | None = None,
) -> str:
    """Build a scaffold `--file` YAML for an epic + N tasks.

    `task_deps` maps a 1-based task ordinal to a list of 1-based ordinals it
    depends on (scaffold's native dep encoding). Each task's Description carries
    a `seed-<i>` marker so per-task specs stay distinguishable.
    """
    task_deps = task_deps or {}
    blocks: list[str] = []
    for i in range(1, n_tasks + 1):
        spec_lines = "\n".join(
            "      " + ln for ln in _task_spec(f"seed-{i}").splitlines()
        )
        deps = task_deps.get(i)
        dep_line = f"    deps: {deps}\n" if deps else ""
        # fn-594: tier is required on every task entry in scaffold YAML.
        # Tests don't exercise per-tier routing, so a deliberate "medium"
        # default suffices.
        blocks.append(
            f"  - title: Task {i}\n{dep_line}    tier: medium\n"
            f"    spec: |\n{spec_lines}"
        )
    branch_line = f"  branch: {branch}\n" if branch else ""
    return (
        f"epic:\n  title: {title}\n{branch_line}"
        "  spec: |\n    ## Overview\n    seed overview\n"
        "tasks:\n" + "\n".join(blocks) + "\n"
    )


def seed_epic(
    project_path,
    *,
    title: str = "Seed epic",
    n_tasks: int = 1,
    branch: str | None = None,
    task_deps: dict[int, list[int]] | None = None,
    env: dict | None = None,
) -> tuple[str, list[str]]:
    """Scaffold an epic + N tasks via the CLI, returning ``(epic_id, task_ids)``.

    The single transactional `scaffold` call replaces the per-verb
    `epic create` -> `task create` -> `set-deps` fixture loop the removed
    incremental verbs used to drive (fn-565). ``task_ids`` are the ordered
    ``<epic_id>.M`` ids scaffold allocated.
    """
    yaml = _scaffold_plan_yaml(
        title=title, n_tasks=n_tasks, branch=branch, task_deps=task_deps
    )
    plan_path = project_path / "_seed_plan.yaml"
    plan_path.write_text(yaml, encoding="utf-8")
    runner = CliRunner()
    full_env = {**os.environ, **env} if env else None
    result = runner.invoke(cli, ["scaffold", "--file", str(plan_path)], env=full_env)
    assert result.exit_code == 0, result.output
    payload = _first_json_payload(result.output)
    return payload["epic_id"], payload["task_ids"]


def add_task(
    project_path,
    epic_id: str,
    *,
    title: str = "Added task",
    deps: list[str] | None = None,
    env: dict | None = None,
) -> str:
    """Add one task to an existing epic via `refine-apply`, returning its id.

    fn-565: the incremental `task create` verb is gone — `refine-apply`'s
    `add_tasks:` is the surface for growing an existing epic in tests.
    """
    spec_lines = "\n".join("      " + ln for ln in _task_spec("added").splitlines())
    deps_line = f"    deps: {deps}\n" if deps else ""
    # fn-594: tier is required on every add_tasks entry in refine-apply YAML.
    delta = (
        f"add_tasks:\n  - title: {title}\n{deps_line}"
        f"    tier: medium\n    spec: |\n{spec_lines}\n"
    )
    delta_path = project_path / "_seed_delta.yaml"
    delta_path.write_text(delta, encoding="utf-8")
    runner = CliRunner()
    full_env = {**os.environ, **env} if env else None
    result = runner.invoke(
        cli, ["refine-apply", epic_id, "--file", str(delta_path)], env=full_env
    )
    assert result.exit_code == 0, result.output
    payload = _first_json_payload(result.output)
    return payload["added_task_ids"][0]


def parse_cli_output(output: str) -> dict:
    """Parse the primary JSON payload from planctl CLI output.

    The click invocation-tracking decorator appends a trailing
    ``{"planctl_invocation": ...}`` NDJSON line after the primary payload for
    read-only verbs.  Strip it before JSON-parsing so multi-line pretty JSON
    parses cleanly regardless of whether the decorator fired.

    For mutating verbs (which emit compact single-line NDJSON), the decorator
    does NOT fire (sentinel prevents double-emit), so this function also works
    unchanged for those — the single compact line parses fine after stripping
    any trailing invocation line.

    `CliRunner` mixes stderr into ``output``; an incidental stderr warning
    can land ahead of the JSON envelope. Drop any leading lines that don't
    begin a JSON object before joining, so the multi-line pretty-JSON
    payload still parses cleanly.
    """
    import json

    lines = output.strip().splitlines()
    primary_lines = [
        ln for ln in lines if not ln.strip().startswith('{"planctl_invocation"')
    ]
    while primary_lines and not primary_lines[0].lstrip().startswith("{"):
        primary_lines.pop(0)
    return json.loads("\n".join(primary_lines))


def _git_log_count(repo: Path) -> int:
    """Return number of commits in the repo."""
    result = subprocess.run(
        ["git", "rev-list", "--count", "HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return int(result.stdout.strip())


def _git_head_sha(repo: Path) -> str:
    """Return current HEAD short sha."""
    result = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _git_head_message(repo: Path) -> str:
    """Return HEAD commit message."""
    result = subprocess.run(
        ["git", "log", "-1", "--format=%B"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _git_files_in_head(repo: Path) -> list[str]:
    """Return list of files changed in HEAD commit."""
    result = subprocess.run(
        ["git", "diff-tree", "--no-commit-id", "-r", "--name-only", "HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return [f.strip() for f in result.stdout.strip().splitlines() if f.strip()]


# ---------------------------------------------------------------------------
# fn-587 task .1: salvaged from the (now-deleted) tests/test_commit_plan.py.
# Down-stream tests in test_commit.py + the migrated auto-commit tests use
# these via the conftest import path.  Names kept verbatim from the original
# call sites so the salvage was a literal rename, not a behavioural rewrite.
# ---------------------------------------------------------------------------


def _git_head_files(repo: Path) -> list[str]:
    """Return list of repo-relative paths changed in the HEAD commit.

    Alias of :func:`_git_files_in_head` preserved under the legacy
    ``_git_head_files`` name used by ``test_commit.py``.
    """
    return _git_files_in_head(repo)


def _git_commit_count(repo: Path) -> int:
    """Return the total number of commits in *repo*'s current branch.

    Alias of :func:`_git_log_count` preserved under the legacy
    ``_git_commit_count`` name used by ``test_commit.py``.
    """
    return _git_log_count(repo)
