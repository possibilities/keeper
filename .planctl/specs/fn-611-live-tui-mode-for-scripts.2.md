## Description

**Size:** M
**Files:** src/live-shell.ts (new), test/live-shell.test.ts (new)

### Approach

Build `createLiveShell(opts)` factory that owns all TUI side-effects
so the three scripts can plug in at their existing emit seams with a
minimal API. No top-level side effects in the module — everything
happens at factory-call time, so `bun test --isolate` can import it
cleanly.

Public surface (illustrative — refine in implementation):

```ts
export interface LiveShellOptions {
  enabled: boolean;                      // false → returns a no-op shell
  stdout?: NodeJS.WritableStream;        // injection for tests
  stdin?: NodeJS.ReadableStream;
  historyCap?: number;                   // default 500
}

export interface LiveShell {
  pushFrame(lines: string[]): void;      // called once per script emit
  dispose(): void;                       // sync, idempotent
}

export function createLiveShell(opts: LiveShellOptions): LiveShell;
```

Internal state and behavior:

- **TTY gate:** `enabled = opts.enabled && stdout.isTTY && stdin.isTTY`. If false, the returned shell's `pushFrame` writes `lines.join("\n") + "\n"` to stdout (no ANSI, no key handling); `dispose()` is a no-op. This satisfies the "non-TTY behaves as if `--live` was not set" contract.
- **Lifecycle on enable:**
  1. Save `wasRaw = stdin.isRaw ?? false`.
  2. Write `\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l` (enter alt, clear, hide cursor).
  3. `stdin.setRawMode(true)`; `stdin.resume()`; `stdin.setEncoding("utf8")`; attach `data` listener.
  4. Attach `process.stdout.on('resize', ...)` debounced ~100ms → full re-render of the currently-viewed frame at new dimensions.
  5. Register `process.on('exit', dispose)` + `process.on('uncaughtException', ...)` + `process.on('unhandledRejection', ...)` safety-nets.
- **`pushFrame(lines)`:**
  - Append a copy to `history: string[][]` (ring-buffer capped at `historyCap`, default 500; oldest drops on overflow).
  - If `viewIdx === "live"`, render this frame (per-line diff against `prevLines`).
  - If scrolled back, do NOT render — just update the banner row to show new total `M`.
- **Per-line differ:** walk row indices (offset by 1 — row 0 reserved for banner). For each row where `next[i] !== prev[i]`, append `\x1b[<row>;1H\x1b[2K<line>` to a buffer. For rows past `next.length` that existed in `prev`, append clear-line. Wrap the whole buffer in `\x1b[?2026h` … `\x1b[?2026l` (DEC 2026 sync). One `stdout.write` per frame. Update `prevLines = next`.
- **Banner row (row 1, 1-indexed):** blank line when live; `frame N of M — press G to return to live` when scrolled back. Rendered as part of the diff so it doesn't get out of sync.
- **Key parser (StdinBuffer style):** buffer bytes; classify CSI (`\x1b[`…ends 0x40–0x7E), SS3 (`\x1bO` + 1 byte), bare ESC flushes after ~10ms idle. Keymap:
  - `\x1b[A` (↑), `\x1b[D` (←), `h`, `k` → `viewIdx = max(0, viewIdx - 1)` (or `len-2` if was `"live"`).
  - `\x1b[B` (↓), `\x1b[C` (→), `j`, `l` → forward; landing past tip snaps to `"live"`.
  - `g` → `viewIdx = 0`.
  - `G`, `\x1b[F` (End), bare `\x1b` (Esc) → `viewIdx = "live"`, render current tip.
  - `q`, `\x03` (Ctrl-C) → `dispose()` then `process.exit(0)`.
  - Anything else: ignore.
- **`dispose()` (sync, idempotent):**
  1. Guard with a `disposed` flag — second call is a no-op.
  2. Detach `data` listener, `stdin.pause()`, `stdin.setRawMode(wasRaw)`.
  3. Detach resize listener; clear any pending resize-debounce timer.
  4. Write `\x1b[?25h\x1b[?1049l\x1b[0m` (show cursor, leave alt-screen, reset SGR).
  5. Detach the `exit` / `uncaughtException` / `unhandledRejection` handlers we attached.

### Investigation targets

