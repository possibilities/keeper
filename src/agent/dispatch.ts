/**
 * Subcommand dispatch — the pre-pass that runs before any wrapper logic.
 * `keeper agent` is a subcommand dispatcher. `splitSubcommand` strips exactly ONE
 * leading agent token and hands the rest to the launcher flow, so the composed
 * agent argv stays byte-identical to what the bare launcher produced.
 * `keeper agent claude claude` keeps the second `claude` as a prompt arg; the same contract applies to Pi.
 *
 * Informational flags (`-h`/`--help`, `-v`/`--version`) and the bare/unknown
 * invocation are owned here — they print and exit before `parseArgs` and the
 * passthrough scan ever see the argv.
 */

import pkg from "../../package.json" with { type: "json" };
import { type HarnessName, isHarnessName } from "./harness";

/** A harness `keeper agent` dispatches to — derived from the harness registry so
 *  the name set lives in exactly one place (`src/agent/harness.ts`). */
export type AgentKind = HarnessName;

/** The composable post-launch verbs that read a detached run's transcript. */
export type SubcommandKind = "wait-for-stop" | "show-last-message";

/** Result of the leading-token classification. Discriminated on `kind`. */
export type Dispatch =
  | { kind: "run"; agent: AgentKind; rest: string[] }
  | { kind: "run-preset"; presetName: string; rest: string[] }
  | { kind: "presets-resolve"; presetName: string }
  | { kind: "presets-list"; json: boolean }
  // The host-matrix provider doctor. `providers resolve <model> <effort>` emits
  // the cost-ordered serving candidates; `providers check` reports roster/preset/
  // reachability drift.
  | { kind: "providers-resolve"; model: string; effort: string }
  | { kind: "providers-check" }
  // Read-only claude-swap account-routing diagnostics.
  | { kind: "accounts-check"; json: boolean }
  | { kind: "accounts-recover"; ordinal: number; json: boolean }
  | {
      kind: "accounts-codex-pool";
      operation:
        | "enroll"
        | "status"
        | "proof-capture"
        | "proof-verdict"
        | "activate"
        | "verify"
        | "rollback"
        | "recover";
      rest: string[];
    }
  | {
      kind: "accounts-fable-focus";
      operation: "show" | "set" | "clear";
      rest: string[];
    }
  | {
      kind: "accounts-non-fable-focus";
      operation: "show" | "set" | "clear";
      rest: string[];
    }
  | { kind: "subcommand"; verb: SubcommandKind; rest: string[] }
  // The blocking run-and-capture verbs. `run-capture` composes launch→wait→show
  // in one process; `wait-capture` runs wait→show on an already-launched handle.
  // Both emit the uniform run-capture envelope. Named distinctly from the `run`
  // kind (the agent-launch) — the leading token is `run` / `wait`.
  | { kind: "run-capture"; rest: string[] }
  | { kind: "wait-capture"; rest: string[] }
  // The panel fan-out sub-verb (`start|wait|status|prune`). Routes into
  // `runPanel`; `rest` carries the operation + its flags, which `runPanel` owns
  // (self-emits + owns its code).
  | { kind: "panel"; rest: string[] }
  // The harness-agnostic resume verb: `resume <name-or-id> [prompt...]`.
  // `target` is the raw name/former-name/id argument (resolved through the
  // resume-policy module, never re-parsed here); `rest` is everything after
  // it — the optional follow-up prompt, joined by the route.
  | { kind: "resume"; target: string; rest: string[] }
  | { kind: "help" }
  | { kind: "help-wrapper" }
  | { kind: "agent-help" }
  | { kind: "version" }
  | { kind: "usage"; unknown?: string };

/** The wrapper-owned help flag, consumed before passthrough and launch. */
export const KEEPER_AGENT_HELP_FLAG = "--x-help";

/** True when argv contains the wrapper-owned `--x-help` flag. */
export function hasKeeperAgentHelpFlag(argv: string[]): boolean {
  return argv.includes(KEEPER_AGENT_HELP_FLAG);
}

