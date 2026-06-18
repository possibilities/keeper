## Description

Closes audit finding F3 (Test Gaps). The session-marker contract spans
two languages: `planctl/session_markers.py::_write_marker` writes the
record, and `plugin/hooks/lib.ts` (the `readMarker` path) plus the three
guard dispatchers read the same files. Each side currently tests its own
read/write against a hand-rolled JSON fixture matching the other's shape
(verified byte-identical today), so the contract holds by convention, not
by a mechanical round-trip. The docstrings call this a cross-language
contract whose silent drift "breaks the dispatchers silently" — yet no
test catches that drift.

Add a single end-to-end round-trip test: drive the Python success path
(e.g. a `claim`) to write a real marker, then read it back through the
actual TS dispatcher reader via a true bun subprocess (the existing
slow-bucket subprocess harness in `tests/test_generated_guard_hook.py`
is the natural home). Assert the task identity survives the crossing.
The test must fail if a field name or `kind` value diverges between
`_write_marker` and the TS reader.

## Acceptance

- [ ] A marker written by the Python success path is read back through the
      real TS dispatcher (true bun subprocess), and the parsed task
      identity matches what was written.
- [ ] The test fails on a field-name / `kind` divergence between
      `_write_marker` and the TS reader (verify by a local rename probe).
- [ ] Lands in the slow bucket; `uv run pytest tests/ --run-slow` green.

## Done summary
Added a slow-bucket end-to-end round-trip test: write_work_marker (Python success path) writes a marker, read back through the real TS readMarker via a bun subprocess, asserting kind/task_id survive. Fails on any field-name or kind divergence between _write_marker and the TS reader (verified via a local rename probe).
## Evidence
