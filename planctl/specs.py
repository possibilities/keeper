"""Markdown section patching for planctl specs."""

from __future__ import annotations

import re


def get_task_section(content: str, section: str) -> str:
    """Extract content of a ## section from markdown."""
    lines = content.split("\n")
    in_target = False
    collected = []
    for line in lines:
        if line.startswith("## "):
            if line.strip() == section:
                in_target = True
                continue
            if in_target:
                break
        if in_target:
            collected.append(line)
    return "\n".join(collected).strip()


def patch_task_section(content: str, section: str, new_content: str) -> str:
    """Replace content of a ## section, keeping all other sections intact."""
    # Check for duplicate headings
    pattern = rf"^{re.escape(section)}\s*$"
    matches = len(re.findall(pattern, content, flags=re.MULTILINE))
    if matches > 1:
        raise ValueError(
            f"Cannot patch: duplicate heading '{section}' found ({matches} times)"
        )

    # Strip leading section heading from new_content if present
    new_lines = new_content.lstrip().split("\n")
    if new_lines and new_lines[0].strip() == section:
        new_content = "\n".join(new_lines[1:]).lstrip()

    lines = content.split("\n")
    result = []
    in_target_section = False
    section_found = False

    for line in lines:
        if line.startswith("## "):
            if line.strip() == section:
                in_target_section = True
                section_found = True
                result.append(line)
                result.append(new_content.rstrip())
                continue
            else:
                in_target_section = False

        if not in_target_section:
            result.append(line)

    if not section_found:
        raise ValueError(f"Section '{section}' not found in task spec")

    return "\n".join(result)


def create_task_spec_skeleton(acceptance: str | None = None) -> str:
    """Generate the four-section task spec skeleton."""
    acc_content = f"\n{acceptance}\n" if acceptance else ""
    return (
        f"## Description\n"
        f"\n"
        f"## Acceptance\n"
        f"{acc_content}\n"
        f"## Done summary\n"
        f"\n"
        f"## Evidence\n"
    )


def validate_task_spec_headings(content: str) -> list[str]:
    """Validate task spec has required headings exactly once. Returns errors."""
    from planctl.models import TASK_SPEC_HEADINGS

    errors = []
    for heading in TASK_SPEC_HEADINGS:
        pattern = rf"^{re.escape(heading)}\s*$"
        count = len(re.findall(pattern, content, flags=re.MULTILINE))
        if count == 0:
            errors.append(f"Missing required heading: {heading}")
        elif count > 1:
            errors.append(f"Duplicate heading: {heading} (found {count} times)")
    return errors


def ensure_valid_task_spec(content: str) -> None:
    """Raise ValueError when task spec headings are invalid."""
    errors = validate_task_spec_headings(content)
    if errors:
        raise ValueError("; ".join(errors))
