"""Planctl-owned subprocess helper for `promptctl inline-sketch-refs` (fn-628).

Replaces the prior ``from promptctl.api import inline_sketch_refs,
SketchResolutionError`` coupling on planctl's 4 write paths (``scaffold``,
``refine-apply``, ``epic set-bundles``, ``task set-bundles``). Calls the
promptctl CLI verb as a literal ``["promptctl", ...]`` subprocess — the
exact pattern ``run_claim._render_snippet_context`` already uses for
``promptctl render-spec`` — so planctl carries zero in-repo Python
dependency on any arthack package and stays extraction-ready.

Two distinct error modes (fail-visibly, no fallback):

* :class:`SketchRefError` — a single sketch ref failed to resolve. Carries
  ``ref`` + ``reason`` (two-attr contract identical to the old
  ``SketchResolutionError`` so callers' existing ``ref_invalid`` error
  envelopes stay byte-identical).
* :class:`SketchToolingError` — the verb itself failed to run (OSError on
  spawn, non-zero exit, timeout, non-JSON stdout). Carries an optional
  ``stderr`` excerpt for the diagnostic envelope. Callers should fail the
  whole step rather than fall back; this is a tooling outage, not a ref bug.

The helper returns a per-slot result list (each slot is either a
``(remaining_bundles, merged_snippets)`` tuple or a :class:`SketchRefError`)
so each caller can apply its own discipline:

* Collect-all sites (``scaffold``, ``refine-apply``) accumulate per-slot
  ref errors into a single ``ref_invalid`` envelope.
* Fail-fast sites (``epic set-bundles``, ``task set-bundles``) raise the
  first ref-error slot directly into ``emit_error``.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

# Subprocess wall-clock guard. The verb is a pure-Python YAML/snippet
# read; a real run should land in tens of milliseconds. A 30s ceiling is
# generous and exists to surface a hung promptctl process as a tooling
# failure instead of stranding the planctl verb.
_SUBPROCESS_TIMEOUT_SECONDS = 30.0


class SketchRefError(Exception):
    """A single ``sketch/<name>`` ref failed to resolve.

    Two-attr contract — ``ref`` + ``reason`` — identical to the legacy
    ``promptctl.api.SketchResolutionError`` so callers' existing
    ``ref_invalid`` envelopes (``f"sketch ref {exc.ref!r} {exc.reason}"``)
    keep producing byte-identical strings.
    """

    def __init__(self, ref: str, reason: str) -> None:
        super().__init__(f"sketch ref {ref!r} could not be resolved: {reason}")
        self.ref = ref
        self.reason = reason


class SketchToolingError(Exception):
    """``promptctl inline-sketch-refs`` itself failed to run.

    Distinct from :class:`SketchRefError` — a ref-level failure surfaces
    as an inline error slot in the verb's stdout array. This exception is
    raised only when the subprocess itself misbehaved (spawn OSError,
    non-zero exit, timeout, non-JSON stdout). Callers fail the whole step
    visibly; there is no fallback.
    """

    def __init__(self, message: str, *, stderr: str | None = None) -> None:
        super().__init__(message)
        self.stderr = stderr or ""


# Per-slot result. Either a successful ``(remaining_bundles, merged_snippets)``
# tuple OR a :class:`SketchRefError` carrying the ref-resolution failure for
# that input slot. The two-shape contract lets each caller apply its own
# discipline (collect-all vs fail-fast) over the same return value.
@dataclass(frozen=True)
class _OkSlot:
    remaining_bundles: list[str]
    merged_snippets: list[str]


SketchResolveSlot = _OkSlot | SketchRefError


def _dedup_first_seen(snippets: list[str]) -> list[str]:
    """First-occurrence-order dedup, matching promptctl's ``_push`` semantics.

    ``promptctl inline-sketch-refs`` builds ``merged_snippets`` by pushing each
    input snippet through a first-seen-wins filter (``api.inline_sketch_refs``).
    The sketch-free short-circuit below replicates that exact transform locally.
    """
    seen: set[str] = set()
    out: list[str] = []
    for sid in snippets:
        if sid not in seen:
            seen.add(sid)
            out.append(sid)
    return out


def inline_sketch_refs_batch(
    groups: list[dict[str, list[str]]],
    *,
    project_root: Path,
) -> list[SketchResolveSlot]:
    """Shell ``promptctl inline-sketch-refs`` for a batch of groups.

    ``groups`` is a list of ``{"bundles": [...], "snippets": [...]}`` dicts;
    the verb returns a list of matching slots in input order. ``project_root``
    is passed explicitly to the verb via ``--project-root`` AND used as the
    subprocess cwd, so resolution always anchors on the authoring project
    even when planctl runs from a subdir or sibling repo (the fn-608
    anchor trap).

    Returns a per-slot list of :class:`_OkSlot` or :class:`SketchRefError`.
    Raises :class:`SketchToolingError` when the verb itself fails (spawn,
    timeout, non-zero exit, or non-JSON stdout) — fail-visibly, no fallback.

    Sketch-free fast path: ``promptctl inline-sketch-refs`` only acts on
    ``sketch/`` refs — ``bundle/`` / ``arc/`` refs and bare ids pass through
    unchanged, and the sole transform on a sketch-free group is a first-seen
    dedup of its ``snippets`` (``promptctl.api.inline_sketch_refs``). So when
    NO group in the batch carries a ``sketch/`` ref, the subprocess is a pure
    no-op pass-through: we replicate it locally and skip the ~240ms interpreter
    spawn entirely. Any ``sketch/`` ref anywhere in the batch falls through to
    the real verb so resolution stays single-sourced in promptctl.
    """
    if not any(
        any(ref.startswith("sketch/") for ref in group.get("bundles", []))
        for group in groups
    ):
        return [
            _OkSlot(
                remaining_bundles=list(group.get("bundles", [])),
                merged_snippets=_dedup_first_seen(list(group.get("snippets", []))),
            )
            for group in groups
        ]

    payload = json.dumps(groups)
    cwd = str(project_root)
    argv = ["promptctl", "inline-sketch-refs", "--project-root", cwd]

    try:
        proc = subprocess.run(
            argv,
            input=payload,
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
            timeout=_SUBPROCESS_TIMEOUT_SECONDS,
        )
    except OSError as exc:
        raise SketchToolingError(
            f"failed to spawn `promptctl inline-sketch-refs`: {exc}"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise SketchToolingError(
            f"`promptctl inline-sketch-refs` exceeded {_SUBPROCESS_TIMEOUT_SECONDS}s timeout",
            stderr=(exc.stderr or "") if isinstance(exc.stderr, str) else "",
        ) from exc

    if proc.returncode != 0:
        raise SketchToolingError(
            f"`promptctl inline-sketch-refs` exited {proc.returncode}",
            stderr=(proc.stderr or "").strip(),
        )

    try:
        decoded = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise SketchToolingError(
            f"`promptctl inline-sketch-refs` returned non-JSON stdout: {exc}",
            stderr=(proc.stderr or "").strip(),
        ) from exc

    if not isinstance(decoded, list):
        raise SketchToolingError(
            f"`promptctl inline-sketch-refs` stdout must be a JSON array, "
            f"got {type(decoded).__name__}",
            stderr=(proc.stderr or "").strip(),
        )
    if len(decoded) != len(groups):
        raise SketchToolingError(
            f"`promptctl inline-sketch-refs` returned {len(decoded)} slots for "
            f"{len(groups)} input groups",
            stderr=(proc.stderr or "").strip(),
        )

    results: list[SketchResolveSlot] = []
    for i, slot in enumerate(decoded):
        if not isinstance(slot, dict):
            raise SketchToolingError(
                f"slot {i}: expected a JSON object, got {type(slot).__name__}",
                stderr=(proc.stderr or "").strip(),
            )
        if "error" in slot:
            # Per-slot ref-resolution failure. The verb's error envelope is
            # ``{"error": "ref_invalid", "ref": "...", "reason": "..."}``.
            ref_val = slot.get("ref")
            reason_val = slot.get("reason")
            if not isinstance(ref_val, str) or not isinstance(reason_val, str):
                raise SketchToolingError(
                    f"slot {i}: malformed error envelope: {slot!r}",
                    stderr=(proc.stderr or "").strip(),
                )
            results.append(SketchRefError(ref_val, reason_val))
            continue
        remaining = slot.get("remaining_bundles")
        merged = slot.get("merged_snippets")
        if not isinstance(remaining, list) or not isinstance(merged, list):
            raise SketchToolingError(
                f"slot {i}: success envelope missing remaining_bundles / "
                f"merged_snippets list fields: {slot!r}",
                stderr=(proc.stderr or "").strip(),
            )
        results.append(
            _OkSlot(
                remaining_bundles=[str(b) for b in remaining],
                merged_snippets=[str(s) for s in merged],
            )
        )

    return results
