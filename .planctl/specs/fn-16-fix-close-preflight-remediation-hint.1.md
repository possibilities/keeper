## Description

From finding F1 (evidence: `planctl/submit_common.py:173`). The `BRIEF_MISSING`
error message's second segment is a plain string literal, so the remediation
hint renders the literal token `{epic_id}` rather than the actual epic id:

```python
(
    f"no audit brief for {epic_id} at {bp}; "
    "run `planctl close-preflight {epic_id}` first"   # not an f-string
)
```

Prefix the second literal with `f` so the hint names the epic. Add or extend a
test asserting the `BRIEF_MISSING` message contains the real epic id and no
literal `{epic_id}` brace token.

## Acceptance

- [ ] `planctl/submit_common.py:173` second segment is an f-string; the hint renders the actual epic id.
- [ ] A test pins that the `BRIEF_MISSING` message carries no literal `{epic_id}` token.

## Done summary

## Evidence