/** Top-level help/usage text. */
export const USAGE = `keeper agent — launch agent CLIs with keeper agent routing and startup defaults.

Usage:
  keeper agent claude [args...]        Launch Claude Code.
  keeper agent pi [args...]            Launch pi.
  keeper agent --x-preset <name> [args...]
                                    Launch the preset's harness (harnessless).
  keeper agent presets resolve <name>  Emit the resolved preset/panel JSON.
  keeper agent presets list [--json]   List configured presets + panels.
  keeper agent accounts check [--json] Report separate Claude launch-routing and
                                    Codex session-routing health (read-only).
  keeper agent accounts recover cN [--json]
                                    Retry one token-expired Claude account.
  keeper agent accounts codex-pool enroll <opaque-alias>
  keeper agent accounts codex-pool status|verify|rollback|recover [--json]
  keeper agent accounts codex-pool proof capture <report> [--json]
  keeper agent accounts codex-pool proof verdict [report] [--json]
  keeper agent accounts codex-pool activate [report] [--json]
                                    Operate the quota-scoped proof-gated Codex pool.
  keeper agent accounts fable-focus show|clear [--json]
  keeper agent accounts fable-focus set <route|cN> <permanent|absolute|current-reset|cycle-end> [deadline] [--expect-reset <UTC>] [--json]
                                    Inspect or atomically replace durable Fable focus.
  keeper agent accounts non-fable-focus show|clear [--json]
  keeper agent accounts non-fable-focus set <route|cN> <permanent|absolute> [deadline] [--require-eligible] [--json]
                                    Inspect or atomically replace durable Non-Fable focus.
  keeper agent providers resolve <model> <effort>
                                    Emit the cost-ordered serving candidates for a
                                    model from the host matrix (no_route exit 3 for
                                    an unroutable wrapped model; exit 2 bad tokens).
  keeper agent providers check         Doctor: roster/preset/reachability drift.
  keeper agent wait-for-stop <handle> [--stop-timeout <dur>]
                                    Block until a detached run's next stop.
  keeper agent show-last-message <h>   Print a detached run's final message.
  keeper agent run <cli> <prompt> [--read-only] [--stop-timeout <dur>]
                                  [--system-file <path> | --system <text>]
                                  [--preset <name>] [--session <name>]
                                  [--output <path>] [--resume <name-or-id>]
                                  [--x-codex-pool-proof-window=arm]
                                  [--control <path> --control-owner <json>]
                                    Launch, wait, and capture in one process;
                                    emit the uniform run-capture JSON envelope.
                                    --read-only prepends a directive (prompting-only).
                                    --system-file/--system prepend a caller-side
                                    System: block (uniform across harnesses).
                                    --preset applies a launch-config preset (its
                                    harness must == <cli>); --session names the
                                    tmux GROUPING (not a resume key); --output
                                    atomically writes the envelope to a file on
                                    every outcome. --resume CONTINUES a prior
                                    partner (by current/former name or id) of the
                                    SAME <cli> and captures its new answer; it
                                    forbids --model/--effort/--preset (the resumed
                                    session owns its config). A positively-live
                                    Partner receives the ask over its existing Bus
                                    inbox and is captured without another writer.
                                    --control publishes the canonical exact
                                    teardown artifact at a caller-owned path and
                                    requires the matching --control-owner tuple.
                                    --reap-window-on-terminal kills the launched
                                    tmux window once a CONFIRMED-terminal result
                                    lands (completed/no_message/partner_died); a
                                    timed_out leaves the Partner resident and
                                    resumable, never reaped. The one-shot
                                    panel-leg posture; a plain run stays resident
                                    without it. To arm a scope-specific Codex pool proof window, run
                                    \`keeper agent run pi [--model <codex-model>] --x-codex-pool-proof-window=arm <prompt>\`;
                                    it requires a fresh managed Pi session.
  keeper agent wait <handle> [--stop-timeout <dur>]
                                    Wait + capture on an existing handle; emit
                                    the same uniform envelope.
  keeper agent panel start <prompt-file> --slug <slug> [--panel <name>] [--run-dir <d>] [--timeout <s>]
  keeper agent panel wait   (--slug <slug> | --run-dir <d>) [--chunk <s>]
  keeper agent panel status (--slug <slug> | --run-dir <d>)
  keeper agent panel prune
                                    Fan a question to a panel of detached
                                    read-only run legs (members from a configured
                                    --panel <name>), then wait for them token-free.
                                    --slug is REQUIRED on start — each leg launches
                                    as panel::<slug>::<preset>. The display slug
                                    re-finds a durable request; its opaque request
                                    identity owns the run and controls. Re-issuing
                                    start reconciles that request; wait/status
                                    address it by --slug or --run-dir. status prints
                                    a non-blocking per-leg snapshot; prune GCs
                                    abandoned run dirs. Exit 0 all-terminal / 124
                                    chunk-elapsed / 2 absent-slug-or-bad-config.
  keeper agent resume <name-or-id> [prompt]
                                    Re-attach a dead partner by current name,
                                    former name, or session id, launching it as
                                    a detached interactive TUI in its recorded
                                    cwd with the prompt delivered. Mints a FRESH
                                    tracked job carrying the matched row's name
                                    (never folds onto the resolved row). A live
                                    target is refused (exit 2, points at
                                    keeper bus chat send); an ambiguous or
                                    unknown target also exits 2 without
                                    launching anything.
  keeper agent --help                  Show this help.
  keeper agent --version               Show the version.

keeper agent transport flags such as --x-tmux are consumed by the wrapper;
all other args after the agent subcommand pass through to that launcher unchanged.
A detached launch (--x-tmux --x-tmux-detached) prints a JSON
handle; pass its "id" (or a transcript path) to wait-for-stop / show-last-message.
`;

