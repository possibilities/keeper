#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# one-shot for fn-732-move-approval-to-runtime-sidecar.2
#
# Move every ``approval`` value out of the git-tracked epic / task JSON and
# into the gitignored runtime sidecar under ``<repo>/.planctl/state/`` — the
# ``approval`` key on the per-task state file
# (``state/tasks/<id>.state.json``) and the per-epic sidecar
# (``state/epics/<id>.state.json``). After the SEED pass every def's approval
# is mirrored into the sidecar; after the (separately-gated) STRIP pass the
# tracked JSON carries no ``approval`` field and the sidecar is the sole write
# target (planctl ``approve`` is runtime-state-only).
#
# TWO PASSES, run separately:
#
#   SEED  (default, idempotent, SAFE to re-run):
#       For each def with an ``approval`` value, write it into the sidecar via
#       a read-modify-write that preserves any existing sidecar fields
#       (status, assignee, …). Never touches the def file. Run this FIRST.
#       Sidecar wins on conflict is NOT applied here — seed only fills the
#       sidecar's ``approval`` from the def, so re-running after an
#       intervening ``approve`` would overwrite a newer sidecar value with the
#       def. To stay safe, seed only writes the sidecar ``approval`` when the
#       sidecar has no ``approval`` yet (fill-if-absent), so it is idempotent
#       AND never clobbers a sidecar-canonical value.
#
#   STRIP (--strip, the ONLY irreversible step — GATED):
#       Pop ``approval`` from every def file and atomic-rewrite it. Run this
#       ONLY after a positive end-to-end verify that keeper folds approval
#       from the sidecar (the def-fallback covers the keeper-boots-first race
#       but a strip with no prior seed would lose the value, so STRIP refuses
#       to run unless every def's approval is already mirrored in the sidecar).
#
# --dry-run mutates nothing in either pass and prints what it WOULD do.
#
# Behavior shared with scripts/migrate_acks_to_state.py:
#   - Calls ``devctl list-roots`` to enumerate parent roots; falls back to
#     ``[/Users/mike/code]`` with a loud WARN when devctl fails.
#   - For each root, globs ``<root>/*/.planctl/`` projects.
#   - Idempotent on re-run.
#
# Does NOT commit. Single-threaded — the file count is well under a second's
# worth of work and the sidecars are per-project.

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def _atomic_write_json(path: Path, data: dict) -> None:
    """Inline mirror of ``planctl.store.atomic_write_json``.

    The PEP 723 script env is isolated from the workspace, so we cannot import
    ``planctl.store`` directly. Format matches byte-for-byte:
    ``json.dumps(data, indent=2, sort_keys=True) + "\\n"``, temp-file written
    next to ``path`` then ``os.replace``'d for atomicity. No touched-paths
    logging — this is a one-shot migration, not a planctl verb.
    """
    content = json.dumps(data, indent=2, sort_keys=True) + "\n"
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        tmp.write(content)
        tmp_path = tmp.name
    os.replace(tmp_path, path)


def _load_json(path: Path) -> dict | None:
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _list_roots() -> list[Path]:
    """Enumerate parent roots via ``devctl list-roots``; fall back loudly."""
    try:
        result = subprocess.run(
            ["devctl", "list-roots"],
            check=True,
            capture_output=True,
            text=True,
        )
        roots = [
            Path(line.strip()) for line in result.stdout.splitlines() if line.strip()
        ]
        if not roots:
            raise RuntimeError("devctl list-roots returned no roots")
        return roots
    except (subprocess.CalledProcessError, FileNotFoundError, RuntimeError) as e:
        print(
            f"WARN: devctl list-roots failed ({e}); falling back to [/Users/mike/code]",
            file=sys.stderr,
        )
        return [Path("/Users/mike/code")]


def _task_sidecar_path(planctl_dir: Path, task_id: str) -> Path:
    return planctl_dir / "state" / "tasks" / f"{task_id}.state.json"


def _epic_sidecar_path(planctl_dir: Path, epic_id: str) -> Path:
    return planctl_dir / "state" / "epics" / f"{epic_id}.state.json"


def _seed_sidecar(sidecar_path: Path, approval: str, dry_run: bool) -> bool:
    """Fill-if-absent the sidecar's ``approval`` from the def value.

    Read-modify-write that preserves every existing sidecar field. Idempotent:
    a sidecar that already carries an ``approval`` is left untouched, so a
    re-run after an intervening ``approve`` never clobbers the sidecar-canonical
    value with the (now stale) def value. Returns True when it wrote (or, in
    dry-run, would write).
    """
    existing = _load_json(sidecar_path) or {}
    if "approval" in existing and existing.get("approval") is not None:
        return False
    if dry_run:
        return True
    existing["approval"] = approval
    sidecar_path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write_json(sidecar_path, existing)
    return True


