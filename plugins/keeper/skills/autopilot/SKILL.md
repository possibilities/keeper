---
name: autopilot
description: >-
  Drive the server-side autopilot reconciler by hand — pause / play, switch
  mode (yolo vs armed), arm / disarm an epic, retry a stuck dispatch, or read
  what it is doing. Also the temporary take-over window: capture the current
  {paused, mode, armed, worktree_mode} state, change it for a bit, then restore it when the
  human says done. Use when the user asks to pause or steer the autopilot —
  pause/play, mode, arm, retry, or inspect it ("pause it", "let it rip",
  "only work fn-X", "approve fn-Y", "what's autopilot doing") — even when they
  never say "keeper" or "autopilot". NOT for launching one worker by hand
  (that is `keeper:dispatch`); "prioritize this" / "do this next" alone never
  triggers this skill (plan state carries no board-priority knob — only an
  explicit autopilot/armed reference does); NOT for planning (`/plan:plan`).
allowed-tools: Bash Monitor
argument-hint: pause | play | mode <yolo|armed> | arm <id> | disarm <id> | worktree <on|off> | retry <verb::id> | show
---

# autopilot

Turn a "control or inspect the autopilot" request into a `keeper autopilot`
Bash call. The autopilot reconciler lives server-side in keeperd; it dispatches
ready plan work on its own and **boots PAUSED for safety**. This skill is the
operator surface over it — pausing, playing, mode-switching, arming, retrying a
stuck dispatch, and reading its live state. It is a precisely-triggered
operator surface, conservative by default: it mutates global autopilot state
only on a clear request to steer it. The autopilot quietly working ready epics
on its own remains the everyday path.

**Name-vs-subcommand collision.** This skill is named `autopilot` and the CLI
it wraps is `keeper autopilot`. Running the viewer is a **Bash call**
(`keeper autopilot --snapshot`), NOT "open the skill." Don't confuse the two.

## When this fires

The user asks to control or inspect the autopilot. Two layers:

1. **Single control ops + reads** — pause / play, mode yolo|armed, arm /
   disarm an epic, retry a stuck dispatch, or "what's it doing." A bare control
   op JUST RUNS — one `keeper autopilot <sub>` Bash call, no capture/restore.
2. **The temporary take-over window** — ONLY when the human asks to "take over
   for a bit, then put it back." Capture state → drive → restore. See its own
   section below.

**Near-miss exclusions — these are NOT this skill:**

- *"fire a worker on fn-N.M"*, *"manually dispatch / spawn a worker"* → that is
  `keeper:dispatch`, which fires ONE worker by hand. `keeper dispatch` BYPASSES
  the autopilot entirely (you drive); this skill GATES it.
