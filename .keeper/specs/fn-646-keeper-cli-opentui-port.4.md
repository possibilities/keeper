## Description

**Size:** M
**Files:** cli/board.ts (moved from scripts/board.ts), src/ansi-to-styled.ts (new shim), test/board.test.ts, test/ansi-to-styled.test.ts (new), cli/keeper.ts

Cut `keeper board` over, and build the one piece of genuinely new
logic in the epic: an ANSI→StyledText shim. Board is the only TUI that
embeds raw SGR codes in body strings; OpenTUI renders embedded ANSI as
literal garbage, so those segments must be parsed into OpenTUI styling.

### Approach

1. **`src/ansi-to-styled.ts`**: parse a body line containing the 6 SGR
   open codes board emits — `\x1b[96m` (bright-cyan / active),
   `\x1b[32m` (green / success), `\x1b[31m` (red / error), `\x1b[33m`
   (yellow / warn), `\x1b[2;37m` (dim-white / faded), `\x1b[0m`
   (reset) — into an OpenTUI `StyledText` (`t`-template chunks with
   `fg(hex)` / `TextAttributes.DIM`). Map each SGR to its hex/attr.
   Unrecognized escapes must NOT pass through as visible bytes —
   strip or render plain. The shell calls this shim for any caller
   line containing ANSI; plain lines pass through untouched.
2. **Cut over `keeper board`**: move `scripts/board.ts`→`cli/board.ts`,
   `main`→`main(argv)`, neutralize the guard, wire the dispatcher,
   preserve SIGINT order + sidecars (sidecars stay UNcolored — only
   `pushFrame` lines hit the shim). Reconcile the `colorEnabled =
   isTTY && NO_COLOR==null` gate: under the OpenTUI alt-screen branch
   color is on; the non-TTY plain path emits uncolored lines (no shim).
3. Update `test/board.test.ts` import path; `colorizePillsInLine`,
   `projectRows`, the dep-pill/job-link render fns stay exported.

Note the `fn-643` overlap: tasks `.4`/`.5` of that epic touch
`scripts/board.ts` (board warn-count + replay keypress). Sequence after
it or port its keypress/warn-count logic into the new subcommand.

### Investigation targets

**Required** (read before coding):
- scripts/board.ts:553-560 — the `SGR` const (the 6 codes)
- scripts/board.ts:625-671 — `colorizePillsInLine` (the only ANSI injection site)
- scripts/board.ts:774 — the `colorEnabled` gate
- src/live-shell.ts (post-`.2`) — where the shell invokes styling; how StyledText reaches `TextRenderable.content`
- knowctl topic `opentui` — Text `t`-template / `fg` / `TextAttributes` API

**Optional:**
- scripts/board.ts:1283-1312 — the `c` copy `onKey` handler (forwarded via `onUnhandledKey`)

### Risks

- Garbage-render failure mode: any unhandled escape that slips through shows as literal bytes. Test the shim against each of the 6 codes + mixed/nested segments + a bare reset.
- `fn-643` file overlap on `scripts/board.ts` — coordinate ordering.

### Test notes

`test/ansi-to-styled.test.ts`: each SGR code → expected StyledText
chunk; nested/adjacent segments; reset handling; a line with no ANSI
passes through. Manually diff `keeper board` colors against
`bun scripts/board.ts`.

## Acceptance

- [ ] `src/ansi-to-styled.ts` converts all 6 board SGR codes to OpenTUI StyledText; no escape renders as literal bytes; plain lines pass through.
- [ ] `keeper board` renders UI-identical to `bun scripts/board.ts`, colors included; sidecars stay uncolored; non-TTY path uncolored.
- [ ] `cli/board.ts` wired into the dispatcher; SIGINT order + sidecars preserved; `test/board.test.ts` + shim tests green.

## Done summary
Moved scripts/board.ts to cli/board.ts under the dispatcher's main(argv) signature; added src/ansi-to-styled.ts to parse the six SGR escape sequences board emits into OpenTUI StyledText chunks at paint time; wired the shim through src/live-shell.ts's paint layer via linesToContent (plain-rows fast path, StyledText only when any line carries \x1b).
## Evidence
