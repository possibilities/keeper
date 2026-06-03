"""Shared bundle-ref validation regex (fn-513).

A bundle ref names a curated context source in the runtime-snippet-substrate.
Three namespaces dispatch: ``bundle/<name>`` (promptctl bundle),
``arc/<slug>/<id>`` (arcctl item), ``sketch/<name>`` (sketch).

The pattern is deliberately strict — it is a path-traversal guard.  The ref
flows into shell calls (``promptctl show-bundle <ref>``, ``render-spec``) at
the router/inheritor tier, so it must reject ``arc/foo/../etc`` and any
segment that is not lowercase kebab-case before interpolation.

Accepts:  bundle/dev-env  ·  arc/snippeting/main  ·  sketch/runtime-substrate
Rejects:  arc/foo/../etc  ·  Bundle/Dev  ·  bundle/  ·  arc/a/b/c
"""

from __future__ import annotations

import re

BUNDLE_REF_RE = re.compile(r"^(bundle|arc|sketch)/[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)?$")

# Kebab-case snippet id: lowercase alnum segments joined by single dashes.
# No namespace prefix (unlike bundle refs) — snippet ids are flat.  Existence
# is NOT checked here; phantom ids surface as warnings at
# ``promptctl render-spec`` time per the Epic 1 runtime-substrate design.
SNIPPET_ID_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
