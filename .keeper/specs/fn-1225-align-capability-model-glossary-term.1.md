## Description

Finding F1 (auditor, CONTEXT.md:36). The Capability model glossary entry
reads "...a bare capability token the host provider roster resolves at run
time...". The sibling cluster entries all use the canonical term "host
matrix config": Provider ("A harness's entry in the host matrix config"),
Pecking order ("The provider list order in the host matrix config"), and
Wrapper driver ("set in the host matrix config"). Replace the coined
"host provider roster" with the cluster's canonical wording so the entry
is consistent, without introducing any further synonym or disturbing the
definition or its Avoid line.

Files:
- CONTEXT.md (the Capability model glossary entry)

## Acceptance

- [ ] The Capability model entry no longer uses "host provider roster";
      it names the artifact with the cluster's canonical term.
- [ ] The entry keeps a precise definition, its native-vs-wrapped rule,
      and its Avoid line; no other entry is touched.
- [ ] bun scripts/lint-claude-md.ts stays green.

## Done summary
Replaced 'host provider roster' with the cluster's canonical 'host matrix config' in the Capability model glossary entry (CONTEXT.md:36), matching Provider/Pecking order/Wrapper driver. No other wording, definition, or Avoid-line text touched.
## Evidence
