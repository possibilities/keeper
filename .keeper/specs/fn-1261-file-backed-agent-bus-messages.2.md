## Description

**Size:** M
**Files:** cli/bus.ts, test/bus-cli.test.ts, test/pi-bus-inbox.test.ts

### Approach

Change `keeper bus chat send` to materialize the resolved message body before connecting and publish a typed artifact-reference payload instead of inline content. Keep `send_only:true` and the synchronous outcome contract unchanged. The reference payload includes a legacy-visible `text` instruction naming the canonical artifact path, while structured fields remain authoritative for upgraded consumers.

Change the watcher to validate structured references through the artifact module and emit only sender metadata plus an explicit `read <trusted-path>` instruction. It emits no preview for new references. Legacy inline payloads retain the existing inline/spill consumer path solely for rollout compatibility. Malformed, unsupported, missing, unreadable, or corrupt references produce bounded metadata-only failure notifications and never fall back to displaying reference-shaped content as a legacy body.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/bus.ts:292 — current inline `buildPublishFrame` producer seam.
- cli/bus.ts:845 — synchronous send-only register, publish, and acknowledgment flow.
- cli/bus.ts:949 — current inline-versus-spill notification renderer.
- cli/bus.ts:1134 — watcher frame filtering and delivered-message handoff.
- plugins/keeper/pi-extension/bus-inbox.ts:83 — Pi's bounded watcher-line transport contract.

**Optional** (reference as needed):
- test/bus-cli.test.ts:205 — pure publish-frame and renderer fixtures.
- test/bus-cli.test.ts:400 — JSON-mode physical-record contract consumed by Pi.

### Risks

An acknowledgement timeout is ambiguous: delivery may have occurred, so the artifact must remain for worker retention or orphan GC. Known non-success outcomes may remove the artifact after the truthful ack. An already-running watcher has old rendering code, so the payload's text fallback must itself be a safe explicit read instruction without embedding body content.

### Test notes

Characterize all publish outcomes, stdin and literal bodies, write-before-connect ordering, no-publish-on-write-failure, timeout retention, known-failure cleanup, new reference notifications, old watcher fallback text, legacy inline rendering, malformed-reference failure lines, and Pi's one-record machine framing.

### Detailed phases

1. Replace inline frame construction with artifact publication plus the typed reference payload.
2. Add outcome-aware artifact disposition without weakening synchronous send semantics.
3. Replace new-message preview rendering with validated read-path notifications while preserving legacy inline reads.
4. Update CLI help text and fast fixtures.

### Alternatives

Keeping short messages inline was rejected because behavior would still depend on length. Auto-injecting file contents was rejected because it recreates model-context pressure and removes the receiver's judgment about when to read.

### Non-functional targets

Notifications remain below the existing harness budget and contain no body substring. The sender performs at most one bounded artifact write per send and never joins Presence.

### Rollout

Structured references are self-describing to upgraded watchers. Their `text` fallback is intentionally usable by an already-running legacy watcher; upgraded watchers ignore it in favor of validated structured fields.

## Acceptance

- [ ] `keeper bus chat send` writes the complete artifact before opening the publish round trip and sends no message-body content in the frame or success/error output.
- [ ] The command retains `send_only:true`, truthful synchronous outcomes, stdin support, and existing exit-code behavior.
- [ ] New reference messages render as one bounded `Agent Bus message from <sender> — read <trusted-path>` notification with no preview in both plain and Pi JSON modes.
- [ ] Legacy inline messages remain consumable, while malformed, unsupported, missing, unreadable, or corrupt references emit explicit metadata-only failures without arbitrary path disclosure.
- [ ] Known non-delivery outcomes remove their unconsumed artifact, while timeout and transport ambiguity preserve it for lifecycle cleanup.
- [ ] Fast tests prove that old watcher rendering of the fallback text still gives a usable read instruction without carrying message content.

## Done summary

## Evidence