**Required** (read before coding):
- `src/readiness-client.ts` — module-shape reference (named factory, JSDoc density, dependency-injection seams for tests).
- `scripts/board.ts:531-602` — the existing sidecar/diff machinery for context on what's already line-oriented in the renderer; the live-shell does NOT touch sidecars but the script-side will keep emitting them.
- `test/board.test.ts` — fixture builder + mock-socket injection pattern; replicate the spirit for `test/live-shell.test.ts` (fake stdin reader, fake stdout sink, frame builder).
- `package.json:19-22` — confirm no TUI deps; this is hand-rolled against raw ANSI.

**Optional** (reference as needed):
- `scripts/autopilot.ts:285-292`, `scripts/git.ts:152-156` — sidecar path constants for context.

### Risks

- **Bun compiled-binary `stdout.columns` stale bug** — if keeper ever ships these scripts as compiled binaries, `stdout.columns/rows` may stick at startup values. Fall back to `stdout.getWindowSize()` and finally `stty size </dev/tty` per practice-scout. Today the scripts always run as `bun scripts/<name>.ts` — document the limitation and don't gold-plate.
- **Async dispose temptation** — resist any async work in `dispose()`. `process.on('exit')` cannot await. If a buffer flush or socket close needs awaiting, that's the script's `handle.dispose()` job, not the live-shell's.
- **Re-entrant dispose paths** — `dispose()` may be called from SIGINT handler, `process.on('exit')`, and explicit script-side call all in the same tick. Idempotency guard is mandatory.
- **Embedded ANSI in renderer output** — `board.ts` lines may already carry SGR codes. Diff is a byte compare (`next[i] !== prev[i]`) — fine; identical-visible-but-different-SGR lines re-paint, that's correct.
- **Lines containing `\n`** — the contract is "one element per row." A bare `\n` inside a line element would desync the diff state. The factory does not split; the caller's contract is one row per element. Document this.

### Test notes

- Inject `stdin` and `stdout` via `opts` so tests use a `PassThrough` for stdin and a sink stream that captures writes.
- Tests to cover:
  - Cold start: `pushFrame(["line1","line2"])` produces an enter-alt sequence + a full paint (first frame has no prev → every line emits).
  - Steady-state diff: second `pushFrame` with one line changed emits only that row's diff sequence; unchanged rows produce no bytes.
  - Resize: simulate `process.stdout.emit('resize')` → debounced → next pushFrame produces a full re-render.
  - Scroll-back: cold-start with N frames, then write `\x1b[D` (left arrow) to fake stdin → banner updates, `viewIdx` decrements, no auto-snap.
  - New frames during scroll-back append to history silently (banner count updates) without re-rendering.
  - `G` returns to live and emits a full re-render of the current tip.
  - `q` triggers dispose; assert teardown sequence in the sink (`\x1b[?25h\x1b[?1049l`).
  - `dispose()` called twice is a no-op (second call writes nothing).
  - Non-TTY path: `enabled: false` returns a shell whose `pushFrame` writes plain joined text and `dispose()` writes nothing.
  - Partial-read key parser: feed `\x1b` alone → no key fires for ~10ms → bare Esc → "return to live".
  - Feed `\x1b[` then later `A` in two stdin chunks → resolves to ↑ exactly once.
  - SIGWINCH does NOT clear frame history; scroll-back still works after a fake resize.
  - Disconnect lifecycle event (simulated via the test harness) does NOT clear frame history — only the script-side `lastBody` clears.

## Acceptance

- [ ] `src/live-shell.ts` exports `createLiveShell` and the `LiveShell` / `LiveShellOptions` types.
- [ ] No top-level side effects on `process.stdin` or `process.stdout`; all state owned by the factory return value.
- [ ] `dispose()` is synchronous, idempotent, and registered on `exit` / `uncaughtException` / `unhandledRejection`.
- [ ] Non-TTY path: `enabled: false` (or auto-detected via `isTTY`) produces a shell that writes `lines.join("\n") + "\n"` and never touches raw mode.
- [ ] Per-line ANSI diff wrapped in DEC 2026 sync; one `stdout.write` per frame.
- [ ] Keymap implemented: `←/h/k`, `→/l/j`, `g`, `G`/`End`/`Esc`, `q`/`Ctrl-C`.
- [ ] `test/live-shell.test.ts` covers every case listed in `### Test notes`; `bun test test/live-shell.test.ts` passes.
- [ ] `bun run lint && bun run typecheck` pass.

## Done summary

## Evidence
