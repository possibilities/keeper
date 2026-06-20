## Description

**Size:** S
**Files:** skills/keeper-await/SKILL.md (at plugin root, NOT under .claude-plugin/)

### Approach

Author `skills/keeper-await/SKILL.md` that turns a natural-language request
("do a full review when fn-643-…-hook.4 is complete", "wait until fn-X is
unblocked then …") into a `Monitor(keeper await …)` invocation plus the
follow-up action.

Frontmatter: `name: keeper-await` (matches dir), a `description` (≤1024
chars) that states WHAT + WHEN and covers pushy/user-intent phrasings
("wait for", "block until", "when X is done", "after fn-N finishes",
including cases where the user doesn't say "keeper"/"epic"). `allowed-tools:
Monitor Bash`. No `disable-model-invocation` (we want auto-trigger).

Body (keep < 500 lines / 5000 tokens):
- Parse the target id (epic vs task by `.N`), the condition
  (`complete` default, `unblocked` when the ask is about readiness), and
  the follow-up action.
- **Pre-check** the id is on-board before wiring Monitor (a quick
  `keeper`/board lookup). If it's off-board (already completed/popped-off)
  or nonexistent, tell the agent it CANNOT be awaited — the event already
  happened or never will — instead of wiring a doomed Monitor that just
  returns `failed reason=not-found`.
- Wire `Monitor({ command: "keeper await <condition> <id>", description: …,
  persistent: true })` — default `persistent: true` for open-ended
  "whenever it finishes" (completions can take hours); a bounded "within
  the hour" uses `timeout_ms`; omit `keeper await --timeout` and let Monitor
  own the deadline.
- On the terminal `[keeper-await] met …` line, run the follow-up. Carry the
  already-complete-while-on-board ⇒ fires-immediately behavior.

### Investigation targets

**Required** (read before coding):
- The `keeper await` grammar, event-line shapes, and exit codes from task .2 (the contract this skill emits against).
- An existing SKILL.md in the repo or plugin for frontmatter/style reference once task .3 establishes `skills/`.

**Optional** (reference as needed):
- Monitor tool semantics (stdout = event channel; SIGTERM at timeout; persistent vs timeout_ms).

### Risks

- Description quality is the sole trigger — a generic one won't fire. Cover
  intent phrasings, not implementation detail.
- The skill must not wire a doomed Monitor for off-board targets — the
  pre-check is load-bearing for good agent UX.

### Test notes

No automated test; validate by reading the skill back and confirming the
Monitor wiring matches task .2's grammar exactly (command string, exit-code
handling, persistent default).

## Acceptance

- [ ] `skills/keeper-await/SKILL.md` exists at plugin root with valid frontmatter (`name` matches dir, WHAT+WHEN description covering pushy phrasings, `allowed-tools: Monitor Bash`).
- [ ] Body parses target/condition/follow-up, pre-checks on-board (advises when off-board/nonexistent), wires `Monitor(keeper await …)` with `persistent: true` default, acts on the terminal `met` line.
- [ ] The emitted command string matches task .2's grammar and exit-code contract; skill resolves as `/keeper:keeper-await`.

## Done summary
Authored skills/keeper-await/SKILL.md at plugin root: frontmatter with auto-trigger description (849 chars) covering wait-then-act phrasings without requiring 'keeper'/'epic'/'task', allowed-tools Monitor+Bash, body parses target/condition/follow-up, pre-checks on-board via planctl show (refusing off-board), wires Monitor(keeper await <cond> <id>) with persistent:true default, and acts on the terminal [keeper-await] met line. Emitted command + exit-code contract matches task .2 exactly.
## Evidence
