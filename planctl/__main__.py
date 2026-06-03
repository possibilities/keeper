"""Entry point for ``python -m planctl``.

Preserved so subprocess callers can invoke planctl via
``sys.executable -m planctl``, which survives ``uv run``, frozen builds,
and missing ``$PATH`` in the spawned shell — robustly preferable to a
bare ``planctl`` argv[0].
"""

from __future__ import annotations

from planctl.cli import main

if __name__ == "__main__":
    main()
