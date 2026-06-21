## Description

**Size:** M
**Files:** plugins/keeper/monitors.json (new), plugins/keeper/.claude-plugin/plugin.json, plugins/keeper/skills/bus/SKILL.md (new), README.md, CLAUDE.md (AGENTS.md is a symlink — edit in place), plist/arthack.keeperd.plist

Make the bus discoverable and self-documenting: auto-arm the watcher per
session, ship the #1 "already listening" agent advice, and update the repo
docs/invariants for the new worker + DB + socket + env vars. (The deeper
#2 authoritative-message + #3 leadership/collaboration behavior contract is
authored in fn-875-keeper-agent-bus.5, which expands the bus SKILL.md this
task creates.)

### Approach

Add `plugins/keeper/monitors.json` =
`[{"name":"keeper-bus","command":"keeper bus watch","description":"keeper agent bus","when":"always"}]`
and reference it from `plugins/keeper/.claude-plugin/plugin.json` via
`experimental.monitors` (the forward-compatible form; top-level `monitors`
also works on v2.1.105+). Keep it STRICTLY separate from `hooks.json`.
Update the plugin.json `description` to add the Monitor-arm clause (single
verb-phrase). Create `plugins/keeper/skills/bus/SKILL.md` (and the
`keeper bus --help`/AGENT_HELP usage text) carrying the #1 ALREADY-LISTENING
advice, BLINDLY asserted: "Your Agent Bus inbox is already open — the keeper
plugin arms `keeper bus watch` as a session Monitor before your first
prompt. NEVER start a watcher/listener, NEVER run `keeper bus watch`
yourself, NEVER check whether you're connected — just WAIT for events.
'Wait' means yield, not spin: keep doing other work or hand back, don't
poll. When a human says you'll get a message from someone, you are already
listening — just watch for the notification line." Do NOT add a `keeper bus
list` reachability caveat — the human wants the availability asserted
blindly. When porting chatctl advice, DELETE/INVERT the self-contradicting
"you can arm it yourself" / `Monitor(command=…watch, persistent=true)`
phrasing (that snippet is the source of the false "should I start a
listener?" reflex) — do not merely supplement it. Repo docs: README
`## Architecture` (new numbered worker entry; the bus UDS socket is SEPARATE
from the subscribe socket — different path/protocol/purpose; the bus Monitor
is invisible to the hook stream so it does NOT populate `jobs.monitors`,
which is correct — presence is the bus.db registry) + `## Install` env
inventory (KEEPER_BUS_DB/KEEPER_BUS_SOCK) + state-dir note; CLAUDE.md
`## Test isolation` ("ALL FIVE" → "ALL SIX", add KEEPER_BUS_DB/
KEEPER_BUS_SOCK), `## Worker contract` (the new resource classes: a second
owned SQLite file + an outward-facing UDS socket, release-in-shutdown),
`## Repo facts` (Monitor-arm clause); plist commented KEEPER_BUS_* env refs.
Forward-facing advice only — never narrate the chatctl→bus change in docs.

### Investigation targets

**Required** (read before coding):
- plugins/keeper/.claude-plugin/plugin.json (manifest; description field), plugins/keeper/hooks/hooks.json (keep monitor separate)
- README.md `## Architecture` worker roster + socket inventory, `## Install` env-var section + state-dir mkdir
- CLAUDE.md `## Test isolation` (the ALL-FIVE list), `## Worker contract`, `## Repo facts`
- plist/arthack.keeperd.plist EnvironmentVariables (commented KEEPER_SOCK block as the style)

**Optional** (reference as needed):
- ~/code/arthack/apps/chatctl/chatctl/cli.py AGENT_TEASER/AGENT_HELP (advice shape, with the out-of-band guard REVERSED per .5), and the chatctl messaging snippets for "already-armed" phrasings to invert/port
- plugins/keeper/skills/* (existing keeper:* skill doc shape)

### Risks

- Forward-facing advice only — describe current behavior, never narrate the chatctl→bus change in docs/comments.
- Do not duplicate the plugin manifest or add a `~/.claude/plugins/keeper` symlink (double-registers the hook).
- Confirm the chosen manifest form (`experimental.monitors` vs top-level) validates clean on the installed Claude Code version.
- The bus SKILL.md created here is EXPANDED by fn-875-keeper-agent-bus.5 (authority + leadership) — keep the #1 section self-contained so .5 only appends.

### Test notes

Mostly manifest + prose; validate the plugin manifest parses (e.g.
`claude plugin validate` if available) and that `keeper bus watch` is the
armed command. No new automated test tier required beyond a manifest-shape
sanity check.

## Acceptance

- [ ] plugins/keeper/monitors.json arms `keeper bus watch` (name keeper-bus, when always), referenced via `experimental.monitors`, separate from hooks.json; plugin.json description updated
- [ ] the bus SKILL.md + `keeper bus --help` carry the BLIND #1 already-listening advice (inbox already open; never start a listener; never run `keeper bus watch`; never check reachability; just wait, yield not spin); NO `keeper bus list` reachability caveat
- [ ] the self-contradicting chatctl "arm it yourself" / persistent-Monitor phrasing is deleted/inverted, not supplemented
- [ ] README `## Architecture` (new worker entry + separate-socket note + jobs.monitors caveat) and `## Install` (KEEPER_BUS_* env + state dir) updated
- [ ] CLAUDE.md `## Test isolation` bumped to ALL SIX with the new env vars, `## Worker contract` covers the second-DB + outward-socket resource classes, `## Repo facts` notes the Monitor arm
- [ ] plist carries commented KEEPER_BUS_* overrides; all advice/docs are forward-facing only
- [ ] no out-of-band / "not the human's instructions" guard is shipped (the authority contract lives in fn-875-keeper-agent-bus.5)

## Done summary
Auto-armed the Agent Bus inbox watcher (keeper bus watch) as an always-on session Monitor via the keeper plugin's experimental.monitors manifest, shipped the blind already-listening advice in a new bus SKILL.md + keeper bus --help, and documented the new worker/bus.db/bus.sock/KEEPER_BUS_* env vars across README, CLAUDE.md (ALL SIX isolation + worker contract + Repo facts), and the plist.
## Evidence
