## Description

**Size:** M
**Files:** cli/bus.ts, cli/keeper.ts, src/bus-worker.ts, plugins/keeper/skills/bus/SKILL.md, README.md, CLAUDE.md, plugins/plan/template/skills/work.md.tmpl, test/bus-cli.test.ts, test/bus-worker.test.ts, test/bus-worker.integration.test.ts, test/bus-db.test.ts

Remove the `keeper bus chat broadcast` (fan-to-all) capability entirely — CLI
verb, server publish branch, the null-target fan-to-all primitive, and all
advice. Directed `chat send` (+ `queued_for_wake` / `keeper bus wake`) is
UNTOUCHED. No schema change, no SCHEMA_VERSION bump. Land as ONE atomic commit.

### Approach

Work in this order so the typechecker is your completeness net:

1. **Narrow the wire types FIRST.** Change the publish `event` from
   `"send" | "broadcast"` to just `"send"` in `ClientOp.publish.event`
   (src/bus-worker.ts:177), `PublishFrame.event` (cli/bus.ts:241),
   `buildPublishFrame`'s `event` param (cli/bus.ts:252), and `runSend`'s
   `event` param (cli/bus.ts:790-817). Run `bun run typecheck` — every stray
   `"broadcast"` literal is now a `tsc` error, and that error list IS your
   worklist.
2. **CLI strip (cli/bus.ts):** delete the `BusCommand` broadcast arm
   (160-167), the `parseBusArgv` `sub === "broadcast"` arm (212-221) and fix
   the error string at 224 (`(want send|broadcast)` → `(want send)`), the
   `buildPublishFrame` broadcast branch (258-260 — the directed form with `to`
   is all that remains), the `main()` `case "broadcast"` (1106-1116), and the
   broadcast rows/clauses in HELP (11, 17-20, 89) and the
   `PublishResult`/`SendResult` doc-comments (767-781). `runSend`'s remaining
   caller (1091) already passes `"send"`.
3. **Server strip (src/bus-worker.ts):** delete the `// -- broadcast` fanout
   block (1115-1144). Make the directed-send path UNCONDITIONAL — drop the
   `if (event === "send")` guard at 1033 so every publish is treated as a
   directed send (a degenerate `to`-less frame → `resolve("")` →
   `unknown_target` → loud non-delivery, never a silent drop). Do NOT add a
   reject-frame (over-engineering for a single-binary local bus). Prune the
   `PublishOutcome` doc-comment broadcast clauses (265-285).
4. **Tighten the fanout primitive (option A):** in `selectFanoutTargets`
   (210-245) drop the `resolvedChannelId === null ⇒ everyone` branch — narrow
   the param to `string` (non-null) and collapse the `resolvedChannelId !==
   null &&` guard to an unconditional `e.channel.channel_id !==
   resolvedChannelId` skip. PRESERVE the `sock === null` exclusion (233) and
   the sender-exclusion (234) verbatim. Update `fanout`'s signature (672-688)
   `resolvedChannelId: string | null` → `string`; its one remaining call site
   (1103) already passes a non-null id.
5. **Advice strip** (forward-facing only — NO "broadcast was removed"
   tombstones; that history lives in the commit message). Exact edits:
   - plugins/keeper/skills/bus/SKILL.md: frontmatter `description` — drop the
     "fan out with `keeper bus chat broadcast`" clause; DELETE the "To fan a
     message out to everyone" example block (~118-124) and the "Broadcast is
     NOT a delivery fallback" block (~126-132); in the `not_connected` bullet
     (~80-85) drop the "Do NOT fall back to `broadcast`" contrast but KEEP the
     "re-send once the agent is back" rule.
   - CLAUDE.md:47 — `keeper bus chat send`/`broadcast` → `keeper bus chat
     send` (one-word prune; keep the fn-921 `send_only` invariant body).
     AGENTS.md is a symlink to CLAUDE.md — edit CLAUDE.md in place, never
     rm+recreate.
   - cli/keeper.ts:77 — `<list|resolve|chat send|chat broadcast|watch>` →
     `<list|resolve|chat send|watch>`.
   - README.md:3199 — `send/broadcast to each other` → `send to each other`.
     Do NOT touch README.md:2001-2004 (unrelated git-counter "broadcast").
   - plugins/plan/template/skills/work.md.tmpl:187 — remove the "**NEVER retry
     the escalation via `keeper bus chat broadcast`** — broadcast sprays every
     connected agent …" tombstone; keep the forward "a missed directed send
     falls back to surface-and-stop" rule. The generated
     plugins/plan/skills/work/SKILL.md is gitignored — do NOT commit it.
6. **Tests:** see Test notes.

KEEP untouched: `selectQueuedForWake`'s `AND event = 'send'` filter
(src/bus-db.ts:366) and the `messages.event` column write of `'send'` — the
wake path depends on both. `EventEnvelope.event` is hardcoded `"message"`
(1159) — orthogonal, leave alone. Do NOT touch `src/reducer.ts`
"project-broadcast" git-counter fan-out.

### Investigation targets

