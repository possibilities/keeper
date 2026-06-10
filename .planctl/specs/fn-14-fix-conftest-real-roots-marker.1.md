## Description

Finding F1 (audit of fn-11-fast-default-test-gate): `tests/conftest.py:749` in the
`_isolated_roots_default` fixture docstring reads:

> "Opt out with `@pytest.mark.real_roots` (slow bucket) when a test drives..."

`real_roots` is NOT in `_SLOW_BUCKET_MARKERS` (`conftest.py:93-99`). It is a
fast-path marker — documented at line 76 as "opt out of the autouse empty-discovery
isolation." A developer reading the docstring to understand which bucket `real_roots`
tests fall into would learn the wrong thing.

Fix: change `(slow bucket)` to `(fast-path marker)` at line 749.

## Acceptance

- [ ] `conftest.py:749` reads `(fast-path marker)` not `(slow bucket)`
- [ ] Verify no other instances of `real_roots` in conftest carry the slow-bucket label

## Done summary
Fixed _isolated_roots_default docstring at conftest.py to label @pytest.mark.real_roots as a fast-path marker instead of slow bucket; real_roots is absent from _SLOW_BUCKET_MARKERS and is the autouse empty-discovery isolation opt-out.
## Evidence
