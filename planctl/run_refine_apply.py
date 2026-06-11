"""planctl refine-apply - Apply a refine delta to an EXISTING epic tree.

Refine's mutating equivalent of ``scaffold``, but over an epic that already
exists. Reads a single YAML *delta* describing four kinds of change and applies
them all in one transactional, assert-all, collect-all call:

- **add_tasks** — brand-new tasks (``title`` + four-section ``spec`` + optional
  ``deps`` / ``snippets`` / ``bundles``). A new task's ``deps`` may reference
  BOTH existing task ids (strings, e.g. ``fn-7.2``) AND other new tasks by
  1-based ordinal into the ``add_tasks`` list (ints). Two-pass id allocation
  resolves the new ordinals to ``<epic_id>.M`` ids after the post-delta max is
  known.
- **rewrite_specs** — replace the spec markdown of an existing task
  (``task_id`` → new four-section ``spec``).
- **rewire_deps** — replace the FULL dependency list of an existing task
  (``task_id`` → new dep list of existing/new task ids). An empty list clears
  deps. This is a replacement, not an add — it expresses both drops and adds.
- **epic.spec** — rewrite the epic spec markdown.

No hard task deletion: planctl's graph is append-only. "Retiring" a task stays
``task reset`` + an obsolete spec-rewrite, which this verb expresses as a normal
``rewrite_specs`` entry.

Execution order is strict **assert-all → mutate → emit**, mirroring
``run_scaffold.py``. Every check (YAML shape/type, epic existence, per-spec
``ensure_valid_task_spec``, snippet/bundle regex, dep target existence in the
POST-delta tree, ``detect_cycles`` on the post-delta graph, target-task
existence for rewrites/rewires, duplicate-target detection) runs upfront and
collects ALL errors in one pass BEFORE any write. On failure it emits a
structured ``{success:false, error:{code, message, details:[per-entry]}}``
envelope on stdout and exits non-zero, having written nothing. Codes:

- ``bad_yaml`` — parse/shape/type failure
- ``epic_not_found`` — target epic JSON absent
- ``spec_invalid`` — a task spec failed ``ensure_valid_task_spec``
- ``ref_invalid`` — snippet/bundle regex rejected a ref
- ``target_invalid`` — a rewrite/rewire targets a task absent in the epic, or a
  duplicate target appears
- ``dep_invalid`` — a dep references a task absent after the delta, or a
  new-ordinal is out of range / self-referential
- ``dep_cycle`` — the resolved post-delta graph has a cycle
- ``repo_invalid`` — per-``add_tasks`` entry ``target_repo`` is relative,
  empty after strip, or carries an unresolvable ``~`` (no ``$HOME`` / unknown
  user). Type errors on the field surface as ``bad_yaml`` instead.
- ``tier_invalid`` — per-``add_tasks`` entry ``tier`` is missing, or its value
  is not one of ``TASK_TIERS`` (``medium | high | xhigh | max``). Type errors
  on the field surface as ``bad_yaml`` instead. The field is REQUIRED on every
  new task entry — mirrors scaffold's enforcement; no null default.
  ``rewrite_specs`` and ``rewire_deps`` do not mint
  new tasks and do not need tier validation.
- ``id_collision`` — backstop: a just-allocated new-task path already exists

Because ``refine-apply`` rewrites specs/deps on an EXISTING epic, it clears the
epic's ``last_validated_at`` marker (joins ``VALIDATION_RESTAMP_VERBS``) — the
core asymmetry with ``scaffold``, which only ever mints a fresh epic whose
marker already defaults to null.

Atomicity: like ``scaffold``, assert-all eliminates the validation-failure
partial-write class entirely. The residual window is a crash mid-write —
``planctl._util.atomic_write`` is per-file atomic (write-temp + rename), not
tree-level transactional, so a SIGKILL between two ``atomic_write`` calls could
leave some-but-not-all of the delta on disk. This matches ``scaffold``'s posture
and is documented, not eliminated.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import TypeGuard

# Pre-parse byte-size cap (1 MiB) to defend against YAML billion-laughs DoS.
# Mirrors run_scaffold._MAX_YAML_BYTES.
_MAX_YAML_BYTES = 1 * 1024 * 1024


def _emit_failure(code: str, message: str, details: list[str]) -> int:
    """Emit a structured failure envelope and return exit code 1.

    Mirrors ``run_scaffold._emit_failure``: bypasses ``output.emit_error``
    (which hard-fails on the first error) because refine-apply accumulates all
    errors and emits one envelope. Compact single-line JSON matches the
    mutating-verb shape.
    """
    envelope = {
        "success": False,
        "error": {
            "code": code,
            "message": message,
            "details": details,
        },
    }
    print(json.dumps(envelope, separators=(",", ":")), flush=True)
    return 1


def _is_str(v: object) -> TypeGuard[str]:
    """YAML implicit-typing guard: require an actual string, not bool/int/datetime."""
    return isinstance(v, str)


def _is_list_of_str(v: object) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def run(args: SimpleNamespace) -> int:  # noqa: PLR0911, PLR0912, PLR0915 — single transactional flow
    from planctl.deps import detect_cycles
    from planctl.ids import is_epic_id, is_task_id, scan_max_task_id
    from planctl.models import TASK_TIERS
    from planctl.output import emit
    from planctl.project import resolve_project
    from planctl.repo_inference import expand_path
    from planctl.run_epic_create import _epic_id_lock
    from planctl.specs import ensure_valid_task_spec
    from planctl.store import atomic_write, atomic_write_json, load_json, now_iso

    epic_id: str = args.epic_id
    file_arg: str = args.file

    # ------------------------------------------------------------------
    # Phase 0: epic id shape + existence (the delta targets an existing tree)
    # ------------------------------------------------------------------
    if not is_epic_id(epic_id):
        return _emit_failure(
            "bad_yaml",
            f"Invalid epic id: {epic_id}",
            [f"epic_id: {epic_id}"],
        )

    ctx = resolve_project()
    data_dir = ctx.data_dir
    primary_repo = ctx.project_path

    epic_path = data_dir / "epics" / f"{epic_id}.json"
    epic_spec_path = data_dir / "specs" / f"{epic_id}.md"
    if not epic_path.exists():
        return _emit_failure(
            "epic_not_found",
            f"Epic not found in {ctx.project_path}: {epic_id}",
            [f"epic_id: {epic_id}"],
        )

    # ------------------------------------------------------------------
    # Phase 1: parse YAML (guarded by byte-cap)
    # ------------------------------------------------------------------
    # `--file -` reads YAML bytes from stdin (1 MiB cap applies pre-decode via
    # `sys.stdin.buffer.read()` so the universal-newlines text-mode rewrite
    # does not undercount).  TTY-interactive stdin is rejected to avoid a
    # silent hang waiting for keyboard input.
    if file_arg == "-":
        if sys.stdin.isatty():
            return _emit_failure(
                "bad_yaml",
                "stdin is a TTY — pass `--file <path>` or pipe YAML on stdin",
                ["file: -"],
            )
        try:
            raw_bytes = sys.stdin.buffer.read(_MAX_YAML_BYTES + 1)
        except OSError as exc:
            return _emit_failure(
                "bad_yaml",
                f"Could not read YAML from stdin: {exc}",
                ["file: -"],
            )
    else:
        file_path = Path(file_arg)
        try:
            raw_bytes = file_path.read_bytes()
        except OSError as exc:
            return _emit_failure(
                "bad_yaml",
                f"Could not read YAML file: {exc}",
                [f"file: {file_arg}"],
            )

    if len(raw_bytes) > _MAX_YAML_BYTES:
        return _emit_failure(
            "bad_yaml",
            f"YAML file exceeds {_MAX_YAML_BYTES} bytes (got {len(raw_bytes)})",
            [f"file: {file_arg}"],
        )

    try:
        import yaml
    except ImportError as exc:  # pragma: no cover — pyyaml is a direct dependency
        return _emit_failure("bad_yaml", f"pyyaml not available: {exc}", [])

    try:
        doc = yaml.safe_load(raw_bytes.decode("utf-8"))
    except yaml.YAMLError as exc:
        return _emit_failure(
            "bad_yaml",
            f"YAML parse error: {exc}",
            [f"file: {file_arg}"],
        )
    except UnicodeDecodeError as exc:
        return _emit_failure(
            "bad_yaml",
            f"YAML file is not valid UTF-8: {exc}",
            [f"file: {file_arg}"],
        )

    # ------------------------------------------------------------------
    # Phase 2: validate shape — accumulate ALL errors before returning
    # ------------------------------------------------------------------
    errors: list[str] = []

    if not isinstance(doc, dict):
        return _emit_failure(
            "bad_yaml",
            "Top-level YAML must be a mapping (any of `epic:`, `add_tasks:`, "
            "`rewrite_specs:`, `rewire_deps:`)",
            [f"got: {type(doc).__name__}"],
        )

    epic_node = doc.get("epic", {})
    add_tasks_node = doc.get("add_tasks", [])
    rewrite_specs_node = doc.get("rewrite_specs", [])
    rewire_deps_node = doc.get("rewire_deps", [])

    if not isinstance(epic_node, dict):
        errors.append("epic: must be a mapping when present")
        epic_node = {}
    if not isinstance(add_tasks_node, list):
        errors.append("add_tasks: must be a list when present")
        add_tasks_node = []
    if not isinstance(rewrite_specs_node, list):
        errors.append("rewrite_specs: must be a list when present")
        rewrite_specs_node = []
    if not isinstance(rewire_deps_node, list):
        errors.append("rewire_deps: must be a list when present")
        rewire_deps_node = []

    if errors:
        return _emit_failure("bad_yaml", "Invalid refine-apply YAML shape", errors)

    if (
        not epic_node.get("spec")
        and not add_tasks_node
        and not rewrite_specs_node
        and not rewire_deps_node
    ):
        return _emit_failure(
            "bad_yaml",
            "Delta is empty — supply at least one of `epic.spec`, `add_tasks`, "
            "`rewrite_specs`, `rewire_deps`",
            [],
        )

    # --- Epic spec rewrite (optional) ---------------------------------
    epic_spec_rewrite: str | None = None
    if "spec" in epic_node:
        epic_spec = epic_node.get("spec")
        if not _is_str(epic_spec):
            errors.append("epic: `spec` must be a string (use a `|` block scalar)")
        else:
            epic_spec_rewrite = epic_spec

    # --- Enumerate existing task ids (for target + dep existence checks) ---
    existing_task_ids: set[str] = set()
    tasks_dir = data_dir / "tasks"
    if tasks_dir.exists():
        for f in tasks_dir.glob(f"{epic_id}.*.json"):
            existing_task_ids.add(f.stem)

    # --- add_tasks validation (per-entry) -----------------------------
    n_new = len(add_tasks_node)
    new_titles: list[str] = []
    new_specs: list[str] = []
    new_snippets_list: list[list[str]] = []
    new_bundles_list: list[list[str]] = []
    # Raw deps: each entry is a list mixing existing-id strings + new-ordinal ints.
    new_deps_raw: list[list[str | int]] = []
    # None ⇒ omitted → defaults to epic.primary_repo at mutate time.
    # str ⇒ already canonicalised (expand_path) absolute path.
    new_target_repos: list[str | None] = []
    # Tier is REQUIRED on every add_tasks entry — mirrors scaffold's
    # enforcement. Each entry is a validated TASK_TIERS member; placeholder
    # ""s land here only on entries that already failed an earlier check
    # (shape error / non-string / missing / unknown), in which case the verb
    # has accumulated an envelope-failing error and the task_def write path
    # is unreachable.
    new_tiers: list[str] = []

    spec_errors: list[str] = []
    dep_errors: list[str] = []
    repo_errors: list[str] = []
    tier_errors: list[str] = []

    for i, entry in enumerate(add_tasks_node, start=1):
        prefix = f"add_tasks #{i}"
        if not isinstance(entry, dict):
            errors.append(f"{prefix}: must be a mapping")
            new_titles.append("")
            new_specs.append("")
            new_snippets_list.append([])
            new_bundles_list.append([])
            new_deps_raw.append([])
            new_target_repos.append(None)
            new_tiers.append("")
            continue

        title = entry.get("title")
        if not _is_str(title) or not title.strip():
            errors.append(f"{prefix}: `title` must be a non-empty string")
            title = ""
        new_titles.append(title if isinstance(title, str) else "")

        spec = entry.get("spec")
        if not _is_str(spec) or not spec.strip():
            spec_errors.append(f"{prefix}: `spec` must be a non-empty string")
            spec = ""
        else:
            try:
                ensure_valid_task_spec(spec)
            except ValueError as exc:
                spec_errors.append(f"{prefix}: spec invalid: {exc}")
        new_specs.append(spec)

        # Dormant-seam pass-through: `snippets`/`bundles` persist verbatim into
        # the new task record, unvalidated — whatever the planner writes is what
        # lands. No regex gate, no resolution.
        new_snippets_list.append(entry.get("snippets", []))
        new_bundles_list.append(entry.get("bundles", []))

        deps = entry.get("deps", [])
        if not isinstance(deps, list):
            dep_errors.append(
                f"{prefix}: `deps` must be a list of existing task ids (str) "
                "and/or 1-based new-ordinal integers"
            )
            deps = []
        else:
            for d in deps:
                # Bools are ints in Python; reject them as ordinals.
                if isinstance(d, bool) or not isinstance(d, (str, int)):
                    dep_errors.append(
                        f"{prefix}: dep {d!r} must be an existing task id (str) "
                        "or a 1-based new-ordinal int"
                    )
        new_deps_raw.append(list(deps) if isinstance(deps, list) else [])

        # Optional per-task `target_repo`. Absent ⇒ defaults to
        # `epic.primary_repo` at mutate time. Type errors are shape failures
        # (`bad_yaml`); resolution failures (relative path, empty-after-strip,
        # unresolvable ~) surface as `repo_invalid`. No filesystem checks at
        # refine-apply time — defer to `validate --epic` and worker spawn
        # (artbird auto-deploy ships epic JSON between machines, so paths must
        # stay portable). Resolution stays OUTSIDE `_epic_id_lock()` below —
        # `expand_path` is pure, the lock is for id allocation only.
        target_repo_raw = entry.get("target_repo")
        if target_repo_raw is None:
            new_target_repos.append(None)
        elif not _is_str(target_repo_raw):
            errors.append(f"{prefix}: `target_repo` must be a string when present")
            new_target_repos.append(None)
        else:
            stripped = target_repo_raw.strip()
            if not stripped:
                repo_errors.append(
                    f"{prefix}: `target_repo` must be non-empty after strip"
                )
                new_target_repos.append(None)
            elif not (stripped.startswith("/") or stripped.startswith("~")):
                repo_errors.append(
                    f"{prefix}: `target_repo` {target_repo_raw!r} must be an "
                    "absolute path (starts with / or ~)"
                )
                new_target_repos.append(None)
            else:
                try:
                    new_target_repos.append(expand_path(stripped))
                except RuntimeError as exc:
                    # `Path.expanduser()` raises RuntimeError when ~ cannot be
                    # resolved — no $HOME in container envs, or ~unknownuser.
                    repo_errors.append(
                        f"{prefix}: `target_repo` {target_repo_raw!r} could not "
                        f"be expanded: {exc}"
                    )
                    new_target_repos.append(None)

        # Required per-task `tier` — mirrors scaffold's three-class
        # triage. Missing field and unknown value both surface as
        # `tier_invalid`; type errors (non-string) remain shape failures
        # (`bad_yaml`). Build-forward: no back-compat null default for new
        # tasks. `rewrite_specs` / `rewire_deps` do not mint new tasks and
        # do not need tier validation.
        tier_raw = entry.get("tier")
        if tier_raw is None:
            tier_errors.append(
                f"{prefix}: `tier` is required (missing) — must be one of "
                f"{', '.join(TASK_TIERS)}"
            )
            new_tiers.append("")
        elif not _is_str(tier_raw):
            errors.append(f"{prefix}: `tier` must be a string")
            new_tiers.append("")
        elif tier_raw not in TASK_TIERS:
            tier_errors.append(
                f"{prefix}: `tier` {tier_raw!r} is not one of {', '.join(TASK_TIERS)}"
            )
            new_tiers.append("")
        else:
            new_tiers.append(tier_raw)

    # --- rewrite_specs validation (per-entry) -------------------------
    rewrite_targets: list[str] = []
    rewrite_spec_md: list[str] = []
    seen_rewrite: set[str] = set()
    for i, entry in enumerate(rewrite_specs_node, start=1):
        prefix = f"rewrite_specs #{i}"
        if not isinstance(entry, dict):
            errors.append(f"{prefix}: must be a mapping")
            continue
        tid = entry.get("task_id")
        if not _is_str(tid) or not is_task_id(tid):
            errors.append(f"{prefix}: `task_id` must be a valid task id")
            tid = None
        spec = entry.get("spec")
        if not _is_str(spec) or not spec.strip():
            spec_errors.append(f"{prefix}: `spec` must be a non-empty string")
            spec = ""
        else:
            try:
                ensure_valid_task_spec(spec)
            except ValueError as exc:
                spec_errors.append(f"{prefix}: spec invalid: {exc}")
        if tid is not None:
            if tid in seen_rewrite:
                errors.append(f"{prefix}: duplicate rewrite target {tid}")
            seen_rewrite.add(tid)
            rewrite_targets.append(tid)
            rewrite_spec_md.append(spec)

    # --- rewire_deps validation (per-entry) ---------------------------
    rewire_targets: list[str] = []
    rewire_deps_lists: list[list[str]] = []
    seen_rewire: set[str] = set()
    for i, entry in enumerate(rewire_deps_node, start=1):
        prefix = f"rewire_deps #{i}"
        if not isinstance(entry, dict):
            errors.append(f"{prefix}: must be a mapping")
            continue
        tid = entry.get("task_id")
        if not _is_str(tid) or not is_task_id(tid):
            errors.append(f"{prefix}: `task_id` must be a valid task id")
            tid = None
        deps = entry.get("deps", [])
        if not _is_list_of_str(deps):
            dep_errors.append(
                f"{prefix}: `deps` must be a list of task id strings "
                "(empty list clears deps)"
            )
            deps = []
        if tid is not None:
            if tid in seen_rewire:
                errors.append(f"{prefix}: duplicate rewire target {tid}")
            seen_rewire.add(tid)
            rewire_targets.append(tid)
            rewire_deps_lists.append(list(deps))

    # Shape/type errors short-circuit (`bad_yaml`) — graph integrity below is
    # meaningless when the basic shape is wrong.
    if errors:
        return _emit_failure("bad_yaml", "Invalid refine-apply YAML shape", errors)
    if spec_errors:
        return _emit_failure(
            "spec_invalid",
            "One or more task specs failed validation",
            spec_errors + repo_errors + tier_errors,
        )
    if repo_errors:
        return _emit_failure(
            "repo_invalid",
            "One or more add_tasks `target_repo` values are invalid",
            repo_errors + tier_errors,
        )
    if tier_errors:
        return _emit_failure(
            "tier_invalid",
            "One or more add_tasks `tier` values are invalid",
            tier_errors,
        )

    # ------------------------------------------------------------------
    # Phase 3: allocate new-task ids under the global flock, then resolve
    # the post-delta graph. The flock guards scan_max_task_id against a
    # concurrent task add to the same epic (the suffix is epic-scoped).
    # ------------------------------------------------------------------
    with _epic_id_lock():
        max_task = scan_max_task_id(data_dir, epic_id)
        # Two-pass: ordinal i (1-based into add_tasks) -> id `epic_id.{max+i}`.
        new_id_by_ordinal: dict[int, str] = {
            i: f"{epic_id}.{max_task + i}" for i in range(1, n_new + 1)
        }
        new_task_ids = [new_id_by_ordinal[i] for i in range(1, n_new + 1)]

        # The full set of task ids that exist AFTER the delta lands.
        post_delta_ids: set[str] = set(existing_task_ids) | set(new_task_ids)

        # --- target existence: rewrites/rewires must hit existing tasks ----
        target_errors: list[str] = []
        for tid in rewrite_targets:
            if tid not in existing_task_ids:
                target_errors.append(
                    f"rewrite_specs: task {tid} does not exist in epic {epic_id}"
                )
        for tid in rewire_targets:
            if tid not in existing_task_ids:
                target_errors.append(
                    f"rewire_deps: task {tid} does not exist in epic {epic_id}"
                )
        if target_errors:
            return _emit_failure(
                "target_invalid",
                "One or more rewrite/rewire targets are invalid",
                target_errors,
            )

        # --- resolve new-task deps (existing id str OR new-ordinal int) ----
        resolved_new_deps: list[list[str]] = []
        for i in range(1, n_new + 1):
            resolved: list[str] = []
            for d in new_deps_raw[i - 1]:
                if isinstance(d, str):
                    if d not in post_delta_ids:
                        dep_errors.append(
                            f"add_tasks #{i}: dep {d!r} references a task absent "
                            "after the delta"
                        )
                    else:
                        resolved.append(d)
                else:  # int ordinal into add_tasks
                    if d < 1 or d > n_new:
                        dep_errors.append(
                            f"add_tasks #{i}: dep ordinal {d} out of range "
                            f"(must be 1..{n_new})"
                        )
                    elif d == i:
                        dep_errors.append(
                            f"add_tasks #{i}: dep ordinal {d} is self-referential"
                        )
                    else:
                        resolved.append(new_id_by_ordinal[d])
            resolved_new_deps.append(resolved)

        # --- validate rewired dep targets exist post-delta -----------------
        for idx, tid in enumerate(rewire_targets):
            for d in rewire_deps_lists[idx]:
                if not is_task_id(d):
                    dep_errors.append(
                        f"rewire_deps {tid}: dep {d!r} is not a valid task id"
                    )
                elif d not in post_delta_ids:
                    dep_errors.append(
                        f"rewire_deps {tid}: dep {d!r} references a task absent "
                        "after the delta"
                    )
                elif d == tid:
                    dep_errors.append(
                        f"rewire_deps {tid}: dep {d!r} is self-referential"
                    )

        if dep_errors:
            return _emit_failure(
                "dep_invalid",
                "One or more task dependencies are invalid",
                dep_errors,
            )

        # --- build the POST-delta graph and detect cycles ------------------
        # Load existing tasks' current dep lists, then overlay rewires + adds.
        # Also capture each existing task's `target_repo` (if any) so the Phase
        # 4 mutate block can union existing + new into `epic.touched_repos`
        # without a second filesystem pass. Legacy tasks may pre-date the
        # per-task target_repo field — defensive .get() preserves their
        # absence as None, which the rollup filters out.
        graph: dict[str, dict] = {}
        existing_target_repos: list[str] = []
        for tid in existing_task_ids:
            tdef = load_json(data_dir / "tasks" / f"{tid}.json")
            graph[tid] = {"depends_on": list(tdef.get("depends_on", []))}
            etr = tdef.get("target_repo")
            if etr:
                existing_target_repos.append(etr)
        rewire_by_target = dict(zip(rewire_targets, rewire_deps_lists, strict=True))
        for tid, new_list in rewire_by_target.items():
            graph[tid] = {"depends_on": list(new_list)}
        for i in range(1, n_new + 1):
            graph[new_id_by_ordinal[i]] = {"depends_on": resolved_new_deps[i - 1]}

        cycle = detect_cycles(graph)
        if cycle:
            return _emit_failure(
                "dep_cycle",
                "Post-delta task dependency graph contains a cycle",
                [f"cycle: {' -> '.join(cycle)}"],
            )

        # --- backstop collision check on new-task paths --------------------
        collisions: list[str] = []
        for i in range(1, n_new + 1):
            tid = new_id_by_ordinal[i]
            tp = data_dir / "tasks" / f"{tid}.json"
            sp = data_dir / "specs" / f"{tid}.md"
            if tp.exists():
                collisions.append(f"task JSON exists: {tp}")
            if sp.exists():
                collisions.append(f"task spec exists: {sp}")
        if collisions:
            return _emit_failure(
                "id_collision",
                f"Allocated new-task ids under {epic_id} would overwrite existing files",
                collisions,
            )

        # --------------------------------------------------------------
        # Phase 4: mutate — assert-all is done; write the delta
        # --------------------------------------------------------------
        now = now_iso()

        # Epic JSON: bump updated_at (the new last_validated_at stamp lands
        # after Phase 4 via restamp_epic_or_fail); optionally rewrite epic
        # spec md.  ``last_validated_at`` is re-stamped (not
        # cleared) on the post-write integrity check pass.  refine-apply's
        # own pre-write assert-all already covers cycle / target / dep
        # validity, so the helper's re-check is a defensive backstop that
        # also keeps the verb on the symmetric VALIDATION_RESTAMP_VERBS path.
        epic_def = load_json(epic_path)
        epic_def["updated_at"] = now
        epic_target_repo = epic_def.get("primary_repo")

        # Resolve per-new-task target_repos: each None defaults to the epic's
        # primary_repo (backwards-compatible for add_tasks entries that omit
        # the field). `epic.touched_repos` is recomputed on every invocation
        # — including pure `rewrite_specs` / `rewire_deps` deltas with zero
        # `add_tasks` — as the deterministic sorted-uniq rollup of every
        # task's resolved target_repo. Idempotent on the same input; legacy
        # stale target_repos are preserved (validate --epic flags drift, not
        # refine-apply). Falsy values (legacy epics with primary_repo=None,
        # tasks predating per-task target_repo) are filtered from the rollup
        # so the sort never compares str ↔ None.
        resolved_new_target_repos: list[str | None] = [
            tr if tr is not None else epic_target_repo for tr in new_target_repos
        ]
        epic_def["touched_repos"] = sorted(
            {tr for tr in existing_target_repos if tr}
            | {tr for tr in resolved_new_target_repos if tr}
        )
        # Track FRESH-MINT writes under ``written_paths`` so the local
        # write-phase try/except (and the Phase 4.5 re-stamp block below) can
        # unwind on a MID-WRITE crash. refine-apply previously wrote the whole
        # delta outside any unwind — a raise mid-write or in Phase 4.5 left a
        # half-applied delta on disk. Now new-task JSON / spec writes are
        # recorded for the single-writer mid-write atomicity guarantee.
        #
        # CRITICAL: existing-file rewrites (the epic JSON, epic spec, rewrite_
        # /rewire_ targets) are intentionally OMITTED from ``written_paths``.
        # They overwrite user data via atomic_write's rename — unlinking them
        # on a downstream failure would destroy the user's epic / task. Mid-
        # write failure leaves the rename-atomic previous bytes in place,
        # which is exactly what we want for these paths.
        written_paths: list[Path] = []
        try:
            # Existing-file rewrite — NOT recorded for unwind. atomic_write
            # rename leaves previous bytes intact on a mid-write failure.
            atomic_write_json(epic_path, epic_def)
            if epic_spec_rewrite is not None:
                # Existing-file rewrite — NOT recorded for unwind (same
                # rationale as the epic JSON above).
                atomic_write(epic_spec_path, epic_spec_rewrite)

            # New tasks (two-pass id allocation already resolved deps to ids).
            # FRESH-MINT paths — recorded for unwind so a pre-commit failure
            # leaves no orphan task JSON / spec on disk.
            for i in range(1, n_new + 1):
                tid = new_id_by_ordinal[i]
                task_def = {
                    "id": tid,
                    "epic": epic_id,
                    "title": new_titles[i - 1],
                    "priority": None,
                    "depends_on": resolved_new_deps[i - 1],
                    "target_repo": resolved_new_target_repos[i - 1],
                    # Tier rides the refine-apply YAML through to the
                    # persisted task_def, mirroring scaffold. Every value
                    # reaching here is a validated TASK_TIERS member; the
                    # missing / unknown / non-string paths emitted envelope-
                    # failing errors above and never made it to this write
                    # site.
                    "tier": new_tiers[i - 1],
                    "snippets": new_snippets_list[i - 1],
                    "bundles": new_bundles_list[i - 1],
                    "created_at": now,
                    "updated_at": now,
                }
                tp = data_dir / "tasks" / f"{tid}.json"
                sp = data_dir / "specs" / f"{tid}.md"
                atomic_write_json(tp, task_def)
                written_paths.append(tp)
                atomic_write(sp, new_specs[i - 1])
                written_paths.append(sp)

            # Spec rewrites on existing tasks (spec md + bump task updated_at).
            # The task_def write here is NOT recorded for unwind: it's an
            # update to a pre-existing file, so unlinking it on a downstream
            # failure would destroy a still-valid record. Mid-write failure
            # leaves the file's previous valid contents in place (atomic_write
            # is rename-based) — exactly the behavior we want.
            for idx, tid in enumerate(rewrite_targets):
                sp = data_dir / "specs" / f"{tid}.md"
                atomic_write(sp, rewrite_spec_md[idx])
                tdef = load_json(data_dir / "tasks" / f"{tid}.json")
                tdef["updated_at"] = now
                atomic_write_json(data_dir / "tasks" / f"{tid}.json", tdef)

            # Dep rewires on existing tasks (full replacement of depends_on).
            # As above: existing files, no unwind on failure (rename-atomic).
            for idx, tid in enumerate(rewire_targets):
                tdef = load_json(data_dir / "tasks" / f"{tid}.json")
                tdef["depends_on"] = list(rewire_deps_lists[idx])
                tdef["updated_at"] = now
                atomic_write_json(data_dir / "tasks" / f"{tid}.json", tdef)
        except BaseException:
            # Mid-write raise inside the lock (KeyboardInterrupt, disk-full,
            # etc.): unlink the FRESH-MINT files we did write so we leave no
            # orphan task JSON / spec on disk. Existing files we updated
            # mid-write are NOT in ``written_paths`` — atomic_write is
            # rename-based, so a half-update leaves the previous valid bytes
            # in place. Mirror the scaffold pattern. Re-raise so the
            # CLI layer surfaces the failure.
            import contextlib as _ctx

            for p in written_paths:
                with _ctx.suppress(OSError):
                    p.unlink(missing_ok=True)
            raise

    # ------------------------------------------------------------------
    # Phase 4.5: post-write re-stamp of last_validated_at.
    # ------------------------------------------------------------------
    # refine-apply's pre-write assert-all is comprehensive (cycle / target /
    # dep / collision), but the symmetric VALIDATION_RESTAMP_VERBS contract
    # is to validate the post-mutation tree and either re-stamp or emit a
    # structured failure envelope.
    from planctl.validation_restamp import restamp_epic_or_fail

    # Assert filesystem-repo validity at refine-apply time so no trailing
    # ``planctl validate --epic`` is needed.
    # refine-apply targets an EXISTING epic on the same
    # host as the worker spawn, so the resolved paths are local-and-final —
    # safe to enforce here (scaffold's fresh-mint gate already opts in via
    # ``check_epic_tree_in_memory(..., check_filesystem_repos=True)``).
    # The marker-restamp atomic_write_json runs OUTSIDE the
    # _epic_id_lock — the lock guards id allocation only and is deliberately
    # disjoint from the commit lock (no nesting). The re-stamp writes the
    # existing epic_path (already on disk), so a raise here leaves the
    # rename-atomic previous bytes in place. A Phase 4.5 raise unwinds the
    # FRESH-MINT new-task files written in Phase 4 (the epic_path / rewrite
    # / rewire updates are intentionally OMITTED from ``written_paths`` —
    # they're rewrites of existing user data and unlinking them would
    # destroy the epic / task).
    try:
        new_stamp = restamp_epic_or_fail(
            epic_id, data_dir, verb="refine-apply", check_filesystem_repos=True
        )
        epic_def = load_json(epic_path)
        epic_def["last_validated_at"] = new_stamp
        atomic_write_json(epic_path, epic_def)
    except BaseException:
        # Phase 4.5 raise: unlink the FRESH-MINT new-task files written in
        # Phase 4. Pre-existing files updated in Phase 4 are NOT in
        # ``written_paths`` so they're never unlinked here (their previous
        # rename-atomic bytes survive). Re-raise so the CLI layer surfaces
        # the failure.
        import contextlib as _ctx

        for p in written_paths:
            with _ctx.suppress(OSError):
                p.unlink(missing_ok=True)
        raise

    # ------------------------------------------------------------------
    # Phase 5: emit ONE envelope covering the whole delta
    # ------------------------------------------------------------------
    # Route through the central seam. emit(verb=...) builds
    # build_planctl_invocation internally and runs the per-verb auto-commit.
    # The local write-phase try/except blocks above already unwound any
    # FRESH-MINT files on a MID-WRITE crash; a pre-commit raise from the seam
    # leaves the written tree on disk (§10 no-rollback), invisible to the
    # autopilot via the keeper HEAD-gate. The (already released)
    # ``_epic_id_lock`` stays off the git-commit critical path.
    emit(
        {
            "epic_id": epic_id,
            "added_task_ids": new_task_ids,
            "rewritten_specs": list(rewrite_targets),
            "rewired_deps": list(rewire_targets),
            "epic_spec_rewritten": epic_spec_rewrite is not None,
        },
        verb="refine-apply",
        target=epic_id,
        repo_root=ctx.project_path,
        primary_repo=str(primary_repo),
    )
    return 0


def main() -> int:  # pragma: no cover — module-level helper (rare manual call)
    """Allow ``python -m planctl.run_refine_apply`` smoke tests."""
    import argparse

    parser = argparse.ArgumentParser(description="planctl refine-apply")
    parser.add_argument("epic_id")
    parser.add_argument("--file", required=True)
    ns = parser.parse_args()
    args = SimpleNamespace(epic_id=ns.epic_id, file=ns.file)
    return run(args)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