- *"prioritize this"* / *"do this next"* / *"jump the queue"* → there is no
  board-priority surface in plan state; this becomes this skill ONLY when the
  human EXPLICITLY names autopilot / armed mode ("arm fn-X", "only run fn-X under
  armed mode"). **Anti-trigger:** plain "prioritize" never means "arm."
- *"plan a feature"* / *"make a plan"* → `/plan:plan`.

## Parse the request

Map intent to the exact `keeper autopilot` subcommand — never "pass any valid
flags." Every control op below is a bare one-shot Bash call:

| Intent | How to derive | `keeper autopilot` form |
|---|---|---|
| Pause it | "pause", "stop dispatching", "hold the autopilot" | `keeper autopilot pause` |
| Play / let it run | "play", "unpause", "let it run", "resume" | `keeper autopilot play` |
| Yolo / let it rip | "yolo", "let it rip", "work everything ready" | `keeper autopilot mode yolo` |
| Armed mode | "armed mode", "only work armed epics", "narrow it to what I arm" | `keeper autopilot mode armed` |
| Arm an epic | "arm fn-X", "only work fn-X and its deps" — an epic id `fn-N-slug` | `keeper autopilot arm fn-N-slug` |
| Disarm an epic | "disarm fn-X", "stop arming fn-X" | `keeper autopilot disarm fn-N-slug` |
| Worktree mode on/off | "worktree mode on/off", "run lanes in worktrees" — durable toggle, rejected mid-epic (`--force` to override) | `keeper autopilot worktree on` / `keeper autopilot worktree off` |
| Retry a stuck dispatch | A sticky failure key `<verb>::<id>`, verb one of `work\|close\|approve` | `keeper autopilot retry work::fn-N-slug.3` |
| Clear / approve a phantom | "approve fn-X" — clears a resurrected/phantom approve pending (the reconciler never dispatches `approve` itself) | `keeper autopilot retry approve::fn-N-slug` |
| Show me what it's doing | "what's autopilot doing", "show me the autopilot", "is it paused" | `keeper autopilot --snapshot \| tail -1` (read) |

`yolo` works EVERY ready epic; `armed` works ONLY explicitly-armed epics plus
their transitive upstream dep-closure. `arm` / `disarm` only matter in `armed`
mode (they populate the armed set), but setting them in `yolo` is harmless.

If the human gives a slug-less reference ("arm the OAuth epic") and you can't
resolve it to an exact id, ask. Do not invent ids. Gate any ambiguous
control-plane intent ("change the mode" without naming which) with ONE
clarifying question — fail loud on ambiguity, never guess a global-state mutation.

## Reading autopilot state

Read state with the snapshot, NEVER the live stream:

```bash
keeper autopilot --snapshot | tail -1
```

The last stdout line is the machine-parseable `keeper-meta:` trailer (a single
JSON object). Its `state` field is a PATH to a per-frame sidecar JSON carrying
the captured singleton plus the body sections:

```json
{ "paused": false, "mode": "yolo", "armed": [], "worktree_mode": false, "current": [], "dependencies": [], "failed": [] }
```

The `{paused, mode, armed, worktree_mode}` set IS the autopilot's global singleton — read
those to answer "what's it doing" and to capture before a take-over. For a
human-readable frame instead of the trailer, drop `| tail -1` and read the whole
snapshot block (banner pill `[playing] · yolo · max ∞`, plus the current /
stopped / failed / armed / dependencies sections). `status: "ok"` with `frame:
1` in the trailer means a real frame was captured; `truncated: true` means the
snapshot timed out with a partial composite — re-run before trusting it.

## Single control op — just run it

A bare control op is one Bash call. No capture, no restore — the human asked for
a deliberate change, so do NOT auto-undo it.

```bash
keeper autopilot pause
```

On success the RPC writes one JSON line to stdout and exits 0; surface it to the
human ("autopilot paused"). On failure it exits 1 with an `autopilot: <reason>`
line — surface that verbatim; the state is unchanged.

## The temporary take-over window (capture → drive → restore)

ONLY when the human says some version of "take over for a bit, then put it
back." This is the one place capture/restore applies — a bare "pause it" must
NEVER capture/restore (that would auto-undo a deliberate pause).

**1 — Capture BEFORE mutating.** Read the full singleton and pin all three
fields in your working context for the whole window:

```bash
keeper autopilot --snapshot | tail -1   # read the `state` sidecar → {paused, mode, armed}
```

Capture `{paused, mode, armed_epics, worktree_mode}` — capturing fewer than all
four produces a wrong GLOBAL state on restore. Pin them; do not re-derive from
memory later.

**2 — Drive.** Run the control ops the take-over needs (pause, mode, arm, …).
Wire the restore plan PER MUTATING PHASE as you go — track exactly which fields
you changed so restore touches ONLY those.

**3 — The window closes on an EXPLICIT signal**, NOT a turn boundary. It closes
when the human says "restore it / put it back / done", or when an armed
`keeper:await` you set fires `met`. A turn ending does NOT close the window — a
take-over spans turns.

**4 — On close, RE-READ then restore.** The reconciler is LEVEL-TRIGGERED and
may have drifted during the window, so re-read current state before restoring:

```bash
keeper autopilot --snapshot | tail -1   # re-read CURRENT state
```

Restore ONLY the fields your take-over changed, back to the captured values
(e.g. if you only paused, just `keeper autopilot play` to restore `paused:false`
— don't touch mode or arm). Issue one control op per field that needs reverting.

**5 — Surface a restore failure DISTINCTLY.** If any restore op exits non-zero,
do NOT swallow it. Surface a distinct error: **"autopilot state unknown — verify
with `keeper autopilot --snapshot`."** Name the **partial-mutation** case
explicitly when it happens (e.g. mode restored but a disarm failed) so the human
knows exactly which field is still off and can finish the restore by hand.

## The risk gradient

Teach the human (and yourself) which ops are walk-away-adjacent vs which hand
you the wheel:

- **`arm` / `mode armed` NARROW a still-running autopilot** — low risk. The
  reconciler keeps dispatching, just over a smaller set. Walk-away-adjacent.
- **`keeper dispatch` BYPASSES the autopilot** — YOU drive that worker. Higher
  risk, fully manual. That is `keeper:dispatch`, not this skill.
- **`pause`** stops all dispatching — deliberate and total; remember to `play`
  (or restore) when done.

## await integration

For "pause and do something manually at a point WHILE work runs," combine a
take-over with an armed `keeper:await`: capture state, make your change, arm
`keeper:await` for the board/condition that should end the window, and restore
on its `met`. See `keeper:await` for wiring the Monitor. The `Monitor` tool is
allowed here ONLY for that cross-ref — a bare control op never needs it.

## Examples

### Pause it (bare control op)

> User: "Pause the autopilot."

1. `keeper autopilot pause` → exits 0, prints the RPC result.
2. Surface "autopilot paused." No capture, no restore — it's a deliberate change.

### Arm one epic under armed mode

> User: "Only work fn-871-…-skills and its deps."

1. `keeper autopilot mode armed` → narrows to the armed set.
2. `keeper autopilot arm fn-871-…-skills` → arms it (plus its transitive dep
   closure). Surface both results.

### Retry a stuck dispatch

> User: "Retry the work dispatch for fn-619-foo.3."

1. `keeper autopilot retry work::fn-619-foo.3` → clears the sticky
   `dispatch_failures` row so the reconciler can re-dispatch.
2. Surface the result. (For a phantom approve: `keeper autopilot retry
   approve::fn-619-foo`.)

### Show what it's doing (read)

> User: "What's the autopilot up to?"

1. `keeper autopilot --snapshot | tail -1` → parse the `keeper-meta:` JSON;
   read its `state` sidecar for `{paused, mode, armed}` plus the current /
   failed sections.
2. Report paused/playing, mode, armed epics, and any in-flight or failed
   dispatches. NEVER `--watch` (it hangs).

### Take over for a bit, then put it back

> User: "Pause it and switch to armed while I poke at fn-871, then restore it."

1. **Capture:** `keeper autopilot --snapshot | tail -1` → pin `{paused:false,
   mode:"yolo", armed:[], worktree_mode:false}`.
2. **Drive:** `keeper autopilot pause`; `keeper autopilot mode armed`. Track:
   changed `paused` and `mode` (not `armed`).
3. Window stays open across turns until the human says "restore it / done."
4. **On close — re-read:** `keeper autopilot --snapshot | tail -1` (the
   reconciler may have drifted).
5. **Restore only what changed:** `keeper autopilot play` (→ `paused:false`);
   `keeper autopilot mode yolo`. If `mode yolo` succeeds but `play` fails →
   surface "autopilot state unknown — verify with `keeper autopilot --snapshot`;
   mode restored to yolo but unpause FAILED (still paused)."

## What NOT to do

- Do not run `keeper autopilot --watch` — it forces the live subscribe stream
  and HANGS the agent's tool call forever. Reads are always `--snapshot | tail
  -1` (or the bare snapshot block).
- Do not capture/restore around a BARE control op — capture/restore is
  take-over-window-only. Auto-restoring after "pause it" would silently undo a
  deliberate pause.
- Do not close the take-over window on a turn boundary — it closes only on an
  EXPLICIT human signal or an armed `keeper:await` firing.
- Do not restore without RE-READING current state first — the level-triggered
  reconciler may have drifted, and restoring a stale capture sets a wrong global
  state.
- Do not capture fewer than {paused, mode, armed_epics, worktree_mode} — a
  partial capture restores a wrong global state.
- Do not swallow a restore failure — surface "autopilot state unknown — verify
  with `keeper autopilot --snapshot`" distinctly, and name the partial-mutation
  field that's still off.
- Do not treat "prioritize this" / "do this next" as arm/mode — plan state has
  no board-priority knob. Only an explicit autopilot/armed reference triggers
  this skill.
- Do not use this to launch a worker by hand — that is `keeper:dispatch`.
- Do not guess on ambiguous control-plane intent — ask ONE clarifying question
  before mutating global state.
- Do not invent ids. A slug-less, ambiguous reference → ask.

## Guardrails

- **Precisely-triggered, conservative by default.** This is the operator surface
  over the autopilot — the everyday path is the reconciler working ready epics on
  its own. Reach for it on a clear request to control or inspect it, and never
  mutate global state on ambiguous intent.
- **Bare ops just run; take-over captures and restores.** A single control op is
  one Bash call with no capture. Capture → drive → restore is reserved for an
  explicit "take over for a bit, then put it back," and the window always closes
  on restore.
- **Restore when done.** A take-over owes a restore on the explicit close
  signal; re-read first, restore only what changed, and surface any restore
  failure distinctly — never leave the global state silently wrong.
