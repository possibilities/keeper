## Description

**Size:** S
**Files:** `src/transcript-worker.ts`, `test/transcript-worker.test.ts`

### Approach

Add the `matchAskUserQuestion()` parser, the new `InputRequestMessage`
worker→main type, and a third branch in `dispatchLine()`. Worker `main()`
gets a fourth callback (`onInputRequest`) wired to a `port.postMessage`
that the daemon (already extended in task .1) consumes. No boot-scan
path — `InputRequest` is forward-tail-only, mirroring `RateLimited`
exactly (the `[awaiting:*]` pill signals a live state; replaying it
from a historical transcript scan would show stale blocks).

Wire shape:

1. **`InputRequestMessage`**: `{ kind: "input-request"; sessionId:
   string; requestKind: InputRequestKind }`. The `requestKind` field is
   the future-extension seam — only `"ask_user_question"` ships now,
   but the message format already carries the discriminator so a
   future `ExitPlanMode` matcher slots in without a new message kind.
   Update the `parentPort.onmessage` union type in `daemon.ts` (this
   task — task .1 wired the inserter without changing the type union).
2. **`matchAskUserQuestion(parsed)`**: returns
   `{ sessionId, requestKind: "ask_user_question" } | null`. Strict
   gates:
   - `parsed.type === "assistant"`
   - `parsed.sessionId` is a non-empty string
   - `parsed.message.content` is an array, and at least one element
     satisfies `{type:"tool_use", name:"AskUserQuestion"}`
   **Iterate** `message.content[]`; don't index `content[0]` (rate-
   limit reads `content[0]` because synthetics carry a single text
   block; real assistant turns interleave text + N tool_uses).
3. **`dispatchLine()` extension**: add a third branch alongside the
   existing `isTitle` / `isRateLimit` pre-filters. The new needle is
   `'"name":"AskUserQuestion"'` — tighter than the request's draft
   `'"AskUserQuestion"'` because the bare token could appear in
   `custom-title` text or a rate-limit error message verbatim; gating
   on the `"name":` prefix anchors it to the `tool_use` schema's
   `name` field. The three needles MUST be empirically disjoint —
   the test suite includes a corpus assertion.
4. **Worker `main()` callback**: append the fourth callback in
   constructor param order (existing convention: "new callbacks tack
   onto the end"). Worker posts `InputRequestMessage` to main.
5. **No change-gate** — the forward-only tail reads each line at most
   once; the reducer fold is idempotent; mirrors rate-limit's
   no-change-gate rationale verbatim.

### Investigation targets

**Required** (read before coding):
- `src/transcript-worker.ts:91-95` — `RateLimitedMessage` interface
  shape.
- `src/transcript-worker.ts:150-207` — `matchRateLimit()` parser
  structure (strict gating, field-by-field, returns object or null).
- `src/transcript-worker.ts:556-598` — `dispatchLine()` pre-filter +
  parse + match dispatch wiring. Carefully preserve the disjoint-needle
  contract.
- `src/transcript-worker.ts:262-269` — constructor callback convention
  (param order, new callbacks at the end).
- `src/transcript-worker.ts:688-706` — `main()` callback wiring.
- `src/daemon.ts:272` — `transcriptWorker.onmessage` type union — extend
  to include `InputRequestMessage`.

**Optional** (reference as needed):
- A real captured `AskUserQuestion` line at line 54 of
  `/Users/mike/.claude/projects/-Users-mike-code-jobsearch/22c690a6-045b-4072-9f3e-5abc12283c61.jsonl`
  — use as the positive-fixture in tests.

### Risks

- **Pre-filter disjointness**: a fn-616-landed line whose error envelope
  contains the literal word `"AskUserQuestion"` (e.g. in a `prompt_too_long`
  rendering of the prior turn) would false-positive. The `"name":`
  anchor mitigates; the test suite must include a negative-fixture
  with the bare word.
- **Content-array iteration**: dropping into `content[0]` (rate-limit's
  pattern) silently under-matches; a fuzz-test with mixed text +
  tool_use content blocks catches this.

### Test notes

- Positive: a real `tool_use:AskUserQuestion` line emits exactly one
  `InputRequestMessage`.
- Negative: assistant turn with other tool_use (Bash, Read) — no emit;
  assistant turn with no tool_use — no emit; rate-limit synthetic —
  no emit; `custom-title` line — no emit; malformed JSON — skip-and-log,
  no throw.
- Multi-content: assistant turn with text + AskUserQuestion tool_use
  + other tool_use emits exactly one (the AskUserQuestion one).
- Disjointness corpus: assert the three needles never co-fire on the
  same parsed line.

## Acceptance

- [ ] `matchAskUserQuestion()` parser implemented with strict gates
      and content-array iteration.
- [ ] `dispatchLine()` extended with `"name":"AskUserQuestion"` pre-filter.
- [ ] `InputRequestMessage` exported; daemon's `onmessage` type union
      extended.
- [ ] Worker `main()` posts `InputRequestMessage` via fourth callback.
- [ ] `bun test` passes; matcher tests cover positive / negative /
      multi-content / malformed / disjointness corpus.
- [ ] No boot-scan path added (mirror RateLimited's forward-tail-only
      shape).

## Done summary
Added matchAskUserQuestion() parser, fourth onInputRequest callback on TranscriptLineStream, third dispatchLine pre-filter needle ('"name":"AskUserQuestion"' — empirically disjoint from the existing two), and worker main() wiring that posts InputRequestMessage. No boot-scan path — forward-tail-only, mirroring RateLimited/ApiError. Tests cover positive (real captured shape), multi-content (text + AUQ + other tool_use, regression gate for iterate-not-index), negatives (other tool_use only, text only, rate-limit cross-fire, custom-title cross-fire, user turn with tool_result, missing sessionId, non-array content), malformed-skip, perf-gate, and a disjointness corpus.
## Evidence
