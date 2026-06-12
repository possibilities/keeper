# verdict golden corpus — provenance

Each `*.json` here is one VERDICT_INVALID parity row: an `{input, envelope}` pair
where `input` is a verdict crafted to trip exactly one validation rule and
`envelope` is the live Python validator's rejection envelope for it. The set
covers each schema keyword in play (`required`, `additionalProperties`, `type`,
`minLength`, `pattern`) and each cross-field invariant
(`dangling_merge_target`, `culled_task_not_null`, `task_ordinal_required`,
`fatal_reason_required`). `src/verdict_schema.ts`'s `validateVerdict` is held to
reproduce each `envelope` byte-for-byte; the message text is the load-bearing
surface (python-jsonschema's exact wording).

## Status: frozen spec, no reproduction path

These files are now the **spec**, not a derivative. The generator
(`_generate.py`) that produced them imported the Python validator
(`planctl.verdict_schema`) — that module is deleted with the rest of the Python
implementation, so there is no longer a command that regenerates this corpus.
Treat the bytes below as authoritative: a `validateVerdict` change that diverges
from them is a regression in the bun validator, not a stale fixture.

## Capture record

- Capture date: 2026-06-12
- Final re-capture: ran clean against the live Python (zero byte diff), confirming
  the corpus was stable at freeze time.
- Generator command (now retired; recorded for the record):
  `uv run python tests/fixtures/golden/verdict/_generate.py`
- Python: 3.13.9
- jsonschema: 4.26.0

## Pinned hashes (sha256)

```
cd1adf9d723660d7c03ab66c16b9709a55f1a5ea929f1d05b01e80b99910eb63  cross_culled_task_not_null.json
e1ac6b3202b47c2830414b9bb58fe540cc2349b6c8a633368aa707da34256b2e  cross_dangling_merge_target.json
782df342a492fcd697be3a59a17c6da270c405bfcbedfcaa76fc9de4768ec9f0  cross_fatal_reason_required.json
1e3f3fe951c794d38bbbb519a8a54281909b7789bcedd8183d12c836d4cbb4a3  cross_task_ordinal_required.json
b0376d2d2b0f438807634c55c5c67f119d7fef4e1e2dc59b5a9b1c2f59e12d26  schema_additional_properties.json
335db7b8ecf0394a45bccde74c76f272ba28f40b1477afe21f9ba9f51eacfa82  schema_min_length.json
cd83ed00b272e7eb67a25edcd33465887dba6b940de525baa2bf7a1373bd8fdb  schema_pattern.json
5682f43457a89f44667d39db12802d4995cddf26c7a589c7462ce70c5929410e  schema_required.json
d883af38126255d65c77352603d8ac78f6457d97eb6ded9f71d25e9bb70101fe  schema_type.json
```
