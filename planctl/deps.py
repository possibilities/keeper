"""Dependency graph operations."""

from __future__ import annotations


def has_cycle(graph: dict, task_id: str, visited: set, rec_stack: set) -> list[str]:
    """DFS cycle detection. Returns cycle path or empty list."""
    visited.add(task_id)
    rec_stack.add(task_id)

    for dep in graph.get(task_id, {}).get("depends_on", []):
        if dep not in visited:
            cycle = has_cycle(graph, dep, visited, rec_stack)
            if cycle:
                return [task_id] + cycle
        elif dep in rec_stack:
            return [task_id, dep]

    rec_stack.remove(task_id)
    return []


def detect_cycles(graph: dict) -> list[str] | None:
    """Run has_cycle from each unvisited node. Returns cycle path or None."""
    visited: set[str] = set()
    for task_id in graph:
        if task_id not in visited:
            cycle = has_cycle(graph, task_id, visited, set())
            if cycle:
                return cycle
    return None


def find_dependents(task_id: str, all_tasks: dict) -> list[str]:
    """All tasks that directly or transitively depend on task_id."""
    dependents: set[str] = set()
    to_check = [task_id]
    checked: set[str] = set()

    while to_check:
        checking = to_check.pop(0)
        if checking in checked:
            continue
        checked.add(checking)

        for tid, tdata in all_tasks.items():
            if tid in checked or tid in dependents:
                continue
            deps = tdata.get("depends_on", [])
            if checking in deps:
                dependents.add(tid)
                to_check.append(tid)

    return list(dependents)


def validate_dependency(
    task_id: str, dep_id: str, epic_id: str, existing_tasks: set
) -> str | None:
    """Validate a dependency. Returns error message or None."""
    from planctl.ids import epic_id_from_task, is_task_id

    if not is_task_id(dep_id):
        return f"Invalid task ID format: {dep_id}"

    if task_id == dep_id:
        return f"Task cannot depend on itself: {dep_id}"

    try:
        dep_epic = epic_id_from_task(dep_id)
    except ValueError:
        return f"Invalid dependency ID: {dep_id}"

    if dep_epic != epic_id:
        return f"Dependency {dep_id} is in a different epic ({dep_epic}), must be in {epic_id}"

    if dep_id not in existing_tasks:
        return f"Dependency {dep_id} does not exist"

    return None
