"""fn-502 regression: every checked-in epic JSON must be clean of ``audited_into``.

The dead ``audited_into`` key was a forward pointer from a closed epic
into its follow-up. It was retired in fn-502 in favor of an explicit
follow-up argument on the audit-commit path (the seam-based ``commit-plan
after-audit`` verb was itself later deleted in fn-587 when per-verb
auto-commit landed). ``normalize_epic`` now pops the key defensively on
every load — this test guards against the field re-entering the tracked
tree via a manual edit or a stale tool that still writes the key.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

# arthack root: <repo>/.planctl/epics/*.json
# Walk up from this test file: tests/ -> apps/planctl/ -> apps/ -> <repo>
_REPO_ROOT = Path(__file__).resolve().parents[3]
_EPICS_DIR = _REPO_ROOT / ".planctl" / "epics"


def _epic_paths() -> list[Path]:
    return sorted(_EPICS_DIR.glob("*.json"))


@pytest.mark.parametrize("path", _epic_paths(), ids=lambda p: p.name)
def test_epic_file_has_no_audited_into_field(path: Path) -> None:
    with path.open(encoding="utf-8") as f:
        obj = json.load(f)
    assert "audited_into" not in obj, (
        f"{path.name} still carries the retired 'audited_into' key"
    )
