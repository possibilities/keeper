## Description

**Size:** M
**Files:** src/dash/app.ts, src/dash/exit-triggers.ts, cli/dash.ts, cli/keeper.ts, package.json, test/dash-app.test.ts, test/keeper-cli.test.ts, README.md

### Approach

The thin materializer + process shell. `cli/dash.ts` exports
`main(argv)` (import.meta.main neutralized — cli/keeper.ts is the entry):
parseArgs (--sock, --help), resolveSockPath, then the TTY gate —
`process.stdout.isTTY !== true` → `keeper dash: requires a TTY` on
stderr, exit 1, BEFORE any `await import("@opentui/core")`. `src/dash/app.ts`
dynamic-imports OpenTUI (live-shell.ts:331 precedent; module import stays
inert), creates the renderer with the proven config (exitOnCtrlC:false,
exitSignals SIGTERM/SIGHUP/SIGQUIT, autoFocus:false, alternate-screen),
builds the static tree ONCE (root Box column 100%/100%; header Text fixed
height; body ScrollBox flexGrow:1, viewportCulling:true, .focus() on
mount so j/k/arrows scroll natively), and runs reactive mode — no
renderer.start(). Three subscriptions (subscribeReadiness +
subscribeCollection autopilot_state + armed_epics) feed one current-inputs
struct; each edge rebuilds the view-model (task .1) and diffs segments
into a stable Map<rowKey, TextRenderable> via setContent — structural
add/remove only when the row set changes. onLifecycle drives the
connection state (pre-paint waiting line; post-paint header marker with
body frozen at last-good). One 30s setInterval refreshes elapsed cells
only. Teardown discipline: a single idempotent exitCleanly (dispose subs,
clear interval, renderer.destroy(), exit) reached from q/Ctrl-C (keyInput
keypress), the forked exit triggers, an onFatal override, and
uncaughtException/unhandledRejection handlers — destroy ALWAYS precedes
exit. Fork armViewerExitTriggers into src/dash/exit-triggers.ts verbatim
(preserve the .unref?.() on the ppid poll). Wire the subcommand:
SUBCOMMANDS + USAGE in cli/keeper.ts (restructure the "five viewer
subcommands auto-detect a non-TTY stdout" sentence — dash is TTY-only;
don't imply snapshot support), handler in the lazy-import map; update
README "Example clients" (enumeration, the five-viewer TTY-gate
paragraph, a dash.ts bullet).

### Investigation targets

**Required** (read before coding):
- src/live-shell.ts:331-346 — dynamic-import pattern + createCliRenderer
  config; :512-573 — renderable-construction vocabulary (fallback path)
- src/view-shell.ts:138-192 — armViewerExitTriggers to fork (SIGHUP,
  stdin-EOF resume()+TTY-only, ppid===1 poll guarded by launch ppid)
- node_modules/@opentui/core (index.d.ts + testing export) — ScrollBox
  options, keyInput keypress, RGBA.fromIndex, TextAttributes, renderer
  suspend()/resume(); trust these types over the docs clone on mismatch
- ~/resources/tui/opentui/packages/web/src/content/docs/ —
  core-concepts/renderer.mdx (reactive mode, theme), components/scrollbox
  (focus, culling, sticky), core-concepts/keyboard.mdx (focus routing)
- cli/keeper.ts:26-59 (SUBCOMMANDS + USAGE), :133 (lazy-import handler map)
- test/keeper-cli.test.ts:48-58,149,168-174 — handler enumeration,
  SUBCOMMANDS loop, isSubcommand assertions to extend
- test/live-shell.test.ts:8-34 — the serial-safe chaining contract;
  :159 — createTestRenderer({width, height, exitSignals: []}) pattern
- package.json:15-16 — test:opentui chain + fast-tier path-ignore lists
- README.md:573-632 — Example clients section shape

**Optional** (reference as needed):
- ~/resources/tui/opentui-skill/skill/opentui/references/core/gotchas.md
  — first stop on weird renderer behavior
- cli/autopilot.ts:1006-1122 — sibling main() shape (parseArgs, sock,
  help, dispatcher contract)

### Risks

- @opentui/core 0.3.0 vs docs-clone drift — the docs track main; resolve
  every API question against the installed package types.
- ScrollBox keys silently dead without focus() + an explicit height chain
  — the named failure mode; verify in the frame test.
- Terminal strand: any missed exit path (notably onFatal's default bare
  process.exit(1)) leaves alt-screen/raw mode — every path must route
  through exitCleanly.
- A new test file importing @opentui/core that is NOT in both the
  test:opentui chain and the fast-tier ignore list re-trips the
  native-loader TDZ and false-reds `bun test`.

### Test notes

test/dash-app.test.ts: frame test via createTestRenderer — mount the tree
against a seeded view-model, assert header/PLAN/AGENTS text content and
the connection-state line; destroy() after each test. Slow tier: add to
test:opentui chain AND the fast-tier --path-ignore-patterns. Extend
test/keeper-cli.test.ts (mkHandler("dash") + isSubcommand). Manual smoke:
`keeper dash` against the live daemon; `echo | keeper dash` for the gate;
Ctrl-Z/fg if suspend handling is implemented. `bun run test:full` is the
landing gate.

## Acceptance

- [ ] `keeper dash` on a TTY renders the three regions live; data edges
      repaint; elapsed refreshes on the 30s interval (cleared on exit)
- [ ] non-TTY stdout exits 1 with `keeper dash: requires a TTY` on stderr
      before any OpenTUI import
- [ ] every exit path (q, Ctrl-C, SIGHUP, stdin-EOF, ppid-poll, onFatal,
      uncaughtException/unhandledRejection) restores the terminal —
      renderer.destroy() before exit, exitCleanly idempotent
- [ ] daemon-down at launch shows the waiting line (no frozen blank
      screen); mid-session disconnect shows the header marker with body
      frozen; reconnect repaints without restart
- [ ] j/k/arrows scroll the focused ScrollBox; q quits from scroll focus
- [ ] read-only: no RPC frames sent, no DB open; --sock/$KEEPER_SOCK/
      default resolution matches siblings
- [ ] cli/keeper.ts SUBCOMMANDS/USAGE updated with the TTY-only carve-out;
      test/keeper-cli.test.ts extended; package.json test:opentui chain +
      fast-tier ignore updated; README Example clients updated
- [ ] `bun run test:full` green

## Done summary
Shipped the keeper dash materializer (src/dash/app.ts) + TTY-only process shell (cli/dash.ts) + forked exit triggers (src/dash/exit-triggers.ts): attachDashApp diffs role-tagged view-model rows into a stable Map<rowKey,TextRenderable> over a focused ScrollBox; createDashApp wires three subscriptions, a 30s elapsed interval, and one idempotent destroy-before-exit teardown across every exit path. Wired the dash subcommand into cli/keeper.ts, added the createTestRenderer frame test to the test:opentui chain + fast-tier ignore lists, and documented it in README.
## Evidence