def _sidecar_has_approval(sidecar_path: Path) -> bool:
    side = _load_json(sidecar_path)
    return bool(side) and side.get("approval") is not None


def _seed_one_project(planctl_dir: Path, dry_run: bool) -> tuple[int, int]:
    """SEED pass: mirror def approvals into sidecars. Returns (epic, task) counts."""
    epics_dir = planctl_dir / "epics"
    tasks_dir = planctl_dir / "tasks"
    epic_seeded = 0
    task_seeded = 0

    if epics_dir.exists():
        for path in sorted(epics_dir.glob("*.json")):
            obj = _load_json(path)
            if obj is None:
                continue
            approval = obj.get("approval")
            if approval is None:
                continue
            epic_id = obj.get("id") or path.stem
            if _seed_sidecar(
                _epic_sidecar_path(planctl_dir, epic_id), approval, dry_run
            ):
                epic_seeded += 1

    if tasks_dir.exists():
        for path in sorted(tasks_dir.glob("*.json")):
            obj = _load_json(path)
            if obj is None:
                continue
            approval = obj.get("approval")
            if approval is None:
                continue
            task_id = obj.get("id") or path.stem
            if _seed_sidecar(
                _task_sidecar_path(planctl_dir, task_id), approval, dry_run
            ):
                task_seeded += 1

    return (epic_seeded, task_seeded)


def _strip_one_project(planctl_dir: Path, dry_run: bool) -> tuple[int, int]:
    """STRIP pass: pop ``approval`` from every def file. Returns (epic, task) counts.

    Refuses (per-file) to strip a def whose approval value is NOT already
    mirrored in the sidecar — that would lose the value. The SEED pass must
    have run first.
    """
    epics_dir = planctl_dir / "epics"
    tasks_dir = planctl_dir / "tasks"
    epic_stripped = 0
    task_stripped = 0

    if epics_dir.exists():
        for path in sorted(epics_dir.glob("*.json")):
            obj = _load_json(path)
            if obj is None or "approval" not in obj:
                continue
            epic_id = obj.get("id") or path.stem
            approval = obj.get("approval")
            if approval is not None and not _sidecar_has_approval(
                _epic_sidecar_path(planctl_dir, epic_id)
            ):
                print(
                    f"WARN: refusing to strip epic {epic_id}: def approval "
                    f"{approval!r} not yet mirrored in sidecar (run SEED first)",
                    file=sys.stderr,
                )
                continue
            if not dry_run:
                obj.pop("approval")
                _atomic_write_json(path, obj)
            epic_stripped += 1

    if tasks_dir.exists():
        for path in sorted(tasks_dir.glob("*.json")):
            obj = _load_json(path)
            if obj is None or "approval" not in obj:
                continue
            task_id = obj.get("id") or path.stem
            approval = obj.get("approval")
            if approval is not None and not _sidecar_has_approval(
                _task_sidecar_path(planctl_dir, task_id)
            ):
                print(
                    f"WARN: refusing to strip task {task_id}: def approval "
                    f"{approval!r} not yet mirrored in sidecar (run SEED first)",
                    file=sys.stderr,
                )
                continue
            if not dry_run:
                obj.pop("approval")
                _atomic_write_json(path, obj)
            task_stripped += 1

    return (epic_stripped, task_stripped)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--strip",
        action="store_true",
        help="Run the STRIP pass (pop def approval). The irreversible step — "
        "run only after the SEED pass AND a positive end-to-end sidecar-fold "
        "verify.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Mutate nothing; print what the selected pass would do.",
    )
    args = parser.parse_args(argv)

    roots = _list_roots()
    total_e = 0
    total_t = 0
    project_count = 0
    verb = "strip" if args.strip else "seed"
    for root in roots:
        for planctl_dir in sorted(root.glob("*/.planctl")):
            if not planctl_dir.is_dir():
                continue
            if args.strip:
                e, t = _strip_one_project(planctl_dir, args.dry_run)
            else:
                e, t = _seed_one_project(planctl_dir, args.dry_run)
            total_e += e
            total_t += t
            project_count += 1

    prefix = "[dry-run] would " if args.dry_run else ""
    print(
        f"{prefix}{verb} {total_e}/{total_t} epic/task approvals "
        f"across {project_count} projects"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
