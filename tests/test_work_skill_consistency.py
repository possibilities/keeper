"""Consistency checks between `work.md.tmpl` and the `planctl` CLI surface.

This module guards the `/plan:work` skill template against two regressions
that bit fn-339 and prompted the fn-341 followup:

1. **Verb existence** — every `planctl <verb>` invocation referenced inside a
   fenced bash block of `work.md.tmpl` must resolve to a real CLI command.
   The fn-339 close had to repair a `planctl task block --category` call
   inline; a parametrized `--help` smoke test would have caught it the moment
   the template was authored.

2. **agentId regex** — Phase 3c of `work.md.tmpl` extracts the worker's
   `agentId:` from the Task tool result string with
   ``re.search(r"agentId:\\s*([a-f0-9]{10,})", ...)``. The result string has
   content before `agentId`, so `re.match` (with its implicit `^`) silently
   returns `None`; this test pins the contract so any drift is loud.

All CLI invocations use ``CliRunner`` (in-process) — no subprocess.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from click.testing import CliRunner
from planctl.cli import cli

# ---------------------------------------------------------------------------
# Group A — Verb existence
# ---------------------------------------------------------------------------

# Multi-word verb prefixes the planctl CLI exposes as nested Click groups.
# When extracting a verb from `planctl <words...>`, if the first word is one
# of these, we keep both words as the argv; otherwise we keep just the first.
# Sourced from `planctl --help` (top-level groups with subcommands).
_MULTIWORD_PREFIXES: frozenset[str] = frozenset(
    {"epic", "task", "worker", "dep", "config", "codex"}
)

_TMPL_PATH: Path = (
    Path(__file__).resolve().parents[1] / "template" / "skills" / "work.md.tmpl"
)


def _extract_planctl_verbs(tmpl_text: str) -> list[tuple[str, ...]]:
    """Extract every `planctl <verb>` invocation from fenced bash blocks.

    Returns a deduplicated, sorted list of argv tuples (e.g. ``("show",)``,
    ``("worker", "resume")``). Argument placeholders like ``<task_id>`` and
    flag tokens like ``--reason`` are stripped — we only care about the verb
    path itself.
    """
    verbs: set[tuple[str, ...]] = set()
    in_bash = False
    for line in tmpl_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("```bash"):
            in_bash = True
            continue
        if stripped.startswith("```"):
            in_bash = False
            continue
        if not in_bash:
            continue

        # Match every `planctl <word> [<word> ...]` occurrence on the line.
        # Allow one or more word tokens (word chars + dash) separated by spaces.
        for match in re.finditer(r"planctl\s+([\w-]+(?:\s+[\w-]+)*)", line):
            words = match.group(1).split()
            if not words:
                continue
            head = words[0]
            if head in _MULTIWORD_PREFIXES and len(words) >= 2:
                verbs.add((head, words[1]))
            else:
                verbs.add((head,))

    return sorted(verbs)


# Compute the verb list at import time so pytest can use it for parametrize ids.
_VERBS: list[tuple[str, ...]] = _extract_planctl_verbs(_TMPL_PATH.read_text())


def test_extracted_verbs_nonempty():
    """Sanity: the extractor found at least one verb in the template.

    If this fires, the fenced-bash scanner regressed and the parametrized
    test below would silently pass with zero parameters.
    """
    assert len(_VERBS) > 0, "no planctl verbs extracted from work.md.tmpl"


@pytest.mark.parametrize(
    "verb_parts",
    _VERBS,
    ids=lambda parts: "planctl-" + "-".join(parts),
)
def test_work_tmpl_planctl_verbs_have_help(verb_parts: tuple[str, ...]):
    """Every `planctl <verb>` referenced in `work.md.tmpl` must respond to
    ``--help`` with exit code 0 — i.e. it exists in the CLI surface.

    Mirrors the `test_cli_help` pattern from `test_cli.py`. ``--help`` is
    project-independent (no chdir to a planctl project required); Click's
    `--help` short-circuits the command body.
    """
    result = CliRunner().invoke(cli, [*verb_parts, "--help"])
    assert result.exit_code == 0, (
        f"planctl {' '.join(verb_parts)} --help failed:\n{result.output}"
    )


# ---------------------------------------------------------------------------
# Group B — agentId regex
# ---------------------------------------------------------------------------

# Frozen contract: this is the regex Phase 3c of work.md.tmpl uses (and
# `apps/planctl/scripts/classify_worker_dropoffs.py:189` already uses live)
# to capture the worker's agent_id from the Task tool result string.
AGENT_ID_PATTERN: re.Pattern[str] = re.compile(r"agentId:\s*([a-f0-9]{10,})")

# Frozen sample mirroring the actual Task tool result tail.
_AGENT_ID_SAMPLE: str = (
    "Worker complete.\n"
    "agentId: a1b2c3d4e5f6 (use SendMessage with to: 'a1b2c3d4e5f6' "
    "to continue this agent)"
)


def test_agentid_regex_matches_task_tool_result():
    """`re.search` against the frozen sample captures the hex agent_id."""
    m = AGENT_ID_PATTERN.search(_AGENT_ID_SAMPLE)
    assert m is not None, "regex failed to find agentId in sample string"
    assert m.group(1) == "a1b2c3d4e5f6"


def test_agentid_regex_negative_no_match():
    """Strings without `agentId:` return None — no false positives."""
    assert AGENT_ID_PATTERN.search("no agent id here") is None


def test_agentid_regex_requires_search_not_match():
    """Correctness note: `re.match` has an implicit `^` and would silently
    return None on the sample (which has 'Worker complete.\\n' before the
    `agentId:` token). The Phase 3c contract is `re.search`, not `re.match`
    — this assertion pins it.
    """
    assert AGENT_ID_PATTERN.match(_AGENT_ID_SAMPLE) is None, (
        "re.match unexpectedly matched — sample must have content before "
        "`agentId:` so the regex contract stays `re.search`"
    )


# ---------------------------------------------------------------------------
# Group C — Tier-routed worker plugins (fn-593)
# ---------------------------------------------------------------------------
#
# fn-593 moved the worker agent files OUT of planctl's own `agents/` and INTO
# per-tier plugins under `claude/work-plugins/<tier>/agents/worker.md`. Keeper
# reads `task.tier` from its own projected Task data and adds
# `--plugin-dir claude/work-plugins/<tier>` so exactly one tier-plugin
# loads per session. The spawning skill (`work.md.tmpl`) targets the bare
# literal `subagent_type="work:worker"` — the tier suffix is gone from the
# spawn site (it now lives in keeper's `--plugin-dir` choice).
#
# This group pins the new shape:
#   - The OLD `apps/planctl/agents/worker-{medium,high,xhigh,max}.md` and
#     `worker-codex-{medium,high}.md` files MUST NOT exist on disk — they
#     were deleted in fn-593 task .6 and the agent-template fan-out now
#     emits directly into `claude/work-plugins/<tier>/agents/worker.md`.
#   - The NEW `claude/work-plugins/<tier>/agents/worker.md` files MUST exist
#     for every claude tier, set `model: opus`, and declare the
#     matching `effort:`.

_PLANCTL_AGENTS_DIR: Path = Path(__file__).resolve().parents[1] / "agents"
_WORK_PLUGINS_DIR: Path = Path(__file__).resolve().parents[1] / "work-plugins"

_TIERS: tuple[str, ...] = ("medium", "high", "xhigh", "max")
_DELETED_AGENT_BASENAMES: tuple[str, ...] = (
    "worker-medium.md",
    "worker-high.md",
    "worker-xhigh.md",
    "worker-max.md",
    "worker-codex-medium.md",
    "worker-codex-high.md",
)


def _read_frontmatter(path: Path) -> dict[str, str]:
    """Parse the leading YAML frontmatter block (between `---` delimiters).

    Minimal regex-based extractor that captures the keys we care about
    (`name`, `model`, `effort`, plus any others as bonus). Tolerates both
    quoted and bare scalar values. Avoids the full PyYAML dep since these
    test invariants only need to compare a handful of frozen scalars.
    """
    text = path.read_text()
    m = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    assert m is not None, f"no frontmatter delimiter pair found in {path}"
    block = m.group(1)
    fm: dict[str, str] = {}
    # `key: value` per line (skip nested keys / empty lines).
    for line in block.splitlines():
        line_match = re.match(r"^([a-zA-Z_][\w-]*):\s*(.*)$", line)
        if not line_match:
            continue
        key = line_match.group(1)
        value = line_match.group(2).strip()
        # Strip surrounding quotes (both single and double).
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        fm[key] = value
    return fm


@pytest.mark.parametrize("basename", _DELETED_AGENT_BASENAMES)
def test_old_tier_suffixed_agent_files_removed(basename: str):
    """fn-593 deleted the tier-suffixed worker agents from planctl's own
    `agents/`. The agent-template fan-out now writes directly into
    `claude/work-plugins/<tier>/agents/worker.md`, so these files no longer
    get regenerated. Any file matching `worker-*.md` reappearing in this
    directory means the fan-out's `render_to:` directive regressed (or a
    stale rendered file was checked in).
    """
    path = _PLANCTL_AGENTS_DIR / basename
    assert not path.exists(), (
        f"{path} still exists — fn-593 deleted the tier-suffixed worker "
        f"agents from planctl's plugin. The fan-out now emits to "
        f"`claude/work-plugins/<tier>/agents/worker.md` via the template's "
        f"`render_to:` frontmatter. Delete this file and check that "
        f"`template/agents/worker[-codex].md.tmpl` still carries "
        f"the cross-boundary `render_to:` directive."
    )


@pytest.mark.parametrize("tier", _TIERS)
def test_work_plugin_worker_agent_rendered_and_pinned(tier: str):
    """Each `claude/work-plugins/<tier>/agents/worker.md` exists, names
    itself `worker`, sets `model: opus`, and declares the matching effort.

    If this fails with "file not rendered," run `scripts/install.sh` to
    regenerate from `template/agents/worker.md.tmpl`.
    """
    path = _WORK_PLUGINS_DIR / tier / "agents" / "worker.md"
    assert path.exists(), f"{path} not rendered — run scripts/install.sh"
    fm = _read_frontmatter(path)
    assert fm.get("name") == "worker", (
        f"{path}: frontmatter name={fm.get('name')!r}, expected 'worker' "
        f"(the agent is addressed as `work:worker` — scope from the plugin "
        f"name, not the agent name)"
    )
    assert fm.get("model") == "opus", (
        f"{path}: frontmatter model={fm.get('model')!r}, expected the bare "
        f"'opus' alias — refer to the model family, not a version number, and "
        f"let the harness resolve the concrete model id"
    )
    assert fm.get("effort") == tier, (
        f"{path}: frontmatter effort={fm.get('effort')!r}, expected {tier!r}"
    )


# ---------------------------------------------------------------------------
# Group D — Spawn shape: bare `work:worker`, no tier suffix, no model= kwarg
# ---------------------------------------------------------------------------
#
# fn-593 moved tier routing OUT of the skill (was: Phase 2a's runtime
# 4-band heuristic + `subagent_type="plan:worker-<tier>"`) and INTO the
# planner + keeper (now: `/plan:plan` picks tier at decomposition time;
# keeper reads it from its own projected Task data and loads
# `claude/work-plugins/<tier>/`). The skill spawns the bare literal
# `Task(subagent_type="work:worker")` because exactly one tier-plugin is
# in scope per session.
#
# This group's polarity flipped vs the pre-fn-593 shape: it now REQUIRES
# the bare `work:worker` literal and FORBIDS any `plan:worker-<tier>`
# references at the spawn site.


def _extract_task_call_blocks(text: str, subagent_needle: str) -> list[str]:
    """Return each `Task(...)` literal block whose body contains `subagent_needle`.

    Looks for a literal `Task(` opener, then accumulates lines until paren
    depth returns to zero. We bound on the Python call syntax — not a ±N
    line window — so prose like "do not pass `model=` on the spawn" never
    leaks into the captured block. Only the actual spawn-call kwargs are
    inspected for `model=`.

    A block is returned only if `subagent_needle` (e.g. `work:worker`) shows
    up inside the captured call body — Task() blocks for unrelated
    subagents are skipped.
    """
    lines = text.splitlines()
    blocks: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        # Cheap pre-filter: line must contain `Task(`.
        if "Task(" not in line:
            i += 1
            continue
        # Skip the comment-form Task( inside backticks-only descriptive prose
        # by scanning paren depth from this position. Standard Markdown
        # spawn blocks start the call on its own line inside a fenced code
        # block; this is the shape we care about.
        depth = 0
        start = i
        captured: list[str] = []
        while i < len(lines):
            captured.append(lines[i])
            depth += lines[i].count("(") - lines[i].count(")")
            i += 1
            if depth <= 0 and start != i - 1:
                break
            if depth <= 0:
                # Single-line Task(...) — done.
                break
        block = "\n".join(captured)
        if subagent_needle in block:
            blocks.append(block)
    return blocks


def test_work_skill_uses_bare_work_worker_no_model_kwarg():
    """Phase 2a of `work.md.tmpl` must spawn the worker via
    `subagent_type="work:worker"` as a bare literal — no f-string, no
    tier suffix, no `model=` kwarg adjacent to the Task call.

    fn-593 moved tier routing into keeper's `--plugin-dir` choice,
    so the skill's spawn target is fully tier-agnostic.
    """
    tmpl = _TMPL_PATH.read_text()
    # The bare-literal spawn target must appear at least once.
    assert 'subagent_type="work:worker"' in tmpl, (
        'work.md.tmpl Phase 2a does not spawn `subagent_type="work:worker"` — '
        "fn-593 requires the bare literal; tier routing now lives in "
        "keeper's `--plugin-dir` choice."
    )
    # The OLD tier-suffixed shapes must not appear at the spawn site.
    # Allow them inside fenced prose only if they're clearly historical
    # (we check no Task(...) block carries the old shape, below).
    assert 'subagent_type="plan:worker-<tier>"' not in tmpl, (
        "work.md.tmpl re-introduces the old tier-suffixed literal "
        '`subagent_type="plan:worker-<tier>"` — fn-593 retired this shape. '
        "The spawn target is `work:worker`; tier lives on keeper's "
        "`--plugin-dir`."
    )
    assert 'subagent_type=f"plan:worker-{tier}"' not in tmpl, (
        "work.md.tmpl re-introduces the old tier-suffixed f-string "
        '`subagent_type=f"plan:worker-{tier}"` — fn-593 retired this shape.'
    )
    # No Task(...) call may reference the old `plan:worker-` namespace.
    legacy_blocks = _extract_task_call_blocks(tmpl, "plan:worker-")
    assert len(legacy_blocks) == 0, (
        "work.md.tmpl has Task(...) calls still spawning `plan:worker-<tier>` "
        "subagents — fn-593 retired this shape. Offending blocks:\n"
        + "\n---\n".join(legacy_blocks)
    )
    # The `planctl task set-tier` persist call must not appear as a LIVE
    # bash invocation — fn-593 moved tier persistence to `planctl scaffold`
    # (decomposition time, written into the task JSON directly). Historical
    # mentions in guardrail prose (e.g. "no `task set-tier` write") are OK;
    # only the executable invocation form is forbidden.
    assert "planctl task set-tier" not in tmpl, (
        "work.md.tmpl still invokes `planctl task set-tier` — fn-593 "
        "moved tier persistence to scaffold time. The skill no longer "
        "writes tier at runtime."
    )
    # `model=` must not appear inside any Task(...) call that spawns the
    # `work:worker` subagent. Prose like "do not pass `model=` on the
    # spawn" is intentionally outside the captured block.
    worker_blocks = _extract_task_call_blocks(tmpl, "work:worker")
    assert len(worker_blocks) > 0, (
        "no Task(...) blocks spawning `work:worker` found in "
        "work.md.tmpl — the no-model-kwarg invariant cannot be checked "
        "without at least one spawn block to inspect"
    )
    for block in worker_blocks:
        assert "model=" not in block, (
            f"work.md.tmpl Task(...) call carries `model=` kwarg — "
            f"the agent file owns the model. Block:\n{block}"
        )


# ---------------------------------------------------------------------------
# Group E — Input-shape contract (fn-474)
# ---------------------------------------------------------------------------
#
# `/plan:work` accepts exactly one input shape: `fn-N-slug.M` (task id). The
# fn-474 strip removed the dedicated bare-epic rejection branch and the
# `/plan:plan` carve that contrasted task-input against epic-input. This
# group pins the post-strip contract so the rejected shape can't creep back
# via well-meaning future edits.


_WHEN_TO_INVOKE_RE: re.Pattern[str] = re.compile(
    r"^## When to invoke\s*\n(.*?)(?=^## )", re.DOTALL | re.MULTILINE
)

# Bare epic id (no `.M` tail). The contract: this pattern may appear inside
# the `## Phase 1 — Resolve input` rejection clause but never inside the
# `## When to invoke` section as an accepted input shape.
_BARE_EPIC_PATTERN_LITERAL: str = "fn-N-slug"


def test_when_to_invoke_names_only_task_shape():
    """The `## When to invoke` section must name exactly one accepted input
    shape — `fn-N-slug.M` — and must not advertise a bare epic id (`fn-N-slug`
    not followed by `.M`) as an accepted alternative.

    Pre-fn-474 prose used to mention bare epic ids as a *rejected* alternative
    under "v0 accepts one input shape only"; fn-474 dropped that framing.
    Any future edit that re-introduces a bare-epic discussion (accepted or
    rejected) in this section is a contract drift.
    """
    tmpl = _TMPL_PATH.read_text()
    m = _WHEN_TO_INVOKE_RE.search(tmpl)
    assert m is not None, "could not locate `## When to invoke` section in work.md.tmpl"
    section = m.group(1)
    # The accepted shape `fn-N-slug.M` must appear.
    assert "fn-N-slug.M" in section, (
        "`## When to invoke` does not name the accepted task-id shape (`fn-N-slug.M`)"
    )
    # The bare-epic shape `fn-N-slug` must appear only as the prefix of
    # `fn-N-slug.M` — never standalone. Strip the accepted shape and check
    # the bare literal doesn't survive.
    leftover = section.replace("fn-N-slug.M", "")
    assert _BARE_EPIC_PATTERN_LITERAL not in leftover, (
        "`## When to invoke` mentions a bare epic id shape (`fn-N-slug`) "
        "outside the accepted `fn-N-slug.M` form. The fn-474 strip removed "
        "epic-id framing from this section; do not re-introduce it. Section:"
        f"\n{section}"
    )


def test_bare_epic_id_pattern_only_in_rejection_clause():
    """The bare-epic regex pattern (`^fn-\\d+(-[a-z0-9-]+)?$`) must not
    appear anywhere in the template. fn-474 removed the dedicated bare-epic
    rejection branch in Phase 1; the single catch-all rejection covers it
    along with every other malformed input.

    Pinning the absence of this regex literal prevents a future edit from
    re-introducing a parallel bare-epic-only rejection branch (which would
    necessarily contrast with task-input and revive the stripped framing).
    """
    tmpl = _TMPL_PATH.read_text()
    # The exact regex literal the pre-strip template used.
    bare_epic_regex = r"^fn-\d+(-[a-z0-9-]+)?$"
    assert bare_epic_regex not in tmpl, (
        "work.md.tmpl re-introduces the bare-epic regex literal "
        f"(`{bare_epic_regex}`) — the fn-474 strip removed this dedicated "
        "rejection branch; a single catch-all rejection covers bare epic ids "
        "along with every other malformed input."
    )
