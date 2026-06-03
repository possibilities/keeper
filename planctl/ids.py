"""ID parsing, slug generation, and scan-based allocation."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path

ID_REGEX = re.compile(
    r"^fn-(\d+)(?:-[a-z0-9][a-z0-9-]*[a-z0-9]|-[a-z0-9]{1,3})?(?:\.(\d+))?$"
)

# Job IDs are UUIDs: 8-4-4-4-12 hex digits separated by hyphens.
# Locked to this exact shape to avoid ambiguous string matches.
JOB_ID_REGEX = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


def is_job_id(s: str) -> bool:
    """Check if a string is a UUID-shaped job id."""
    return bool(JOB_ID_REGEX.match(s))


def slugify(text: str, max_length: int = 40) -> str | None:
    """Convert text to URL-safe slug for epic IDs.

    Returns None if result is empty (triggers random suffix fallback).
    """
    import unicodedata

    text = str(text)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text.lower())
    text = text.replace("_", " ")
    text = re.sub(r"[-\s]+", "-", text).strip("-")
    if max_length and len(text) > max_length:
        truncated = text[:max_length]
        if "-" in truncated:
            truncated = truncated.rsplit("-", 1)[0]
        text = truncated.strip("-")
    return text if text else None


def generate_suffix(length: int = 3) -> str:
    """Random [a-z0-9] string via secrets.choice."""
    import secrets
    import string

    chars = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(length))


def parse_id(id_str: str) -> tuple[int | None, int | None]:
    """Parse ID into (epic_num, task_num).

    Returns (epic, None) for epic IDs, (epic, task) for task IDs,
    (None, None) if invalid.
    """
    match = ID_REGEX.match(id_str)
    if not match:
        return None, None
    epic = int(match.group(1))
    task = int(match.group(2)) if match.group(2) else None
    return epic, task


def is_epic_id(s: str) -> bool:
    """Check if ID is an epic ID."""
    epic, task = parse_id(s)
    return epic is not None and task is None


def is_task_id(s: str) -> bool:
    """Check if ID is a task ID."""
    epic, task = parse_id(s)
    return epic is not None and task is not None


def epic_id_from_task(task_id: str) -> str:
    """Extract epic ID from task ID by splitting on last dot."""
    epic, task = parse_id(task_id)
    if epic is None or task is None:
        raise ValueError(f"Invalid task ID: {task_id}")
    return task_id.rsplit(".", 1)[0]


def scan_max_epic_id(data_dir) -> int:
    """Scan epics/*.json and specs/fn-*.md to find max epic number."""
    max_n = 0
    pattern = r"^fn-(\d+)(?:-[a-z0-9][a-z0-9-]*[a-z0-9]|-[a-z0-9]{1,3})?\.(json|md)$"

    epics_dir = data_dir / "epics"
    if epics_dir.exists():
        for epic_file in epics_dir.glob("fn-*.json"):
            match = re.match(pattern, epic_file.name)
            if match:
                n = int(match.group(1))
                max_n = max(max_n, n)

    specs_dir = data_dir / "specs"
    if specs_dir.exists():
        for spec_file in specs_dir.glob("fn-*.md"):
            match = re.match(pattern, spec_file.name)
            if match:
                n = int(match.group(1))
                max_n = max(max_n, n)

    return max_n


def scan_epic_ids_global(project_paths) -> dict[str, Path]:
    """Map every existing epic id across all discovered projects to its owner.

    Walks each project's ``.planctl/epics/*.json`` and ``.planctl/specs/fn-*.md``
    and returns ``{<bare_epic_id>: <project_path>}``. The bare id is the filename
    without extension (``fn-12-add-queue-skill``). Used as a global-name
    uniqueness check at allocation time so two projects can never mint the same
    full epic id, even though per-project numbering is independent.

    A project whose ``.planctl/`` is missing contributes nothing — fail-soft,
    no error. When the same id appears in multiple projects (should be
    impossible post-fix, but possible in legacy state), the last-walked project
    wins; the value is used only for human-readable error messages.
    """
    from pathlib import Path

    owners: dict[str, Path] = {}
    pattern = r"^(fn-\d+(?:-[a-z0-9][a-z0-9-]*[a-z0-9]|-[a-z0-9]{1,3})?)\.(json|md)$"
    for project_path in project_paths:
        data_dir = Path(project_path) / ".planctl"
        for sub in ("epics", "specs"):
            sub_dir = data_dir / sub
            if not sub_dir.exists():
                continue
            for entry in sub_dir.glob("fn-*"):
                match = re.match(pattern, entry.name)
                if match:
                    owners[match.group(1)] = Path(project_path)
    return owners


def scan_max_task_id(data_dir, epic_id: str) -> int:
    """Scan tasks/ to find max task number for an epic."""
    tasks_dir = data_dir / "tasks"
    if not tasks_dir.exists():
        return 0

    max_m = 0
    for task_file in tasks_dir.glob(f"{epic_id}.*.json"):
        match = re.match(rf"^{re.escape(epic_id)}\.(\d+)\.json$", task_file.name)
        if match:
            m = int(match.group(1))
            max_m = max(max_m, m)
    return max_m
