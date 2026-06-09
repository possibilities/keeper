## Description

Finding F1 from audit of fn-755-babysitter-findings-triage-workflow. The `yq()` helper in `babysitters/agents/performance.md:286` uses shell-eval single-quote escaping:

```
yq() { printf "%s" "$1" | tr -d '\n\r' | sed "s/'/'\\\\''/g"; }
```

This produces shell-style `'\''` output written into a YAML single-quoted scalar (`key: '$fm_key'` at line 299). YAML single-quoted scalars escape `'` by doubling it (`''`), not shell-eval style. A key containing `'` would produce malformed YAML frontmatter; the fallback to the Evidence-fence path prevents data loss but the escaping is objectively wrong.

Evidence path: `babysitters/agents/performance.md:286`, `yq()` function.

## Acceptance

- [ ] `sed "s/'/'\\\\''/g"` changed to `sed "s/'/''/g"` in the `yq()` function at performance.md:286
- [ ] Spot-check: a synthetic key `foo'bar` through `yq()` yields `foo''bar`, producing valid YAML when embedded in `key: '$fm_key'`

## Done summary
Changed yq() sed expr from shell-eval s/'/'\\''/g to YAML s/'/''/g in babysitters/agents/performance.md and updated the prose; spot-check confirms foo'bar -> foo''bar yields valid YAML.
## Evidence
