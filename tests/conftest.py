"""Shared pytest fixtures for planctl tests.

Beyond the git-backed ``scaffold`` seeds (``seed_epic`` / ``add_task``), this
module ships ``seed_state`` — a git-free, CLI-free builder that writes a full
``.planctl/`` tree through the same ``normalize_epic`` / ``normalize_task`` +
``atomic_write_json`` seams the read path runs, so a seeded tree carries zero
schema drift. Two fixtures support it: ``isolated_roots`` stubs project
discovery to ``[]`` so re-stamping verbs skip the real ``~/code`` scan, and
``fixed_clock`` pins the clock via ``PLANCTL_NOW`` for deterministic timestamp
assertions in both engines.

Fast gate (default ``uv run pytest tests/``)
--------------------------------------------
A set of autouse fixtures closes every subprocess seam on the unmarked fast
path so the default suite spawns near-zero subprocesses, each opt-out-able via a
marker (the ``_mock_autocommit`` template — autouse + early-return on a marker):

* ``_planctl_actor`` — session-autouse ``PLANCTL_ACTOR`` env, killing the
  ``git config user.email`` spawn in ``get_actor``.
* ``_mock_dirty_probe`` — replaces the ``git status`` dirty-probe in
  ``build_planctl_invocation`` with a ``.planctl/`` disk walk (opt out:
  ``real_git``).
* ``_isolated_roots_default`` — forces empty discovery so no test scans the
  real ``~/code`` (opt out: ``real_roots``, against a controlled tmp root).
* ``project`` / ``multi_repo_project`` write a bare ``.git/`` skeleton instead
  of spawning ``git init`` (opt out: ``real_git``). ``planctl_git_repo`` keeps
  real git.

The slow bucket (markers ``real_git`` / ``integration`` / ``wire``) is
skip-by-default and re-enabled with
``--run-slow`` via the ``pytest_collection_modifyitems`` hook (skip, never
deselect). The stubs' fidelity against the real binaries is pinned by
``wire``-marked contract tests in ``tests/test_stub_contracts.py``.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest
from planctl.cli import cli


def _planctl_bin() -> str | None:
    """The conformance-engine binary, or ``None`` for the in-process engine.

    Conformance mode is active exactly when ``PLANCTL_BIN`` is set: the invoker
    then runs every CLI call as a real ``subprocess.run([PLANCTL_BIN, ...])``
    against an arbitrary planctl binary (the installed Python one in this epic,
    a Bun binary in later program epics). Unset -> the default in-process
    engine, zero behavior change.
    """
    return os.environ.get("PLANCTL_BIN") or None


def _conformance() -> bool:
    """Whether the subprocess (conformance) engine is active this session."""
    return _planctl_bin() is not None


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "real_git: exercise the real .planctl/ auto-commit (status+add+commit+"
        "rev-parse) and real git fixtures. Default tests no-op it and run "
        "against a bare .git/ skeleton. Slow bucket: skipped unless --run-slow.",
    )
    config.addinivalue_line(
        "markers",
        "integration: heavy end-to-end test (git init + CliRunner scaffold + "
        "subprocesses). Slow bucket: skipped unless --run-slow.",
    )
    config.addinivalue_line(
        "markers",
        "wire: pins a stub's fake output against the real binary (the live "
        "git wire). Slow bucket: skipped unless --run-slow.",
    )
    config.addinivalue_line(
        "markers",
        "real_roots: opt out of the autouse empty-discovery isolation and "
        "drive real multi-project roots resolution (against a controlled tmp "
        "root, never the real ~/code). Fast-path marker — NOT slow-bucket.",
    )
    config.addinivalue_line(
        "markers",
        "python_only: the Python implementation's internals ARE the subject "
        "(direct calls into planctl.* functions, asserts on in-process stub "
        "state). Cannot cross the subprocess boundary, so skipped-VISIBLE under "
        "conformance (PLANCTL_BIN set) — never silently deselected. The "
        "documented python-only residue the Bun port re-expresses later.",
    )

    binary = _planctl_bin()
    if binary is not None:
        resolved = shutil.which(binary) or binary
        if not Path(resolved).is_file() or not os.access(resolved, os.X_OK):
            raise pytest.UsageError(
                f"PLANCTL_BIN={binary!r} is set but is not an executable file "
                f"(resolved to {resolved!r}). Point it at a real planctl binary "
                f"or unset it to run the in-process engine."
            )


#: Markers that put a test in the skip-by-default slow bucket. Any test
#: carrying one of these is skipped unless ``--run-slow`` is passed. They name
#: the spawn-bearing fast-path seams (real git, the live wire)
#: that the fast gate stubs out — so a slow-bucket test is exactly a test that
#: needs a real subprocess the fast suite refuses to spawn.
_SLOW_BUCKET_MARKERS = (
    "real_git",
    "integration",
    "wire",
)


def pytest_addoption(parser):
    """Register ``--run-slow`` — the single gate that re-enables the slow bucket.

    Default ``uv run pytest tests/`` runs the fast bucket only (slow-marked
    tests are *skipped*, visible in the count). ``--run-slow`` runs everything.
    We use a skip-by-default collection hook rather than an ``-m`` expression in
    addopts: ``-m`` *deselects* (silently drops from the count and cannot be
    cleanly undone from the command line), whereas a ``pytest.mark.skip`` stays
    visible as a skip [pytest issue #11738].
    """
    parser.addoption(
        "--run-slow",
        action="store_true",
        default=False,
        help="Run the slow bucket too (real git / wire-marked tests). "
        "Default runs only the near-subprocess-free fast gate.",
    )


def pytest_collection_modifyitems(config, items):
    """Two orthogonal skip-visible gates: the slow bucket and ``python_only``.

    Both add a ``pytest.mark.skip`` (never deselect via ``-m``) so the skipped
    tests stay in the collected count as visible skips — the run loudly reports
    what it is *not* running rather than silently dropping it.

    * The slow bucket (``real_git`` / ``integration`` / ``wire``) is skipped
      unless ``--run-slow``.
    * ``python_only`` is skipped under conformance (``PLANCTL_BIN`` set): those
      tests reach into Python internals that the subprocess engine cannot
      observe, so they are skip-visible exactly when the slow bucket is *not* —
      the inverse trigger. They run normally on the in-process default engine.

    The two gates are independent: ``--run-slow`` re-enables the slow bucket but
    never un-skips ``python_only`` under conformance, and vice versa.
    """
    if not config.getoption("--run-slow"):
        skip_slow = pytest.mark.skip(reason="slow bucket — pass --run-slow to run")
        for item in items:
            if any(item.get_closest_marker(m) for m in _SLOW_BUCKET_MARKERS):
                item.add_marker(skip_slow)

    if _conformance():
        skip_py = pytest.mark.skip(
            reason="python_only — Python internals are the subject, "
            "cannot cross the conformance subprocess boundary"
        )
        for item in items:
            if item.get_closest_marker("python_only"):
                item.add_marker(skip_py)


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

    Under conformance the CLI runs in its own subprocess, so this in-process
    patch could never reach it; the stub early-returns so the parent stays
    unpatched and the binary commits for real against the per-worker tmp HOME.
    """
    if _conformance() or request.node.get_closest_marker("real_git"):
        return

    import planctl.commit as _commit

    def _noop(payload: dict) -> str | None:
        return None if not payload.get("files") else "0" * 40

    monkeypatch.setattr(_commit, "auto_commit_from_invocation", _noop)


@pytest.fixture(scope="session", autouse=True)
def _planctl_actor(monkeypatch_session):
    """Pin ``PLANCTL_ACTOR`` so ``get_actor`` skips its ``git config`` spawn.

    ``planctl.store.get_actor`` short-circuits on ``PLANCTL_ACTOR`` (store.py)
    before any ``git config user.email`` / ``user.name`` subprocess. Setting it
    once per session (setenv only — no subprocess, no file churn) kills that
    spawn on the fast path with zero patching. Session-scoped, so it fires once
    per xdist worker, not once per test [xdist #271].
    """
    monkeypatch_session.setenv("PLANCTL_ACTOR", "test@example.com")


@pytest.fixture(scope="session")
def monkeypatch_session():
    """A session-scoped MonkeyPatch — the function-scoped ``monkeypatch`` cannot
    be requested by a session fixture. Undone at session teardown."""
    with pytest.MonkeyPatch.context() as mp:
        yield mp


def _disk_walk_planctl_paths(repo_root) -> set[str]:
    """Disk-walk ``.planctl/`` → repo-relative ``.planctl/...`` path set.

    Stand-in for ``git status --porcelain --untracked-files=all -- .planctl/``:
    on a fresh repo (nothing committed) every on-disk ``.planctl/`` file is
    "untracked", so a plain walk reproduces the probe's output. The wire
    contract test pins this against the real ``git status`` for the touched
    files. Module-level (not a fixture closure) so the contract test can call
    it directly under ``@real_git`` without the autouse patch.
    """
    from pathlib import Path

    root = Path(repo_root)
    planctl_dir = root / ".planctl"
    if not planctl_dir.is_dir():
        return set()
    paths: set[str] = set()
    for f in planctl_dir.rglob("*"):
        if f.is_file():
            paths.add(f.relative_to(root).as_posix())
    return paths


@pytest.fixture(autouse=True)
def _mock_dirty_probe(request, monkeypatch):
    """Replace the ``git status`` dirty-probe in ``planctl.invocation`` with a
    disk walk of ``.planctl/`` (invocation.py).

    ``build_planctl_invocation`` runs ``git status --porcelain
    --untracked-files=all -- .planctl/`` (invocation.py) to find dirty/untracked
    ``.planctl/`` paths, then intersects them with the session touched-paths log
    to populate the envelope's ``files`` / ``subject``. That spawn fires once
    per mutating verb, upstream of the already-mocked auto-commit.

    The stub walks ``.planctl/`` on disk and returns every file as a
    repo-relative ``.planctl/...`` path — faithful to ``--untracked-files=all``
    for the fresh-repo case every fixture creates (nothing committed yet, so
    every on-disk file is "untracked"). Because ``files`` is the *intersection*
    with the touched-paths log, returning the on-disk superset (including
    gitignored ``state/`` paths the real ``git status`` would omit) is
    behaviour-neutral: only the genuinely-touched paths survive the intersection.

    Opt out with ``@pytest.mark.real_git`` (slow bucket) to spawn real git.
    Under conformance the binary runs the real probe in its own subprocess, so
    this in-process patch is moot — early-return and leave the parent unpatched.
    """
    if _conformance() or request.node.get_closest_marker("real_git"):
        return

    import planctl.invocation as _invocation

    monkeypatch.setattr(_invocation, "_dirty_planctl_paths", _disk_walk_planctl_paths)


@pytest.fixture(autouse=True)
def _isolated_session_markers(tmp_path_factory, monkeypatch):
    """Redirect the session-marker dir to a throwaway tmp dir for every test.

    The success paths of claim / worker resume / done / block / close-preflight
    / close-finalize write or clear a marker at
    ``~/.local/state/planctl/sessions/`` (``session_markers``). Without this
    redirect the suite would pollute the developer's real home. Narrowly stubs
    the dir resolver — never touches ``HOME`` — so no other home-derived path
    moves. Marker-layer tests that need their own dir simply re-monkeypatch it.

    Under conformance the binary resolves the marker dir from ``HOME`` in its own
    subprocess (the per-worker tmp HOME already isolates
    ``~/.local/state/planctl/sessions``), so this in-process patch is moot —
    early-return and leave the parent unpatched.
    """
    if _conformance():
        return

    import planctl.session_markers as _markers

    sessions_dir = tmp_path_factory.mktemp("sessions")
    monkeypatch.setattr(_markers, "_sessions_dir", lambda: sessions_dir)


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


def _write_git_skeleton(repo_dir: Path) -> None:
    """Write a minimal bare ``.git/`` skeleton instead of spawning ``git init``.

    planctl's repo detection requires only that ``<root>/.git`` *exists*
    (integrity.py: ``_validate_repo_path`` checks ``(p / ".git").exists()``,
    ``_check_epic_tree`` the same), and the fast bucket no-ops every real git
    verb (auto-commit, dirty-probe). So a hand-written skeleton — ``HEAD``,
    ``config``, ``refs/heads/`` — is enough to pass path detection with zero
    subprocess. Any test that runs a *real* git verb against this skeleton fails
    hard; those tests carry ``real_git`` and take the real ``git init`` path.
    """
    git_dir = repo_dir / ".git"
    (git_dir / "refs" / "heads").mkdir(parents=True, exist_ok=True)
    (git_dir / "objects").mkdir(parents=True, exist_ok=True)
    (git_dir / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    (git_dir / "config").write_text(
        "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
        encoding="utf-8",
    )


@pytest.fixture
def project(request, tmp_path, monkeypatch):
    """Create a throwaway planctl project and chdir to it.

    Sets CLAUDE_CODE_SESSION_ID so any mutating verb's session-id resolution
    finds a non-None value (planctl mutating verbs fail closed when the env
    is unset — there is no fallback).

    ``scaffold`` (used by many tests via ``seed_epic``) runs the shared
    integrity check at mint time, which asserts the resolved
    ``primary_repo`` / ``touched_repos`` / per-task ``target_repo`` paths point
    at real ``.git/``-bearing directories. Repo detection needs only that
    ``.git/`` *exists*, and the fast bucket no-ops every real git verb, so this
    fixture writes a bare ``.git/`` skeleton instead of spawning ``git init`` —
    zero subprocess. A ``@pytest.mark.real_git`` test (slow bucket) takes the
    real ``git init`` path instead, so commits exercised there see real git.
    Committer identity, ``commit.gpgsign=false``, and ``core.hooksPath=/dev/null``
    ride the session-scoped ``GIT_CONFIG_GLOBAL`` set by
    :func:`_git_global_config`.
    """
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-session-fixture")
    monkeypatch.chdir(tmp_path)
    if _conformance() or request.node.get_closest_marker("real_git"):
        subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    else:
        _write_git_skeleton(tmp_path)
    result = run_cli(["init"], cwd=tmp_path)
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
    result = run_cli(["init"], cwd=tmp_path)
    assert result.exit_code == 0, result.output

    return tmp_path


@pytest.fixture
def multi_repo_project(request, tmp_path, monkeypatch):
    """Two git-bearing tmp dirs for multi-repo tests.

    Returns (primary_path, touched_path) — both carry a ``.git/`` with no
    planctl project; callers run ``planctl init`` themselves if needed.

    Repo detection needs only that ``.git/`` exists and the fast bucket no-ops
    every real git verb, so each dir gets a bare ``.git/`` skeleton instead of
    ``git init`` + an initial commit — zero subprocess. A
    ``@pytest.mark.real_git`` test (slow bucket) takes the real
    ``git init`` + initial-commit path instead. Committer identity,
    commit.gpgsign=false, and core.hooksPath=/dev/null ride the session-scoped
    ``GIT_CONFIG_GLOBAL`` set by :func:`_git_global_config`.

    CLAUDE_CODE_SESSION_ID is pre-set so any mutating verb's session-id resolution
    short-circuits cleanly.
    """
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-session-fixture")

    primary = tmp_path / "primary"
    touched = tmp_path / "touched"
    primary.mkdir()
    touched.mkdir()

    real_git = _conformance() or request.node.get_closest_marker("real_git")
    for repo_dir in (primary, touched):
        if not real_git:
            _write_git_skeleton(repo_dir)
            continue
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
    """``subprocess.CompletedProcess``-compatible result for both engines.

    Both the in-process and the subprocess engine return this. ``returncode`` /
    ``stdout`` / ``stderr`` keep call sites written against
    ``subprocess.run(["planctl", ...])`` working unchanged, and ``exit_code`` /
    ``output`` mirror :class:`click.testing.Result`'s surface so the 124
    ``CliRunner`` call sites can route through this seam in later tasks without
    touching their assertions. ``output`` is ``stdout`` + ``stderr`` merged,
    matching ``CliRunner``'s ``mix_stderr=True`` default; under the subprocess
    engine the two separately-captured streams are concatenated, so a substring
    assert survives but an interleaving-order-sensitive one may not.
    """

    def __init__(self, returncode: int, stdout: str, stderr: str) -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

    @property
    def exit_code(self) -> int:
        return self.returncode

    @property
    def output(self) -> str:
        return self.stdout + self.stderr


class _ConformanceHome:
    """Holds the per-worker tmp HOME + empty global gitconfig for the subprocess
    engine, so the module-level invoker can reach them without a fixture.

    Set once per session by :func:`_conformance_home` (only under conformance);
    every ``run_cli`` subprocess call reads it. Keyed nowhere by hand — xdist
    gives each worker its own ``tmp_path_factory`` basetemp, so a session fixture
    that mints under it is already per-worker, which is what keeps the epic-id
    flock (``~/.local/state/planctl/epic-id.lock``, expanduser-resolved by the
    fresh interpreter under this HOME) from serializing across workers.
    """

    home: Path | None = None
    gitconfig: Path | None = None


@pytest.fixture(scope="session", autouse=True)
def _conformance_home(tmp_path_factory):
    """Mint the per-worker tmp HOME the subprocess engine isolates under.

    No-op on the in-process path (the default fast gate spawns nothing). Under
    conformance it creates one throwaway HOME and one empty global gitconfig per
    worker and stashes them on :class:`_ConformanceHome`. The HOME covers every
    expanduser-resolved surface a fresh planctl interpreter touches —
    ``~/.config/planctl/config.yaml`` (absent -> roots default to ``~/code``,
    which now resolves *under* this empty HOME -> empty discovery, isolated for
    free), ``~/.local/state/planctl/sessions``, and the epic-id flock.
    """
    if not _conformance():
        yield
        return
    base = tmp_path_factory.mktemp("conformance-home")
    home = base / "home"
    home.mkdir()
    gitconfig = base / "gitconfig"
    # An empty file (not /dev/null): git writes the test committer identity into
    # it via the per-repo init, and /dev/null is not writable.
    gitconfig.write_text(
        "[user]\n\temail = test@example.com\n\tname = Test User\n"
        "[commit]\n\tgpgsign = false\n[core]\n\thooksPath = /dev/null\n",
        encoding="utf-8",
    )
    _ConformanceHome.home = home
    _ConformanceHome.gitconfig = gitconfig
    try:
        yield
    finally:
        _ConformanceHome.home = None
        _ConformanceHome.gitconfig = None


def _subprocess_env(env: dict | None) -> dict[str, str]:
    """Build the minimal explicit env for a conformance subprocess call.

    Built from scratch — never ``os.environ.copy()`` — so no XDG path or
    credential from the developer's shell leaks into the isolated planctl
    process. Carries only HOME + XDG_* (under the per-worker tmp HOME),
    GIT_CONFIG_GLOBAL -> the empty temp gitconfig, GIT_CONFIG_SYSTEM=/dev/null,
    PATH, PLANCTL_ACTOR, the harness-intrinsic ``CLAUDE_CODE_SESSION_ID`` (which
    the fixtures pre-set and every mutating verb requires to build its commit
    envelope), and any ``PLANCTL_NOW`` clock override, then layers the per-call
    test-supplied ``env`` last so a test can still override anything.
    """
    home = _ConformanceHome.home
    gitconfig = _ConformanceHome.gitconfig
    assert home is not None and gitconfig is not None, (
        "conformance subprocess called before _conformance_home session fixture ran"
    )
    base: dict[str, str] = {
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_STATE_HOME": str(home / ".local" / "state"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "GIT_CONFIG_GLOBAL": str(gitconfig),
        "GIT_CONFIG_SYSTEM": "/dev/null",
        "PATH": os.environ.get("PATH", ""),
        "PLANCTL_ACTOR": os.environ.get("PLANCTL_ACTOR", "test@example.com"),
    }
    for forwarded in ("CLAUDE_CODE_SESSION_ID", "PLANCTL_NOW"):
        if (val := os.environ.get(forwarded)) is not None:
            base[forwarded] = val
    if env:
        base.update({k: str(v) for k, v in env.items()})
    return base


def _run_subprocess_engine(args, cwd, env, input_text) -> _CliResult:
    """Conformance engine: run the CLI as a real ``PLANCTL_BIN`` subprocess."""
    binary = _planctl_bin()
    assert binary is not None, "subprocess engine requires PLANCTL_BIN"
    proc = subprocess.run(
        [binary, *args],
        cwd=cwd,
        env=_subprocess_env(env),
        input=input_text,
        capture_output=True,
        text=True,
    )
    return _CliResult(proc.returncode, proc.stdout, proc.stderr)


def _run_in_process_engine(args, cwd, env, input_text) -> _CliResult:
    """Default engine: drive ``cli.main(..., standalone_mode=False)`` in-process.

    Boots no fresh interpreter — replaces a real ``planctl`` subprocess (~0.3s)
    by driving the exact entry the console script uses. Faithfully reproduces
    the shell contract ``CliRunner`` does not: a command callback's int return
    value becomes the exit code (e.g. ``validate`` returning 1), and
    stdout/stderr are captured separately so callers asserting on stderr
    (``WARN:`` lines) keep working.
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
                # Present a stdin that supports BOTH text ``.read()`` and binary
                # ``.buffer.read()`` (scaffold / refine-apply / the submit verbs
                # read stdin as bytes) plus ``.isatty()`` — a bare StringIO has no
                # ``.buffer``. A TextIOWrapper over a BytesIO covers all three,
                # matching what a real piped stdin (and CliRunner) provides.
                sys.stdin = io.TextIOWrapper(
                    io.BytesIO(input_text.encode("utf-8")), encoding="utf-8"
                )
            try:
                rv = cli.main(list(args), standalone_mode=False)
                rc = rv if isinstance(rv, int) else 0
            except SystemExit as exc:
                rc = exc.code if isinstance(exc.code, int) else 0
            except click.ClickException as exc:
                exc.show()
                rc = exc.exit_code
            except Exception:
                # Mirror the real ``planctl`` subprocess: an uncaught exception
                # prints a traceback to stderr and exits 1 (Python's default).
                # ``CliRunner(catch_exceptions=True)`` reports the same exit
                # code, so swallowing-to-1 here keeps both engines' results
                # identical for the verbs that fail by raising (e.g. the
                # missing-session-id seam).
                import traceback

                traceback.print_exc()
                rc = 1
    finally:
        sys.stdin = saved_stdin
        for key, val in saved_env.items():
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val
    return _CliResult(rc, out.getvalue(), err.getvalue())


def run_cli(
    args,
    *,
    cwd=None,
    env: dict | None = None,
    input_text: str | None = None,
) -> _CliResult:
    """The single invoker every test routes through, mimicking
    ``subprocess.run(["planctl", *args], cwd=cwd, env=env)``.

    Dispatches on the active engine: unset ``PLANCTL_BIN`` -> the in-process
    engine (zero behavior change, no subprocess on the fast path); set ->
    the subprocess engine against the real ``PLANCTL_BIN`` with a minimal
    explicit env dict and the per-worker tmp HOME. Both return the same
    :class:`_CliResult`.
    """
    cwd = str(cwd) if cwd is not None else None
    if _conformance():
        return _run_subprocess_engine(args, cwd, env, input_text)
    return _run_in_process_engine(args, cwd, env, input_text)


def set_roots(request, monkeypatch, roots) -> None:
    """Point planctl roots discovery at *roots* in an engine-agnostic way.

    The roots config lives at ``~/.config/planctl/config.yaml`` (config.py),
    a path ``planctl.config.CONFIG_PATH`` resolves once at import against
    ``$HOME``. The two engines reach it differently:

    * In-process (default): ``CONFIG_PATH`` is already expanded, so a later
      ``$HOME`` change can't move it — patch the module attribute onto a tmp
      config file directly.
    * Conformance: the binary runs in its own subprocess under the per-worker
      tmp HOME, so it reads ``<that HOME>/.config/planctl/config.yaml``. Write
      the real file there and restore it on teardown (the conformance HOME is
      session-shared across the worker's tests); the in-process ``CONFIG_PATH``
      patch is moot for the subprocess, so skip it.

    *roots* is a list of directories. Replaces the autouse empty-discovery
    isolation, so callers carry ``@pytest.mark.real_roots`` (a fast-path
    marker, not slow bucket). Takes ``request`` for the conformance teardown.
    """
    body = "roots:\n" + "".join(f"  - {Path(r)}\n" for r in roots)
    if _conformance():
        home = _ConformanceHome.home
        assert home is not None, (
            "set_roots called under conformance before _conformance_home ran"
        )
        cfg = home / ".config" / "planctl" / "config.yaml"
        cfg.parent.mkdir(parents=True, exist_ok=True)
        prior = cfg.read_text(encoding="utf-8") if cfg.is_file() else None
        cfg.write_text(body, encoding="utf-8")

        def _restore() -> None:
            if prior is None:
                cfg.unlink(missing_ok=True)
            else:
                cfg.write_text(prior, encoding="utf-8")

        request.addfinalizer(_restore)
        return

    cfg = Path(tempfile.mkdtemp()) / "config.yaml"
    cfg.write_text(body, encoding="utf-8")
    monkeypatch.setattr("planctl.config.CONFIG_PATH", cfg)


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

    Used by the scaffold-based seed helpers below — there is no incremental
    `task create` verb, so tests mint epics + tasks transactionally via `scaffold`.
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
        # tier is required on every task entry in scaffold YAML.
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

    A single transactional `scaffold` call mints the whole epic + task tree
    (there are no incremental `epic create` / `task create` / `set-deps`
    verbs). ``task_ids`` are the ordered ``<epic_id>.M`` ids scaffold allocated.
    """
    yaml = _scaffold_plan_yaml(
        title=title, n_tasks=n_tasks, branch=branch, task_deps=task_deps
    )
    plan_path = project_path / "_seed_plan.yaml"
    plan_path.write_text(yaml, encoding="utf-8")
    result = run_cli(["scaffold", "--file", str(plan_path)], cwd=project_path, env=env)
    assert result.exit_code == 0, result.output
    payload = _first_json_payload(result.output)
    return payload["epic_id"], payload["task_ids"]


def seed_state(
    tmp_path,
    *,
    epic_id: str,
    title: str = "Seed epic",
    epic_spec: str = "## Overview\nseed overview\n",
    n_tasks: int = 1,
    epic_snippets: list[str] | None = None,
    epic_bundles: list[str] | None = None,
    task_snippets: dict[int, list[str]] | None = None,
    task_bundles: dict[int, list[str]] | None = None,
    task_deps: dict[int, list[int]] | None = None,
    primary_repo: str | None = None,
) -> tuple[str, list[str]]:
    """Build a full ``.planctl/`` tree on disk without git, CLI, or flock.

    Mirrors ``planctl init`` for the skeleton + ``meta.json`` and
    ``planctl scaffold`` for the epic/task on-disk key set, but routes every
    record through :func:`planctl.models.normalize_epic` /
    :func:`planctl.models.normalize_task` before persisting via
    :func:`planctl.store.atomic_write_json` — the SAME normalization the read
    path runs, so a seeded tree carries no schema drift (the round-trip
    self-test below is the standing proof).

    The caller supplies the ``fn-N`` ``epic_id`` directly: there is no
    ``scan_epic_ids_global``, no flock, no ``git init``, and no ``CliRunner``.
    Returns ``(epic_id, task_ids)`` where ``task_ids`` are the ordered
    ``<epic_id>.<M>`` ids.
    """
    from planctl.models import SCHEMA_VERSION, normalize_epic, normalize_task
    from planctl.store import atomic_write, atomic_write_json, now_iso

    epic_snippets = epic_snippets or []
    epic_bundles = epic_bundles or []
    task_snippets = task_snippets or {}
    task_bundles = task_bundles or {}
    task_deps = task_deps or {}

    planctl_dir = tmp_path / ".planctl"
    for subdir in ("epics", "specs", "tasks", "state"):
        (planctl_dir / subdir).mkdir(parents=True, exist_ok=True)
    atomic_write_json(planctl_dir / "meta.json", {"schema_version": SCHEMA_VERSION})
    (planctl_dir / ".gitignore").write_text("state/\n", encoding="utf-8")

    now = now_iso()

    epic_def = normalize_epic(
        {
            "id": epic_id,
            "title": title,
            "status": "open",
            "primary_repo": primary_repo,
            "snippets": list(epic_snippets),
            "bundles": list(epic_bundles),
            "created_at": now,
            "updated_at": now,
        }
    )
    atomic_write_json(planctl_dir / "epics" / f"{epic_id}.json", epic_def)
    atomic_write(planctl_dir / "specs" / f"{epic_id}.md", epic_spec)

    task_ids: list[str] = []
    for i in range(1, n_tasks + 1):
        task_id = f"{epic_id}.{i}"
        task_ids.append(task_id)
        depends_on = [f"{epic_id}.{d}" for d in task_deps.get(i, [])]
        task_def = normalize_task(
            {
                "id": task_id,
                "epic": epic_id,
                "title": f"Task {i}",
                "depends_on": depends_on,
                "tier": "medium",
                "target_repo": primary_repo,
                "snippets": list(task_snippets.get(i, [])),
                "bundles": list(task_bundles.get(i, [])),
                "created_at": now,
                "updated_at": now,
            }
        )
        atomic_write_json(planctl_dir / "tasks" / f"{task_id}.json", task_def)
        atomic_write(planctl_dir / "specs" / f"{task_id}.md", _task_spec(f"seed-{i}"))

    return epic_id, task_ids


def _patch_isolated_roots(monkeypatch):
    """Stub project discovery + roots loading to ``[]`` (the shared seam patch).

    Patches BOTH seams the discovery path resolves through:
    ``planctl.discovery.discover_projects`` (the scanner) AND
    ``planctl.config.load_roots`` (its roots source). Both are kept because
    different call sites bind different ones. Empty discovery is behaviour-
    neutral at all five production ``discover_projects`` call sites
    (``integrity``, ``run_epic_add_deps``, ``run_scaffold``, ``run_epic_create``,
    ``validation_restamp``): each treats "no other projects" as the single-repo
    case, which is exactly what a hermetic test wants — and the four tests that
    already opt into ``isolated_roots`` (incl. scaffold-heavy ones) are the
    standing evidence.
    """
    monkeypatch.setattr("planctl.discovery.discover_projects", lambda: [])
    monkeypatch.setattr("planctl.config.load_roots", lambda: [])


@pytest.fixture
def isolated_roots(monkeypatch):
    """Stub project discovery to ``[]`` so re-stamping verbs skip the real scan.

    ``restamp_epic_or_fail`` calls ``discover_projects()`` -> ``load_roots()``,
    which scans the machine's configured ``~/code`` tree. Forcing an empty
    discovery keeps ``seed_state`` tests hermetic and fast (single-project
    semantics, no cross-machine leakage).

    Importable opt-in name kept for existing call sites; the autouse
    ``_isolated_roots_default`` applies the same patch by default.
    """
    _patch_isolated_roots(monkeypatch)


@pytest.fixture(autouse=True)
def _isolated_roots_default(request, monkeypatch):
    """Isolate discovery to ``[]`` by default so no test scans the real ``~/code``.

    The fast bucket must never read the machine's configured roots: a real scan
    is both slow (filesystem walk of ``~/code``) and non-hermetic (leaks the
    developer's other projects into discovery). This autouse fixture forces
    empty discovery for every test.

    Opt out with ``@pytest.mark.real_roots`` (fast-path marker) when a test drives
    real multi-project resolution — those tests must point discovery at a
    *controlled tmp root* (their own ``CONFIG_PATH`` / ``roots`` fixture), never
    the real ``~/code`` default.

    Under conformance discovery is isolated for free: the per-worker tmp HOME has
    no ``config.yaml``, so roots default to ``~/code`` which resolves under that
    empty HOME -> empty scan. The in-process patch can't reach the subprocess
    anyway, so early-return and leave the parent unpatched.
    """
    if _conformance() or request.node.get_closest_marker("real_roots"):
        return
    _patch_isolated_roots(monkeypatch)


@pytest.fixture
def fixed_clock(monkeypatch):
    """Pin the clock to a fixed microsecond-precision UTC timestamp via env.

    Sets ``PLANCTL_NOW`` — the pinned cross-implementation clock contract
    ``now_iso()`` already honors (store.py) — rather than monkeypatching the
    function. The env override is engine-agnostic: it drives the in-process
    ``now_iso()`` (which reads ``os.environ``) for both ``seed_state`` and the
    default-engine CLI, and the conformance subprocess engine forwards
    ``PLANCTL_NOW`` into the binary's env (see ``_subprocess_env``), so a
    ``fixed_clock`` test pins identical stamps in both engines. The frozen value
    matches ``now_iso()``'s exact ``%Y-%m-%dT%H:%M:%S.%fZ`` format. Returns it.
    """
    frozen = "2026-06-06T00:00:00.000000Z"
    monkeypatch.setenv("PLANCTL_NOW", frozen)
    return frozen


def add_task(
    project_path,
    epic_id: str,
    *,
    title: str = "Added task",
    deps: list[str] | None = None,
    env: dict | None = None,
) -> str:
    """Add one task to an existing epic via `refine-apply`, returning its id.

    There is no incremental `task create` verb — `refine-apply`'s
    `add_tasks:` is the surface for growing an existing epic in tests.
    """
    spec_lines = "\n".join("      " + ln for ln in _task_spec("added").splitlines())
    deps_line = f"    deps: {deps}\n" if deps else ""
    # tier is required on every add_tasks entry in refine-apply YAML.
    delta = (
        f"add_tasks:\n  - title: {title}\n{deps_line}"
        f"    tier: medium\n    spec: |\n{spec_lines}\n"
    )
    delta_path = project_path / "_seed_delta.yaml"
    delta_path.write_text(delta, encoding="utf-8")
    result = run_cli(
        ["refine-apply", epic_id, "--file", str(delta_path)],
        cwd=project_path,
        env=env,
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
# Shared commit-helper fixtures. test_commit.py + the auto-commit tests use
# these via the conftest import path.
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