/** Version string, sourced from package.json. */
export const VERSION = `keeper agent ${(pkg as { version: string }).version}\n`;

/**
 * Wrapper-owned overlay help. Documents only the `--x-*` surface the
 * wrapper consumes — common flags, the tmux transport flags, and the
 * agent-specific wrapper flag. Native agent flags are NOT listed here; reach a
 * launcher's own help with `keeper agent <agent> --help`.
 */
export const KEEPER_AGENT_HELP = `keeper agent — launch agent CLIs with keeper agent routing and startup defaults.

Usage:
  keeper agent claude [args...]   Launch Claude Code.
  keeper agent pi [args...]       Launch pi.

The flags below are consumed by the wrapper; every other arg after the agent
subcommand passes through to that launcher unchanged. For a launcher's own
options, run \`keeper agent <agent> --help\`.

Wrapper flags:
  --x-help                  Show this wrapper help and exit.
  --x-verbose               Print one line per startup section.
  --x-very-verbose          Add per-phase timing and the composed
                                    agent command. Implies --x-verbose.
  --x-no-confirm            Skip the cwd-confirmation prompt.
  --x-preset <name>         Apply a named launch-config preset from
                                    presets.yaml (harness/model/effort BELOW any
                                    explicit --model/--effort or effort env).
                                    With no agent token the harness comes from
                                    the preset; with one, a disagreeing harness
                                    is rejected. A fresh launch with no --x-preset
                                    resolves the harness <harness>_default pointer
                                    instead; one that resolves neither (and is
                                    not both --model + --effort/--thinking) is
                                    fail-loud (exit 2). Run
                                    \`keeper agent presets list\` for the names.
  --x-account <cN|N>        Claude only: select zero-based position N from the
                                    ordered cswap inventory for this launch.
                                    The request fails loudly if the inventory is
                                    stale or that account is not routeable.

Preset resolution:
  keeper agent presets resolve <name>  Emit the resolved JSON for a single preset
                                    ({name,harness,model,effort|thinking,role})
                                    or a panel (an ordered array of
                                    {name,harness} members).
  keeper agent presets list [--json]   List the configured catalog presets
                                    (name + harness/model/effort) and panels.

Account routing:
  keeper agent claude --x-account c1   Request the second account in cswap
                                    inventory order for this launch. cN labels
                                    match the Claude statusline; they are not
                                    claude-swap slot numbers.
  keeper agent accounts check [--json] Report claude-swap health, snapshot age,
                                    PII-free candidates, and the managed route
                                    the policy would choose for the next Claude
                                    launch — read-only, reserves nothing. A
                                    Claude launch fails if none is routeable.
  keeper agent accounts recover cN [--json]
                                    Force inventory, retry only a token-expired
                                    account, then require fresh healthy route
                                    evidence. Creates no Keeper Launch
                                    reservation or Harness session;
                                    claude-swap starts a bounded Claude canary.

tmux transport flags (any one implies tmux mode):
  --x-tmux                  Open the invocation in a new tmux window.
  --x-tmux-detached         Create the window without moving focus.
  --x-tmux-session <name>   Target/create the named tmux session.
  --x-tmux-window-name <n>  Name the created tmux window.
  --x-tmux-socket-name <n>  tmux server socket name (-L).
  --x-tmux-socket-path <p>  tmux server socket path (-S).
  --x-tmux-env KEY=VALUE    Inject env into the pane via tmux -e
                                    (repeatable; LD_*/DYLD_* keys rejected).
  --no-artifacts                    Suppress the launch.sh/run.json run-dir
                                    trail; JSON result carries runDir:null.

Post-launch transcript subcommands (composable with a detached launch):
  keeper agent wait-for-stop <handle> [--stop-timeout <dur>]
                                        Block until the run's next stop event.
                                        --stop-timeout overrides the 600s
                                        stop-wait ceiling (duration, unit
                                        required: e.g. 500ms, 30s, 10m).
  keeper agent show-last-message <handle>  Print the run's final assistant message.
                                        <handle> is the launch JSON's id (or a
                                        transcript path with --agent <kind>).

Blocking run-and-capture verbs (one uniform schema-versioned JSON envelope):
  keeper agent run <cli> <prompt> [--read-only] [--stop-timeout <dur>]
                                  [--system-file <path> | --system <text>]
                                  [--preset <name>] [--session <name>]
                                  [--output <path>]
                                  [--x-codex-pool-proof-window=arm]
                                        Launch <cli> detached, wait for its stop,
                                        and capture the final message — all in one
                                        process. --read-only prepends a read-only
                                        directive to the prompt — prompting-only,
                                        keeper enforces nothing (no tool strip, no
                                        changed-files audit). --system-file/--system compose a
                                        caller-side System:-prepend into the prompt
                                        (mutually exclusive; missing file → bad_args),
                                        uniform across Claude/Pi — user-turn
                                        text, not a privileged system prompt. Pi launches with CLAUDE* env stripped by default
                                        (partner isolation). --preset applies a named
                                        launch-config preset (its resolved harness
                                        must == <cli>, else bad_args); --session
                                        names the tmux session grouping (rides as
                                        --x-tmux-session, NOT the transcript id);
                                        --output atomically writes the SAME envelope
                                        to <path> (temp+rename) on every outcome, in
                                        addition to stdout. To arm a scope-specific
                                        Codex pool proof window, run \`keeper agent run
                                        pi [--model <codex-model>] --x-codex-pool-proof-window=arm
                                        <prompt>\`; it requires a fresh managed Pi session.
                                        Emits the uniform envelope
                                        {schema_version, agent, handle,
                                        transcript_path, resume_target, message,
                                        message_found, elapsed_seconds, outcome};
                                        outcome ∈ completed|no_message (exit 0) /
                                        timed_out|no_transcript|transcript_ambiguous
                                        (4) / launch_failed (1) / bad_args (2).
                                        the resume_target comes from the pinned session
                                        id or the harness's post-stop attribution.
                                        A timed_out reports only that the observation
                                        deadline elapsed: it preserves the bounded
                                        partial, never reaps or marks the Partner
                                        terminal, and leaves it resident for
                                        show-last-message / resume — with stderr
                                        distinguishing a live Partner from unknown
                                        lifecycle evidence.
  keeper agent wait <handle> [--stop-timeout <dur>]
                                        Wait + capture on an already-launched
                                        handle (a run id or a transcript path with
                                        --agent <kind>); same uniform envelope.

Panel fan-out (start | wait | status | prune):
  keeper agent panel start <prompt-file> --slug <slug> [--panel <name>] [--run-dir <d>] [--timeout <s>]
  keeper agent panel wait   (--slug <slug> | --run-dir <d>) [--chunk <s>]
  keeper agent panel status (--slug <slug> | --run-dir <d>)
  keeper agent panel prune
                                        Fan a question to a panel of models as
                                        detached read-only \`keeper agent run\`
                                        legs, then wait for them token-free.
                                        Members come from a configured --panel
                                        <name> (a panel.yaml panel or a single
                                        catalog preset). --slug is REQUIRED on start
                                        — each leg launches as panel::<slug>::<preset>
                                        and the run lives at the durable slug-keyed
                                        ~/.local/state/keeper/panels/<slug>/. The slug
                                        is display/discovery metadata; the opaque
                                        request identity owns the run and controls.
                                        Re-issuing the same line RECONCILES (reuse
                                        terminal legs, leave running, relaunch
                                        no-result), never a blind re-fan-out.
                                        wait/status address a run by
                                        --slug (or --run-dir; --run-dir wins). wait blocks
                                        ONE --chunk window + prints the N-of-N
                                        verdict; status prints a non-blocking per-leg
                                        snapshot (completed|running|failed|absent);
                                        prune GCs abandoned run dirs (lock-free, no
                                        live pid, past TTL). Exit 0 = all legs
                                        terminal (key off the verdict's 'ok' flag,
                                        NOT the code), 124 = chunk elapsed (re-issue
                                        it), 2 = an absent/empty --slug, a
                                        missing/corrupt manifest, or bad config.

Launch handles: a caller-supplied handle is the surface-local deduplication and
routing anchor. A dead partner resumes by its name or id; \`agent run --resume\`
reaches a positively-live Partner through its existing Bus inbox while the
interactive \`resume\` verb still refuses another attach. Partner names are host-global
among tracked jobs. Handoff slugs are host-global event-sourced handles whose
duplicate exits 3. Panel slugs are display/discovery metadata; their opaque request
identity owns the panel request and controls.

Resume (harness-agnostic re-attach):
  keeper agent resume <name-or-id> [prompt]
                                        Resolve <name-or-id> (a current name,
                                        former name, or session id) to a dead
                                        partner job and re-attach it as a
                                        detached interactive TUI in its
                                        recorded cwd, delivering [prompt] as
                                        its next turn. Mints a FRESH tracked
                                        job carrying the matched row's name —
                                        it never folds onto the resolved row,
                                        so a later resume by the same name
                                        chains onto this newer lineage. A LIVE
                                        target is refused (exit 2, points at
                                        \`keeper bus chat send\`); an ambiguous
                                        target exits 2 listing every tied
                                        candidate; an unknown target or one with
                                        no resume target exits 2 without
                                        launching anything. The harness-native
                                        passthrough flags (--x-* etc.) apply
                                        identically to a fresh launch.

tmux-mode exit codes (a structured JSON error is emitted on every non-zero exit):
  0  success                        2  bad args
  1  internal/parse failure         3  prerequisite missing (tmux/session not found)
                                    4  transient/retryable (timeout, lock contention)

Agent-specific wrapper flags:
Top-level flags:
  --help, -h                        Show short usage.
  --version, -v                     Show the version.
`;

