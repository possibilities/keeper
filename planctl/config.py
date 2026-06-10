"""planctl config loader — the narrow ``roots:`` surface.

``~/.config/planctl/config.yaml`` carries a single key, ``roots:``
(a list of parent directories planctl scans for sibling planctl projects).
Only ``roots:`` lives here; there is no broader config surface.

Absent file → default ``roots: [~/code]``. Each root is ``expanduser``'d and
``resolve``'d to an absolute path. Malformed YAML / wrong-typed ``roots:`` falls
back to the default rather than hard-breaking — discovery and global epic
numbering must degrade soft, never crash ``epic create``.
"""

from __future__ import annotations

from pathlib import Path

# The single narrow config file. ``XDG_CONFIG_HOME`` is intentionally NOT
# consulted — planctl config lives at the conventional ``~/.config/planctl/``
# path verbatim.
CONFIG_PATH = Path("~/.config/planctl/config.yaml").expanduser()

# Default roots when the config file is absent or unusable.
_DEFAULT_ROOTS = ["~/code"]


def _normalize_roots(raw_roots: list) -> list[Path]:
    """Expanduser + resolve each entry; drop non-string / empty entries."""
    out: list[Path] = []
    for entry in raw_roots:
        if not isinstance(entry, str) or not entry.strip():
            continue
        out.append(Path(entry).expanduser().resolve())
    return out


def load_roots(config_path: Path | None = None) -> list[Path]:
    """Return the configured ``roots`` as resolved absolute :class:`Path`s.

    Resolution order:
      - File absent → default ``[~/code]``.
      - File present but unreadable / malformed YAML / ``roots`` missing or not
        a list → default ``[~/code]`` (fail-soft).
      - File present with a valid ``roots`` list → each entry expanded/resolved;
        non-string / empty entries dropped. An empty resulting list falls back
        to the default so callers always get at least one root.
    """
    path = config_path if config_path is not None else CONFIG_PATH

    raw_roots: list | None = None
    if path.exists():
        try:
            import yaml

            data = yaml.safe_load(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                candidate = data.get("roots")
                if isinstance(candidate, list):
                    raw_roots = candidate
        except Exception:
            # Malformed YAML / read error → fall through to default.
            raw_roots = None

    if raw_roots is None:
        raw_roots = list(_DEFAULT_ROOTS)

    resolved = _normalize_roots(raw_roots)
    if not resolved:
        resolved = _normalize_roots(_DEFAULT_ROOTS)
    return resolved