**Required** (read before coding):
- src/bus-worker.ts:1007-1144 — `opPublish`: the `event` default (1018), the `if (event === "send")` directed path (1033-1113), and the broadcast block to delete (1115-1144).
- src/bus-worker.ts:210-245 — `selectFanoutTargets` (the null branch to remove); 672-688 — `fanout`.
- src/bus-db.ts:359-371 — `selectQueuedForWake`'s `AND event = 'send'` filter (KEEP) and `MessageInput.event: string` (the column stays).
- cli/bus.ts:160-268 — `BusCommand`, `parseBusArgv`, `PublishFrame`, `buildPublishFrame`; 790-817 — `runSend`; 1106-1116 — `main` broadcast case.
- test/bus-worker.integration.test.ts:731-766 (the takeover test to REWRITE), 979-1030 (the existing self-directed-send pattern to model on), and 250-289 (the alice/bob/carol explicit-register pattern for seeding a distinct peer).

**Optional** (reference as needed):
- plugins/plan/test/consistency-skills.test.ts:318-331 — the `--help`-every-extracted-verb guard over work.md.tmpl (why the template edit must keep verbs valid).
- src/commit-work/lint-matrix.ts — the `tsc` + biome arms `keeper commit-work` runs on staged `.ts`.

### Risks

- **Silent-drop hole:** keeping `if (event === "send")` with the broadcast block deleted leaves an implicit empty `else` that silently drops a stray frame. Make the directed path unconditional instead (Approach step 3).
- **Takeover-test coverage loss (fn-921):** test/bus-worker.integration.test.ts:731 used broadcast only as a delivery vehicle to prove a same-`(pid,start_time)`-identity send_only CLI register does NOT evict a live watcher. A self-directed `chat send` delivers to no one (sender excluded by channel_id). The rewrite must seed a DISTINCT explicit peer "bob" (explicit name/session_id/start_time in the register frame — harness-resolution triggers only when NO name is sent), `chat send bob`, and assert BOTH bob receives it AND `harness-live` stays `subscribed:true` in `list`.
- **Namespace-scoping coverage loss:** test/bus-worker.test.ts:124-133 proves tenant scoping via a null broadcast vehicle — rewrite to directed (non-null) targets, do not delete.

### Test notes

- **Two suites are mandatory** — a root-only run leaves the template edit unverified:
  - Root: `bun run test:full` (covers test/bus-cli, test/bus-worker, test/bus-db in the fast tier AND test/bus-worker.integration in the full tier — the integration file is in the fast-tier path-ignore list).
  - Plan plugin: `cd plugins/plan && bun test` (consistency-skills.test.ts `--help`-checks every verb extracted from work.md.tmpl).
- Test edits:
  - test/bus-cli.test.ts: delete the two broadcast parse tests (90-100) and the `buildPublishFrame("broadcast", …)` "broadcast omits to" test (200-203); change the usage-error assertion `send|broadcast` → `send` (107).
  - test/bus-worker.test.ts: delete the broadcast null-target test (113-122); REWRITE the namespace-scoping test (124-133) to directed (non-null) targets; in the disconnected-skip test (166-184) drop the broadcast sub-assertion (177-183), keep the directed half (173-175).
  - test/bus-db.test.ts: in `selectQueuedForWake ignores non-send events` (327-349) change the `event: "broadcast"` fixture to a non-`'send'` sentinel (e.g. `"other"`) — keep the test, it proves the value-filter.
  - test/bus-worker.integration.test.ts: DELETE "broadcast reaches all live subscribers" (250-289) and "CLI broadcast prints a recipient count" (924-934); REWRITE the takeover test (731-766) per Risks; in the harness-`from` test (979-1030) the body already uses a directed `event:"send"` — only fix the stale broadcast-mentioning comment (983-986).
- Commit with `keeper commit-work` once BOTH suites are green. Stage cli/bus.ts, src/bus-worker.ts, and the test files so their tsc/biome arms run. On any non-`lint_failed` failure envelope, surface it verbatim and stop.

## Acceptance

- [ ] `keeper bus chat broadcast …` is rejected as an unknown chat verb (exit 1); `keeper bus`'s HELP and `keeper bus --help` no longer mention broadcast.
- [ ] `keeper bus chat send` / wake / watch / list still work; directed send outcomes (delivered / queued_for_wake / not_connected / unknown_target / ambiguous_target / delivery_failed) are unchanged.
- [ ] No `"broadcast"` literal remains as a publish `event` in cli/ or src/ (tsc passes with the narrowed `"send"`-only union); `selectFanoutTargets` takes a non-null target.
- [ ] `selectQueuedForWake`'s `event = 'send'` filter and the `messages.event` write are unchanged; no schema / SCHEMA_VERSION change.
- [ ] All broadcast advice is gone (bus SKILL.md, CLAUDE.md:47, cli/keeper.ts:77, README.md:3199, work.md.tmpl:187) with NO backward-facing tombstones; surviving directed-send/fallback rules remain.
- [ ] `bun run test:full` (root) AND `cd plugins/plan && bun test` both pass; the rewritten takeover test still proves the fn-921 no-evict invariant.
- [ ] Landed as one `keeper commit-work` commit.

## Done summary

## Evidence