/**
 * Terse operator runbook (agent-facing), distinct from `--help` (short usage) and
 * `--x-help` (the wrapper-flag overlay). The 3-6 invocations an operator reaches
 * for, the envelope/exit contract, and the footguns — not a re-render of usage.
 */
export const KEEPER_AGENT_RUNBOOK = `keeper agent — operator runbook (agent-facing)

Launch or drive a partner model CLI from this session.

  keeper agent run <claude|pi> "<prompt>" [--read-only] [--system <text>]
                                    # launch, wait, capture — one uniform JSON envelope
  keeper agent run <cli> "<prompt>" --preset <name> --output <path>
                                    # apply a launch-config preset; mirror the envelope to a file
  keeper agent panel start <prompt-file> --slug <slug> [--panel <name>]
  keeper agent panel wait --slug <slug>   # blocks ONE chunk; re-issue on exit 124
  keeper agent presets list         # the names for --preset / --panel
  keeper agent run <cli> "<follow-up ask>" --resume <name-or-id>
                                    # capture a dead resume or a live Bus response

Exit codes: 0 terminal answer · 124 panel wait chunk elapsed with no terminal answer
(a re-issue SIGNAL, not a failure — call wait again) · 2 absent slug / bad config.
Footguns: pi launches with CLAUDE* env stripped (partner isolation); 'run' blocks,
so fan a long or multi-model ask out via 'panel start' + chunked 'panel wait'. NOT a
keeper worker on plan work (that is keeper dispatch).
`;

