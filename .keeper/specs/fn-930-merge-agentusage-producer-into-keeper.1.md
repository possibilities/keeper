## Description

**Size:** M
**Files:** ~/code/agentusage/scrape_cli.py (new — or `agentusage/scrape_cli.py` module), scrape.py, parse_claude_usage.py, parse_codex_status.py, scrape_one.py, daemon.py (strip orchestration), pyproject.toml / uv.lock (pin pexpect+pyte), tests/

### Approach

Redesign agentusage's Python surface from a long-lived daemon into a STATELESS
ONE-SHOT scrape CLI invoked once per account. New entry (reshape `scrape_one.py`):
argv `--target <claude|codex> --profile <name> [--command <path>] [--rows N --cols M]`
→ does exactly one scrape → prints ONE discriminated JSON object on stdout, writes
NO state files. Contract (integer `schema_version`):
`{schema_version, status:"ok", usage:{…}, subscription_active}` |
`{schema_version, status:"ok", no_subscription:true}` (the `NoActiveSubscription`
success arm) | `{schema_version, status:"error", error_type, message, screen_excerpt}`.
stdout = that one object ONLY; ALL diagnostics/tracebacks → stderr; exit non-zero on
the error arm, 0 on either ok arm; `sys.stdout.flush()` before exit. KEEP `scrape.py`
(`pexpect`+`pyte`) and both parsers, but HARDEN scrape teardown per the gotchas:
`preexec_fn=os.setsid` on the `pexpect.spawn` + `os.killpg(os.getpgid(child.pid),
SIGKILL)` in a `finally`/signal handler so the grandchild `claude`/`codex` TUI never
survives a parent kill; pin `dimensions` + `TERM=xterm-256color`/`LINES`/`COLUMNS`;
keep the sentinel+settle render-complete under the existing `SCRAPE_TIMEOUT_S`; `pyte`
NOT `strict=True`. Strip `daemon.py`'s orchestration (the loop/scheduler/envelope
writer/idle-gate/tier-resolution all move to the keeper worker) — keep only what the
one-shot needs. Pin `pexpect` + `pyte` in `pyproject.toml` + `uv.lock` so the worker's
`uv run --project` resolves a reproducible env. Tier/multiplier resolution + envelope
assembly do NOT belong here (they move to TS) — the util is scrape+parse ONLY.

### Investigation targets

**Required** (read before coding):
- ~/code/agentusage/scrape.py:221 `scrape()`, :119-159 trust mutations, :21 PTY dims, the sentinel/settle loop — the scrape mechanics to keep + harden
- ~/code/agentusage/scrape_one.py — the debug one-shot to reshape into the contract CLI
- ~/code/agentusage/parse_claude_usage.py:47 `NO_SUB_SENTINEL`, :57-64 regexes, :187-219 `lift_at` (NOTE: `lift_at` derivation may STAY here and round-trip through the JSON, OR move to TS — keep it returning enough for TS to derive); parse_codex_status.py:22-28 regexes
- ~/code/agentusage/daemon.py:45 `ENVELOPE_SCHEMA_VERSION`, :416-430 `ENVELOPE_KEYS`, :433-465 envelope builder — to know exactly which fields the util must surface vs which TS assembles
- ~/code/agentusage/pyproject.toml + uv.lock — confirm pexpect/pyte are pinned

### Risks

- The grandchild TUI leak: a bare `child.terminate()` signals only the python child, not the `claude`/`codex` PTY — `setsid`+`killpg` is mandatory or every kill leaks a TUI.
- Contract drift: `NoActiveSubscription` is a SUCCESS (exit 0, `no_subscription:true`), NOT an error — getting the exit-code-to-arm mapping wrong corrupts the worker's branch logic.
- Do NOT let the util write any state — it is stateless; the worker owns all writes.

### Test notes

Keep/adapt the existing pytest suite (parser tests against captured panel fixtures;
scrape helper tests). Add a test asserting the discriminated JSON contract shape +
exit codes for each arm. The real-TUI scrape test stays opt-in (the existing `live`
marker). Do NOT spawn a real TUI in the default pytest run.

## Acceptance

- [ ] `<uv> run --project ~/code/agentusage python -m agentusage.scrape_cli --target claude --profile <p>` prints exactly one JSON object on stdout (ok / no_subscription / error arm), diagnostics on stderr, correct exit code, flushed
- [ ] `scrape.py` installs `setsid` + `killpg`-on-teardown so no `claude`/`codex` TUI survives a parent kill; dims + `TERM`/`LINES`/`COLUMNS` pinned
- [ ] the util writes NO state files; `daemon.py`'s orchestration is removed (or the file retired) with parsers + scrape kept
- [ ] `pexpect` + `pyte` pinned in `uv.lock`; the parser pytest suite passes
- [ ] the JSON contract carries an integer `schema_version` and a documented arm taxonomy

## Done summary

## Evidence
