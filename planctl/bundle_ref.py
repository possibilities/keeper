"""Shared bundle-ref validation regex (fn-513).

A bundle ref names a curated context source in the runtime-snippet-substrate.
Two namespaces dispatch: ``bundle/<name>`` (promptctl bundle) and
``sketch/<name>`` (sketch).

The pattern is deliberately strict — it is a path-traversal guard.  The ref
flows into shell calls (``promptctl show-bundle <ref>``, ``render-spec``) at
the router/inheritor tier, so it must reject ``bundle/foo/../etc`` and any
segment that is not lowercase kebab-case before interpolation.

Accepts:  bundle/dev-env  ·  bundle/snippeting-main  ·  sketch/runtime-substrate
Rejects:  bundle/foo/../etc  ·  Bundle/Dev  ·  bundle/  ·  bundle/a/b/c  ·  ftp/x
"""

from __future__ import annotations

import re

BUNDLE_REF_RE = re.compile(r"^(bundle|sketch)/[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)?$")

# Kebab-case snippet id: lowercase alnum segments joined by single dashes.
# No namespace prefix (unlike bundle refs) — snippet ids are flat.  Existence
# is NOT checked here; phantom ids surface as warnings at
# ``promptctl render-spec`` time per the Epic 1 runtime-substrate design.
SNIPPET_ID_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
