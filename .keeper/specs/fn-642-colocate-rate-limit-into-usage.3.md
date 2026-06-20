## Description

**Size:** M
**Files:** ~/code/agentuse/daemon.py, ~/code/agentuse/pyproject.toml

### Approach

Replace the hardcoded `ACCOUNTS` list literal (daemon.py:50-81) with runtime
construction from an XDG config. Load `~/.config/agentuse/config.yaml`
(honor `XDG_CONFIG_HOME` first, else `~/.config`) — a pure list of claude
profile names (e.g. a top-level `profiles:` YAML list). Use `yaml.safe_load`
(never `yaml.load`); a missing or malformed file logs to stderr and degrades
to an empty list (daemon runs codex-only rather than crashing). For each
configured name, build an `Account`: `target="claude"`, `passthrough=
["--arthack-profile", name]`, `id=name`, and `multiplier` derived from
`~/.claude-profiles/<name>/.claude.json` → `oauthAccount.organizationRateLimitTier`
via the mapping `{default_claude_ai: 1, default_claude_max_5x: 5,
default_claude_max_20x: 20}`. Read the tier with `.get()` chains and a
size cap before `json.load` (mirror the usage-worker's MAX-bytes guard);
a missing/malformed `.claude.json` or an unknown tier string logs to
stderr and falls back to multiplier 1. Append the fixed codex `Account`
(`id="codex"`, `target="codex"`, `passthrough=[]`, multiplier 1) in code —
NOT in the config. Keep the unique-id assert. Add `pyyaml` to pyproject
dependencies and update `uv.lock`.

**Deploy step (human-run, NOT automated):** create
`~/.config/agentuse/config.yaml` listing the four current profile names,
then bounce the daemon: `launchctl kickstart -k gui/501/arthack.agentuse.daemon`.

### Investigation targets

**Required** (read before coding):
- ~/code/agentuse/daemon.py:37-41 — `Account` TypedDict
- ~/code/agentuse/daemon.py:50-81 — `ACCOUNTS` registry being replaced
- ~/code/agentuse/daemon.py:46-49 — the documented tier→multiplier mapping
- ~/code/agentuse/pyproject.toml — deps (add pyyaml)

**Optional** (reference as needed):
- ~/code/keeper/src/usage-worker.ts — MAX-bytes file-size guard pattern to mirror
- ~/.claude-profiles/<name>/.claude.json — `oauthAccount.organizationRateLimitTier` shape

### Risks

- `pyyaml` is a new dependency — uv.lock must update.
- Tier mapping drift if Anthropic introduces a new tier string — fall back to 1x + log, don't crash.
- The derived multiplier still flows into keeper unchanged (it's written into the agentuse state-file payload, which keeper folds) — verify the wire value matches the verified per-profile multipliers.

### Test notes

agentuse has no test suite. Verify by dry-run: load a config with the four
names and print the constructed `ACCOUNTS`, asserting multipliers default=5,
multi-claude-1=1, multi-claude-2=1, multi-claude-3=20 (the live-verified
values). Then exercise the degrade paths: absent config file, malformed YAML,
a name whose `.claude.json` lacks the tier — each must not crash.

## Acceptance

- [ ] `config.yaml` name-list drives `ACCOUNTS`; codex is appended in code, not in the config
- [ ] each multiplier is derived from the profile's `organizationRateLimitTier` and matches the verified values (default=5, multi-claude-1=1, multi-claude-2=1, multi-claude-3=20)
- [ ] missing/malformed config, missing `.claude.json`, and unknown tier all degrade gracefully (stderr log, safe default, no crash)
- [ ] `pyyaml` added to pyproject + uv.lock; daemon starts clean under the LaunchAgent after a bounce

## Done summary
agentuse daemon ACCOUNTS now built at runtime from XDG ~/.config/agentuse/config.yaml (profile name list); each multiplier derived from ~/.claude-profiles/<name>/.claude.json organizationRateLimitTier via {default_claude_ai:1, default_claude_max_5x:5, default_claude_max_20x:20}; codex appended in code. Missing/malformed config, missing .claude.json, and unknown tiers all degrade to safe defaults with stderr logs. pyyaml added to pyproject + uv.lock. Verified live: default=5, multi-claude-1=1, multi-claude-2=1, multi-claude-3=20.
## Evidence