/**
 * Classify the leading argv token. registered harness token → run with the remaining
 * args (even when empty, so a bare registered harness command
 * still launches interactively); a leading `--x-preset <name>` (no head
 * agent token) → the harnessless run-preset form whose harness comes from the
 * preset (the whole argv stays in `rest` so parseArgs strips the flag);
 * `presets resolve <name>` → emit the resolved preset/panel JSON;
 * `wait-for-stop`/`show-last-message` → the
 * post-launch transcript verbs with the remaining args (the handle); `run`/`wait`
 * → the blocking run-and-capture verbs (launch→wait→show in one process, and
 * wait→show on an existing handle) emitting the uniform envelope; `resume
 * <name-or-id> [prompt...]` → re-attach a dead partner by current/former name
 * or session id (a bare `resume` with no target is usage — a target is
 * required); `--x-help`
 * → wrapper help; `--agent-help` → the operator runbook; `-h`/`--help` → short usage;
 * `-v`/`--version` → version; an empty
 * argv or any other leading token → usage (carrying the unknown subcommand name when
 * present). Strips exactly one token so a repeated agent name preserves the second.
 * When the wrapper-help flag follows an agent token it lands in `rest`; main()
 * detects it there before passthrough and launch.
 */
export function splitSubcommand(argv: string[]): Dispatch {
  const head = argv[0];
  if (head === undefined) {
    return { kind: "usage" };
  }
  if (isHarnessName(head)) {
    return { kind: "run", agent: head, rest: argv.slice(1) };
  }
  if (head === "presets") {
    if (argv[1] === "resolve") {
      const presetName = argv[2];
      if (presetName === undefined || presetName.trim() === "") {
        return { kind: "usage", unknown: "presets resolve" };
      }
      return { kind: "presets-resolve", presetName: presetName.trim() };
    }
    if (argv[1] === "list") {
      return { kind: "presets-list", json: argv.slice(2).includes("--json") };
    }
    return { kind: "usage", unknown: `presets ${argv[1] ?? ""}`.trim() };
  }
  if (head === "accounts") {
    if (argv[1] === "check") {
      const rest = argv.slice(2);
      if (rest.some((arg) => arg !== "--json")) {
        return { kind: "usage", unknown: "accounts check" };
      }
      return { kind: "accounts-check", json: rest.includes("--json") };
    }
    if (argv[1] === "recover") {
      const label = argv[2];
      const rest = argv.slice(3);
      const match = label === undefined ? null : /^c(0|[1-9]\d*)$/u.exec(label);
      const ordinal = match === null ? Number.NaN : Number(match[1]);
      if (
        match === null ||
        !Number.isSafeInteger(ordinal) ||
        rest.length > 1 ||
        (rest.length === 1 && rest[0] !== "--json")
      ) {
        return { kind: "usage", unknown: "accounts recover" };
      }
      return {
        kind: "accounts-recover",
        ordinal,
        json: rest[0] === "--json",
      };
    }
    if (argv[1] === "codex-pool") {
      const verb = argv[2];
      if (
        verb === "enroll" ||
        verb === "status" ||
        verb === "activate" ||
        verb === "verify" ||
        verb === "rollback" ||
        verb === "recover"
      ) {
        return {
          kind: "accounts-codex-pool",
          operation: verb,
          rest: argv.slice(3),
        };
      }
      if (
        verb === "proof" &&
        (argv[3] === "capture" || argv[3] === "verdict")
      ) {
        return {
          kind: "accounts-codex-pool",
          operation: argv[3] === "capture" ? "proof-capture" : "proof-verdict",
          rest: argv.slice(4),
        };
      }
      return { kind: "usage", unknown: "accounts codex-pool" };
    }
    if (argv[1] === "fable-focus") {
      const operation = argv[2];
      if (
        operation === "show" ||
        operation === "set" ||
        operation === "clear"
      ) {
        return {
          kind: "accounts-fable-focus",
          operation,
          rest: argv.slice(3),
        };
      }
      return { kind: "usage", unknown: "accounts fable-focus" };
    }
    if (argv[1] === "non-fable-focus") {
      const operation = argv[2];
      if (
        operation === "show" ||
        operation === "set" ||
        operation === "clear"
      ) {
        return {
          kind: "accounts-non-fable-focus",
          operation,
          rest: argv.slice(3),
        };
      }
      return { kind: "usage", unknown: "accounts non-fable-focus" };
    }
    return { kind: "usage", unknown: `accounts ${argv[1] ?? ""}`.trim() };
  }
  if (head === "providers") {
    if (argv[1] === "resolve") {
      const model = argv[2];
      const effort = argv[3];
      if (
        model === undefined ||
        model.trim() === "" ||
        effort === undefined ||
        effort.trim() === ""
      ) {
        return { kind: "usage", unknown: "providers resolve" };
      }
      return {
        kind: "providers-resolve",
        model: model.trim(),
        effort: effort.trim(),
      };
    }
    if (argv[1] === "check") {
      return { kind: "providers-check" };
    }
    return { kind: "usage", unknown: `providers ${argv[1] ?? ""}`.trim() };
  }
  if (head === "--x-preset" || head.startsWith("--x-preset=")) {
    // Harnessless launch: harness comes from the named preset. Keep the WHOLE
    // argv in `rest` so parseArgs strips the flag and main() resolves it.
    const presetName =
      head === "--x-preset"
        ? (argv[1] ?? "").trim()
        : head.slice("--x-preset=".length).trim();
    if (presetName === "") {
      return { kind: "usage", unknown: "--x-preset" };
    }
    return { kind: "run-preset", presetName, rest: argv };
  }
  if (head === "wait-for-stop" || head === "show-last-message") {
    return { kind: "subcommand", verb: head, rest: argv.slice(1) };
  }
  if (head === "run") {
    return { kind: "run-capture", rest: argv.slice(1) };
  }
  if (head === "wait") {
    return { kind: "wait-capture", rest: argv.slice(1) };
  }
  if (head === "panel") {
    return { kind: "panel", rest: argv.slice(1) };
  }
  if (head === "resume") {
    const target = (argv[1] ?? "").trim();
    if (target === "") {
      return { kind: "usage", unknown: "resume" };
    }
    return { kind: "resume", target, rest: argv.slice(2) };
  }
  if (head === KEEPER_AGENT_HELP_FLAG) {
    return { kind: "help-wrapper" };
  }
  if (head === "--agent-help") {
    return { kind: "agent-help" };
  }
  if (head === "-h" || head === "--help") {
    return { kind: "help" };
  }
  if (head === "-v" || head === "--version") {
    return { kind: "version" };
  }
  return { kind: "usage", unknown: head };
}
