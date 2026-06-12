"""Consistency checks between `work.md.tmpl` and the `planctl` CLI surface.

This module guards the `/plan:work` skill template against two regressions:

1. **Verb existence** — every `planctl <verb>` invocation referenced inside a
   fenced bash block of `work.md.tmpl` must resolve to a real CLI command.
   A stale verb (e.g. a `planctl task block --category` call) slips past
   review; a parametrized `--help` smoke test catches it the moment the
   template is authored.

2. **agentId regex** — Phase 3c of `work.md.tmpl` extracts the worker's
   `agentId:` from the Task tool result string with
   ``re.search(r"agentId:\\s*([a-f0-9]{10,})", ...)``. The result string has
   content before `agentId`, so `re.match` (with its implicit `^`) silently
   returns `None`; this test pins the contract so any drift is loud.

All CLI invocations route through the shared ``run_cli`` invoker.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from .conftest import run_cli

# ---------------------------------------------------------------------------
# Group A — Verb existence
# ---------------------------------------------------------------------------

# Multi-word verb prefixes the planctl CLI exposes as nested Click groups.
# When extracting a verb from `planctl <words...>`, if the first word is one
# of these, we keep both words as the argv; otherwise we keep just the first.
# Sourced from `planctl --help` (top-level groups with subcommands).
_MULTIWORD_PREFIXES: frozenset[str] = frozenset(
    {"epic", "task", "worker", "dep", "config"}
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
    result = run_cli([*verb_parts, "--help"])
    assert result.exit_code == 0, (
        f"planctl {' '.join(verb_parts)} --help failed:\n{result.output}"
    )


# ---------------------------------------------------------------------------
# Group B — agentId regex
# ---------------------------------------------------------------------------

# Frozen contract: this is the regex Phase 3c of work.md.tmpl uses to
# capture the worker's agent_id from the Task tool result string.
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
# Group C — Tier-routed worker agents in the `plan` plugin
# ---------------------------------------------------------------------------
#
# The four worker agents live in the planctl `plan` plugin's own `agents/`
# directory, one file per tier (`agents/worker-<tier>.md`), each addressable
# `plan:worker-<tier>`. The `template/agents/worker.md.tmpl` carries no
# cross-boundary `render_to:` (or `manifest_description:`) directive;
# promptctl's default agents branch emits `agents/<stem>-<variant>.md` per
# variant directly into the always-loaded plugin's `agents/`. Keeper passes no
# `--plugin-dir`; `claim` maps the task tier to a `worker_agent` name the skill
# spawns.
#
# This group pins the new shape:
#   - The per-tier `agents/worker-{medium,high,xhigh,max}.md` files MUST exist
#     for every tier, name themselves `worker-<tier>`, set `model: opus`, and
#     declare the matching `effort:` — gitignored + sidecar-guarded exactly
#     like `agents/practice-scout.md`.
#
# Run `promptctl render-plugin-templates --project-root <planctl_root>` before
# this suite so the generated agents are on disk.

_PLANCTL_AGENTS_DIR: Path = Path(__file__).resolve().parents[1] / "agents"

_TIERS: tuple[str, ...] = ("medium", "high", "xhigh", "max")


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


@pytest.mark.parametrize("tier", _TIERS)
def test_tier_suffixed_worker_agent_rendered_in_plan_plugin(tier: str):
    """The worker agents live in the `plan` plugin's own `agents/` directory,
    one file per tier (`agents/worker-<tier>.md`). With no `render_to:` on
    `template/agents/worker.md.tmpl`, promptctl's default agents branch emits
    `agents/<stem>-<variant>.md` per variant directly here.

    If this fails with "file not rendered," run
    `promptctl render-plugin-templates --project-root <planctl_root>` to
    regenerate from `template/agents/worker.md.tmpl`.
    """
    path = _PLANCTL_AGENTS_DIR / f"worker-{tier}.md"
    assert path.exists(), (
        f"{path} not rendered — run "
        f"`promptctl render-plugin-templates --project-root <planctl_root>`. "
        f"the per-tier worker agents render into the `plan` plugin's "
        f"`agents/` dir; the template must NOT carry a `render_to:` directive."
    )
    fm = _read_frontmatter(path)
    assert fm.get("name") == f"worker-{tier}", (
        f"{path}: frontmatter name={fm.get('name')!r}, expected "
        f"'worker-{tier}' — the agent is addressed `plan:worker-{tier}`, so "
        f"the `name:` field must carry the tier suffix and the rendered "
        f"filename must match it."
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
# Group D — Spawn shape: envelope-driven `plan:worker-<tier>`, no `work:worker`,
#           no `--plugin-dir`, no `model=` kwarg
# ---------------------------------------------------------------------------
#
# Tier routing rides the emitted `worker_agent` name (`plan:worker-<tier>`) on
# the claim / `worker resume` envelope, and the four worker agents live in the
# always-loaded `plan` plugin. The skill is a pure pass-through — both spawn
# sites set `subagent_type="<worker_agent>"` (the envelope field, rendered as
# `plan:worker-<tier>` in the template's substitution prose). Keeper pushes no
# `--plugin-dir`, so there is no bare `work:worker` literal anywhere.
#
# This group REQUIRES the envelope-driven `plan:worker-<tier>` substitution and
# FORBIDS any bare `work:worker` literal or `--plugin-dir` reference.


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


def test_work_skill_spawns_envelope_worker_agent_no_bare_literal():
    """Both spawn sites of `work.md.tmpl` must pass through the envelope's
    `worker_agent` — `subagent_type="<worker_agent>"` — never the bare
    `work:worker` literal and never an adjacent `model=` kwarg.

    Tier routing rides the emitted `worker_agent` (`plan:worker-<tier>`); the
    skill is a pure pass-through and keeper pushes no `--plugin-dir`.
    """
    tmpl = _TMPL_PATH.read_text()
    # The envelope-driven spawn substitution must appear at both sites.
    spawn_blocks = _extract_task_call_blocks(tmpl, "<worker_agent>")
    assert len(spawn_blocks) >= 2, (
        "work.md.tmpl must carry an envelope-driven "
        '`subagent_type="<worker_agent>"` spawn at BOTH the warm (Phase 2a) '
        "and cold-resume (Phase 2b) sites — the skill is a "
        f"pass-through. Found {len(spawn_blocks)} such block(s)."
    )
    # The bare `work:worker` literal must not appear anywhere.
    assert "work:worker" not in tmpl, (
        "work.md.tmpl still references the bare `work:worker` literal — "
        "it must not. The skill spawns the envelope's `worker_agent` "
        "(`plan:worker-<tier>`); the always-loaded `plan` plugin owns all "
        "four worker agents."
    )
    # Keeper drops `--plugin-dir`, so the skill must not mention it either.
    assert "plugin-dir" not in tmpl, (
        "work.md.tmpl references `--plugin-dir` — there is no "
        "launch-flag coupling; tier routing rides the emitted `worker_agent`."
    )
    # The skill must explain the substitution resolves to `plan:worker-<tier>`.
    assert "plan:worker-<tier>" in tmpl, (
        "work.md.tmpl does not name the `plan:worker-<tier>` agent shape — "
        "the substitution prose must state that the envelope's `worker_agent` "
        "resolves to `plan:worker-<tier>` in the always-loaded `plan` plugin."
    )
    # No old runtime tier-mapping f-string at the spawn site.
    assert 'subagent_type=f"plan:worker-{tier}"' not in tmpl, (
        "work.md.tmpl re-introduces a runtime tier-mapping f-string "
        '`subagent_type=f"plan:worker-{tier}"` — the skill never maps the '
        "tier itself; it spawns the envelope's `worker_agent` verbatim."
    )
    # The `planctl task set-tier` persist call must not appear as a LIVE
    # bash invocation — tier persistence happens at scaffold time, written
    # into the task JSON directly. Historical mentions in guardrail prose
    # are OK; only the executable invocation form is forbidden.
    assert "planctl task set-tier" not in tmpl, (
        "work.md.tmpl still invokes `planctl task set-tier` — tier "
        "persistence happens at scaffold time. The skill no longer writes "
        "tier at runtime."
    )
    # `model=` must not appear inside any Task(...) spawn block. Prose like
    # "do not pass `model=` on the spawn" is intentionally outside the block.
    for block in spawn_blocks:
        assert "model=" not in block, (
            f"work.md.tmpl Task(...) call carries `model=` kwarg — "
            f"the agent file owns the model. Block:\n{block}"
        )


# ---------------------------------------------------------------------------
# Group E — Input-shape contract
# ---------------------------------------------------------------------------
#
# `/plan:work` accepts exactly one input shape: `fn-N-slug.M` (task id). There
# is no dedicated bare-epic rejection branch and no `/plan:plan` carve that
# contrasts task-input against epic-input. This group pins the contract so the
# rejected shape can't creep back via well-meaning future edits.


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

    The section names no bare-epic alternative (accepted or rejected). Any
    future edit that re-introduces a bare-epic discussion in this section is a
    contract drift.
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
        "outside the accepted `fn-N-slug.M` form. There is no "
        "epic-id framing in this section; do not re-introduce it. Section:"
        f"\n{section}"
    )


def test_bare_epic_id_pattern_only_in_rejection_clause():
    """The bare-epic regex pattern (`^fn-\\d+(-[a-z0-9-]+)?$`) must not
    appear anywhere in the template. There is no dedicated bare-epic rejection
    branch in Phase 1; the single catch-all rejection covers it along with
    every other malformed input.

    Pinning the absence of this regex literal prevents a future edit from
    re-introducing a parallel bare-epic-only rejection branch (which would
    necessarily contrast with task-input and revive the stripped framing).
    """
    tmpl = _TMPL_PATH.read_text()
    # The bare-epic regex literal that must not appear.
    bare_epic_regex = r"^fn-\d+(-[a-z0-9-]+)?$"
    assert bare_epic_regex not in tmpl, (
        "work.md.tmpl re-introduces the bare-epic regex literal "
        f"(`{bare_epic_regex}`) — there is no dedicated bare-epic "
        "rejection branch; a single catch-all rejection covers bare epic ids "
        "along with every other malformed input."
    )
