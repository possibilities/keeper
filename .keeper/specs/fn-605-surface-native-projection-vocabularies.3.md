## Description

**Size:** S
**Files:** `scripts/board.ts`, `scripts/readiness.ts`, `README.md`

### Approach

Pure renderer simplification — deletes more code than it adds. Three changes:

1. **Render `[runtime_status] [worker_phase] [approval]` on task rows** at `scripts/board.ts:525-527`. Replace the current single-status pill segment with two stamps from the new fields delivered by task `.1`.

2. **Stamp raw `[${seg(inv.status)}]` on subagent lines** at `scripts/board.ts:452`. Delete `subagentPill` function at `scripts/board.ts:237-247`. Use the same `seg(v)` helper the other pills already use.

3. **Delete the `AnnotatedInvocation` machinery and `is_replaced` marking pass** at `scripts/board.ts:388-415` (type declaration + `lastSubagentIndex` typing) and `scripts/board.ts:738-780` (per-frame marking pass). Task `.2` promotes `superseded` into the projection; the renderer no longer needs to derive it client-side. `subagentLinesFor` at `scripts/board.ts:443-456` simplifies to:

```typescript
function subagentLinesFor(jobId: string, indent: string): string[] {
  const hits = lastSubagentIndex?.get(jobId);
  if (hits === undefined || hits.length === 0) return [];
  return hits.map((inv) => {
    const type = inv.subagent_type ?? "subagent";
    const desc = inv.description ?? "";
    const label = desc === "" ? type : `${type}: ${desc}`;
    return `${indent}${label} [${seg(inv.status)}]`;
  });
}
```

No renderer-side filter for `[superseded]` — render the value verbatim for audit-trail visibility (per the Q1 follow-up decision: "if we are hiding [superseded] pills in the UI we should unhide them").

Update the `HELP` string at `scripts/board.ts:116-180` to reflect the new pill shapes (both for the task rows and the subagent lines).

Audit `scripts/readiness.ts` for any reader of `task.status` and rename to `task.worker_phase` to match the new field name from task `.1` (TypeScript will surface every miss).

Update `README.md` lines 258-284 (board.ts client description) to drop the `is_replaced` mention and the `[running]/[stopped]` collapse description; replace with the native-pill rendering.

### Investigation targets

**Required** (read before coding):
- `scripts/board.ts:237-247` — `subagentPill` function (delete)
- `scripts/board.ts:388-415` — `AnnotatedInvocation` type + `lastSubagentIndex` declaration (delete type, retype index as `Map<string, SubagentInvocation[]>`)
- `scripts/board.ts:443-456` — `subagentLinesFor` consumes `is_replaced` (rewrite to native pill stamp)
- `scripts/board.ts:512-538` — `renderEpicBlock`; line 527 is the per-task pill render
- `scripts/board.ts:712-794` — `emitFrameIfChanged`; lines 738-780 are the per-frame `is_replaced` marking pass (delete the entire grouping + marking loop, keep the `subIndex` build + `turn_seq` sort)
- `scripts/board.ts:116-180` — HELP string; refresh to new pill shapes
- `scripts/readiness.ts` — audit all reads of `task.status`; rename to `task.worker_phase`

**Optional** (reference as needed):
- `README.md:258-284` — board.ts client description; remove `is_replaced` and `[running]/[stopped]` mentions

### Risks

- **Renderer simplification race**: delete `AnnotatedInvocation` and `is_replaced` machinery across 4 loci (`board.ts:237-247, 388-415, 443-456, 738-780`) in one commit so the renderer doesn't half-compile.
- **`scripts/readiness.ts` consumer rename**: any reader of `task.status` must be renamed to `task.worker_phase` in the same commit — TypeScript will flag misses once task `.1`'s type rename lands.
- **Visual smoke is part of done**: this is a UI change. Run `bun scripts/board.ts` against a live daemon and verify the pills look right before declaring done.

### Test notes

- If `test/board.test.ts` exists, update assertions for the new pill shapes; otherwise add a smoke test that drives a synthetic snapshot through `renderEpicBlock` and asserts the expected pill strings.
- Visual smoke: `bun scripts/board.ts` against a live daemon; verify a task row shows `[runtime_status] [worker_phase] [approval]` and a subagent row shows the raw enum value (try to catch a `[superseded]` or `[failed]` if any are present in the live state).

## Acceptance

- [ ] `subagentPill` function deleted; `subagentLinesFor` stamps `[${seg(inv.status)}]` directly
- [ ] `AnnotatedInvocation` type and `is_replaced` marking pass deleted from `scripts/board.ts`
- [ ] Task rows render `[runtime_status] [worker_phase] [approval]` (three pills side-by-side)
- [ ] Subagent lines render raw `[running|ok|failed|unknown|superseded]` with NO `[superseded]` filter or hiding
- [ ] `scripts/readiness.ts` consumers of `task.status` renamed to `task.worker_phase`; type-check passes
- [ ] `HELP` string in `scripts/board.ts` reflects the new pill shapes (both task rows and subagent lines)
- [ ] `README.md` board.ts client description (lines 258-284) updated to drop `is_replaced` and `[running]/[stopped]` mentions
- [ ] Visual smoke against a live daemon shows expected pills on at least one task row and one subagent row

## Done summary
Deleted subagentPill + AnnotatedInvocation + is_replaced marking pass. Task rows now render [runtime_status] [worker_phase] [approval] (three native pills); subagent lines stamp the raw 5-value enum verbatim including [superseded]. HELP + README refreshed; readiness.ts already consumed worker_phase from task .1.
## Evidence
