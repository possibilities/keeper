## Description

**Size:** S
**Files:** tests/test_gist.py (new), tests/fixtures/golden/ additions

### Approach

Close the two coverage gaps before porting. tests/test_gist.py: first-ever gist coverage — PATH-shim fake gh (executable temp script recording argv and env, controlled exit codes and stdout URL), pinning the success envelope {gist_url, epic_id, file_count, public}, the --no-open/--public flags, the gh-failure error path, and the file set passed to gh; engine-agnostic via run_cli with the shim on PATH; mark wire or slow-bucket per the stub-contract convention (a fake-binary test belongs with its kin). Verdict goldens: capture from the real Python binary the exact VERDICT_INVALID envelopes for one failure of each schema keyword in play (missing required, additionalProperties, wrong type, minLength, pattern miss) plus each cross-field violation — these {loc,type,msg} rows incl. message text are the parity table the hand-rolled validator targets. Prove everything green against Python in both engines.

### Investigation targets

**Required** (read before coding):
- planctl/run_gist.py — the envelope and gh interaction being pinned
- tests/test_generated_guard_hook.py:38-58 — the PATH-shim fake-binary pattern to copy
- planctl/verdict_schema.py:44-260 — the schema and error-row construction

**Optional** (reference as needed):
- tests/test_verdict_submit.py — what msg-string assertions already exist (complement, don't duplicate)

### Risks

webbrowser.open in gist must be neutralized in tests (--no-open) or the suite pops browsers; ensure every test passes the flag.

### Test notes

Green three ways: default engine, PLANCTL_BIN=python planctl, fast gate unchanged.

## Acceptance

- [ ] test_gist.py lands with the gh shim, green against Python both engines
- [ ] Verdict golden corpus covers every schema keyword + cross-field rule with exact Python message text

## Done summary

## Evidence
