/**
 * Pure-data descriptor module for the keeper-native CLI surface (ADR 0008).
 *
 * This is the SINGLE source of truth the native CLI consumes: `cli/keeper.ts`
 * renders the human `USAGE` block, the machine `keeper --help --json` index, and
 * the shell-completion tree from `NATIVE_COMMANDS`, and each native leaf derives
 * its `node:util` `parseArgs` options object from its own descriptor entry via
 * {@link buildParseOptions} — so a flag can never drift from the metadata that
 * documents it. The descriptor drives the parser rather than describing it.
 *
 * PURITY CONTRACT: this module is dependency-free data + types. It imports
 * NOTHING from `cli/` or `src/` (an import-graph test pins this), so the help and
 * completion paths — which lazily import it — never boot a plugin, open the
 * database, or touch the daemon socket. Keep it types + literals only.
 *
 * Leaves that hand-roll their arg loop (the `--flag`/`--flag=value` manual
 * parsers) or dispatch to sub-verbs (agent/bus/plan/prompt) cannot round-trip a
 * single `node:util` options object; they DECLARE their flag surface here and a
 * conformance test asserts the declaration, per the epic's Early proof point.
 */

// ── flag / option model ──────────────────────────────────────────────────────

/** The two value shapes `node:util` `parseArgs` supports. */
export type FlagType = "boolean" | "string";

/**
 * One CLI flag, described once. The behavior-critical fields (`type`, `short`,
 * `multiple`, `default`) are exactly what {@link buildParseOptions} feeds
 * `parseArgs`, so a derived leaf's parse surface is definitionally this data.
 * `summary` is documentation-only (leaf help / the JSON index).
 */
export interface FlagDescriptor {
  readonly name: string;
  readonly type: FlagType;
  /** Single-character alias (e.g. `h` for `--help`). */
  readonly short?: string;
  /** Repeatable flag → parsed value is an array. */
  readonly multiple?: boolean;
  /** `parseArgs` default (booleans that read as `false` when absent). */
  readonly default?: boolean | string;
  /** One-line human description. */
  readonly summary?: string;
}

/**
 * A `node:util` `parseArgs` option config, reproduced structurally so this module
 * needs no `node:util` import to stay dependency-free. Assignable to
 * `ParseArgsConfig["options"]` values at every call site.
 */
export interface ParseOption {
  type: FlagType;
  short?: string;
  multiple?: boolean;
  default?: boolean | string;
}

/** Whether a command shows up in the human `USAGE` block. `internal` commands
 *  are wiring-only (fleet-injected, never typed by a human): omitted from USAGE,
 *  still present in `keeper --help --json` carrying this field. */
export type Visibility = "public" | "internal";

/** The output renderings a finite-output read command can produce. Declared
 *  truthfully — a command never advertises a mode it cannot render. */
export type FormatMode = "json" | "yaml" | "human";

/**
 * One command (top-level subcommand, or a nested verb under `verbs`). The
 * recursive `verbs` array carries the two-level surface (`autopilot pause`,
 * `tabs restore`, …). `flags` is authoritative for a derived leaf; declaration-
 * only for a hand-rolled/dispatcher leaf.
 */
export interface CommandDescriptor {
  readonly name: string;
  readonly summary: string;
  readonly visibility: Visibility;
  /** Writes state (git, tmux, the bus, a spool/leaf) as its primary effect. */
  readonly mutates: boolean;
  /** Needs a live daemon socket connection to do its job. */
  readonly requires_daemon: boolean;
  /** Refuses a non-TTY stdout (no snapshot fallback). */
  readonly requires_tty: boolean;
  /** Carries a `--agent-help` operator runbook distinct from `--help`. */
  readonly agent_help?: boolean;
  /** Output renderings this command can produce (finite-output reads only). */
  readonly format_modes?: readonly FormatMode[];
  /** Command-specific exit codes beyond the shared 0/1/2 core. */
  readonly exit_codes?: Readonly<Record<string, string>>;
  /** The flag surface (authoritative for derived leaves). */
  readonly flags: readonly FlagDescriptor[];
  /** Nested verbs for a two-level command. */
  readonly verbs?: readonly CommandDescriptor[];
}

// ── derivation helper ────────────────────────────────────────────────────────

/** One flag → its `parseArgs` option config, preserving literal `type` / `short`
 *  / `multiple` / `default` so `parseArgs` can type `values` precisely. */
type ToOption<F extends FlagDescriptor> = { type: F["type"] } & (F extends {
  short: infer S extends string;
}
  ? { short: S }
  : unknown) &
  (F extends { multiple: infer M extends boolean }
    ? { multiple: M }
    : unknown) &
  (F extends { default: infer D extends boolean | string }
    ? { default: D }
    : unknown);

/** A flag tuple → the keyed `parseArgs` options object type. When the flags are
 *  an `as const` literal, this reproduces exactly the type an inline options
 *  literal would have had — so a derived leaf keeps its precise `values` typing. */
type ToOptions<F extends readonly FlagDescriptor[]> = {
  [E in F[number] as E["name"]]: ToOption<E & FlagDescriptor>;
};

/**
 * Build the `node:util` `parseArgs` `options` object from a flag list. The one
 * seam that makes "the descriptor drives the parser": a derived leaf passes
 * `buildParseOptions(FLAGS)` as its `parseArgs({ options })`, so its accepted
 * flags cannot diverge from its documented flags. Only the behavior-critical
 * fields flow through; `summary` is dropped (parseArgs ignores it).
 *
 * Generic over a `const` flag tuple so a leaf passing its `as const` flags gets
 * back a precisely-typed options object — `parseArgs` then types `values` with
 * per-flag precision, identical to the retired inline literal. Called with a
 * widened `FlagDescriptor[]` (via {@link parseOptions}) it degrades gracefully to
 * a loose object, which is all its non-leaf consumers (tests, index) need.
 */
export function buildParseOptions<const F extends readonly FlagDescriptor[]>(
  flags: F,
): ToOptions<F> {
  const options: Record<string, ParseOption> = {};
  for (const f of flags) {
    const opt: ParseOption = { type: f.type };
    if (f.short !== undefined) opt.short = f.short;
    if (f.multiple !== undefined) opt.multiple = f.multiple;
    if (f.default !== undefined) opt.default = f.default;
    options[f.name] = opt;
  }
  return options as ToOptions<F>;
}

// ── shared flag fragments ────────────────────────────────────────────────────
//
// Authored `as const` so a derived leaf that passes an exported flag tuple to
// `buildParseOptions` keeps its precise per-flag `values` typing. NATIVE_COMMANDS
// references the same tuples for its `flags` (widened to `readonly
// FlagDescriptor[]` on read — that is all the index/USAGE/completions need).

const FLAG_SOCK = {
  name: "sock",
  type: "string",
  summary: "Daemon socket path override",
} as const satisfies FlagDescriptor;
const FLAG_HELP = {
  name: "help",
  type: "boolean",
  short: "h",
  summary: "Show this help",
} as const satisfies FlagDescriptor;
const FLAG_HELP_DEFAULTED = {
  name: "help",
  type: "boolean",
  default: false,
  summary: "Show this help",
} as const satisfies FlagDescriptor;
const FLAG_AGENT_HELP_DEFAULTED = {
  name: "agent-help",
  type: "boolean",
  default: false,
  summary: "Show the terse operator runbook",
} as const satisfies FlagDescriptor;
/** The shared `--format json|yaml|human` flag for a finite-output JSON reader.
 *  The command's `format_modes` declares which values it actually renders; an
 *  off-list value is a usage fault (see `cli/format.ts`). */
const FLAG_FORMAT = {
  name: "format",
  type: "string",
  summary: "Output format: json|yaml (default json)",
} as const satisfies FlagDescriptor;
/** `--json`, the documented alias of `--format json`, kept beside `--format`
 *  for the readers that shipped it first. */
const FLAG_JSON_ALIAS = {
  name: "json",
  type: "boolean",
  summary: "Alias of --format json",
} as const satisfies FlagDescriptor;

/** The snapshot/live/timeout trio the plain viewer leaves share. */
export const VIEWER_FLAGS = [
  FLAG_SOCK,
  {
    name: "snapshot",
    type: "boolean",
    default: false,
    summary: "Force one current frame + exit (even on a TTY)",
  },
  {
    name: "watch",
    type: "boolean",
    default: false,
    summary: "Force the live stream even when piped (never exits)",
  },
  {
    name: "timeout",
    type: "string",
    summary:
      "Snapshot wait as a duration (~2s default; unit required, e.g. 500ms, 2s)",
  },
  FLAG_HELP_DEFAULTED,
] as const satisfies readonly FlagDescriptor[];

/** `keeper git` adds `--project-dir` to the viewer trio. */
export const GIT_FLAGS = [
  FLAG_SOCK,
  {
    name: "project-dir",
    type: "string",
    summary: "Repo whose git status to frame (default: cwd's root)",
  },
  {
    name: "snapshot",
    type: "boolean",
    default: false,
    summary: "Force one current frame + exit (even on a TTY)",
  },
  {
    name: "watch",
    type: "boolean",
    default: false,
    summary: "Force the live stream even when piped (never exits)",
  },
  {
    name: "timeout",
    type: "string",
    summary:
      "Snapshot wait as a duration (~2s default; unit required, e.g. 500ms, 2s)",
  },
  FLAG_HELP_DEFAULTED,
] as const satisfies readonly FlagDescriptor[];

/** `keeper autopilot` viewer flags (adds `--agent-help` + the worktree `--force`). */
export const AUTOPILOT_FLAGS = [
  FLAG_SOCK,
  {
    name: "snapshot",
    type: "boolean",
    default: false,
    summary: "Force one current frame + exit (even on a TTY)",
  },
  {
    name: "watch",
    type: "boolean",
    default: false,
    summary: "Force the live stream even when piped (never exits)",
  },
  {
    name: "timeout",
    type: "string",
    summary:
      "Snapshot wait as a duration (~2s default; unit required, e.g. 500ms, 2s)",
  },
  FLAG_HELP_DEFAULTED,
  FLAG_AGENT_HELP_DEFAULTED,
  {
    name: "force",
    type: "boolean",
    default: false,
    summary: "`worktree <on|off>`: bypass the mid-epic toggle guard",
  },
] as const satisfies readonly FlagDescriptor[];

/** `keeper dash` — socket + help only (TTY-only viewer). */
export const DASH_FLAGS = [
  FLAG_SOCK,
  FLAG_HELP_DEFAULTED,
] as const satisfies readonly FlagDescriptor[];

/**
 * `keeper frames` — the agent frame stream (ADR 0012). Its own flag grammar,
 * deliberately NOT the viewer snapshot trio (`--snapshot`/`--watch`/`--timeout`):
 * one invocation streams ONE `--view`, bounded by `--for` / `--max-frames` (or
 * `--follow` for the reconnect-forever alternate — mutually exclusive with the
 * two bounds). `--prev-frame` seeds the baseline diff against a prior chunk's
 * last frame; `--project-dir` scopes the git view.
 */
export const FRAMES_FLAGS = [
  {
    name: "view",
    type: "string",
    default: "board",
    summary:
      "Viewer to stream: board|jobs|git|autopilot|builds (default board)",
  },
  {
    name: "for",
    type: "string",
    summary: "Bounded-chunk duration, then a trailer + exit (e.g. 10s, 2m)",
  },
  {
    name: "max-frames",
    type: "string",
    summary: "Bounded-chunk data-frame count, then a trailer + exit",
  },
  {
    name: "follow",
    type: "boolean",
    default: false,
    summary:
      "Reconnect-forever stream (mutually exclusive with --for / --max-frames)",
  },
  {
    name: "prev-frame",
    type: "string",
    summary:
      "Prior chunk's last-frame file — render the baseline as a net diff against it",
  },
  {
    name: "project-dir",
    type: "string",
    summary: "--view git only: repo whose git status to frame",
  },
  FLAG_SOCK,
  FLAG_HELP_DEFAULTED,
  FLAG_AGENT_HELP_DEFAULTED,
] as const satisfies readonly FlagDescriptor[];

/** `keeper dispatch` flag surface. */
export const DISPATCH_FLAGS = [
  { name: "prompt", type: "string", summary: "Free-form prompt to launch" },
  {
    name: "prompt-file",
    type: "string",
    summary: "Read the prompt from a file",
  },
  {
    name: "name",
    type: "string",
    summary: "claude --name forwarded to the worker",
  },
  { name: "session", type: "string", summary: "Target tmux session" },
  {
    name: "cwd",
    type: "string",
    summary: "Working directory the worker launches in",
  },
  { name: "preset", type: "string", summary: "Launch-config preset name" },
  { name: "model", type: "string", summary: "Model override" },
  { name: "effort", type: "string", summary: "Reasoning-effort override" },
  {
    name: "force",
    type: "boolean",
    default: false,
    summary: "Bypass the race guard",
  },
  {
    name: "no-prefix",
    type: "boolean",
    default: false,
    summary: "Skip the configured dispatch_prompt_prefix",
  },
  {
    name: "dry-run",
    type: "boolean",
    default: false,
    summary: "Print the resolved plan; launch nothing",
  },
  FLAG_SOCK,
  FLAG_HELP_DEFAULTED,
  FLAG_AGENT_HELP_DEFAULTED,
] as const satisfies readonly FlagDescriptor[];

/** `keeper handoff` flag surface. */
export const HANDOFF_FLAGS = [
  {
    name: "slug",
    type: "string",
    summary: "Stable handoff slug (default: minted)",
  },
  { name: "prompt", type: "string", summary: "Free-form handoff prompt" },
  {
    name: "prompt-file",
    type: "string",
    summary: "Read the prompt from a file",
  },
  {
    name: "title",
    type: "string",
    summary: "Session title for the handoff-ee",
  },
  { name: "session", type: "string", summary: "Target tmux session" },
  {
    name: "cwd",
    type: "string",
    summary: "Directory the handoff-ee launches in",
  },
  {
    name: "capture",
    type: "boolean",
    default: false,
    summary: "Request a captured terminal result envelope at a durable path",
  },
  {
    name: "preset",
    type: "string",
    summary: "Launch triple <harness::model::effort> (--capture only)",
  },
  { name: "model", type: "string", summary: "Model override (--capture only)" },
  {
    name: "effort",
    type: "string",
    summary: "Reasoning-effort override (--capture only)",
  },
  FLAG_SOCK,
  FLAG_HELP_DEFAULTED,
  FLAG_AGENT_HELP_DEFAULTED,
] as const satisfies readonly FlagDescriptor[];

/** `keeper tabs list` flags. */
export const TABS_LIST_FLAGS = [
  { name: "db", type: "string", summary: "keeper.db path override" },
] as const satisfies readonly FlagDescriptor[];

/** `keeper tabs restore` flags. */
export const TABS_RESTORE_FLAGS = [
  {
    name: "apply",
    type: "boolean",
    default: false,
    summary: "Actually launch (default: print the plan)",
  },
  {
    name: "generation",
    type: "string",
    summary: "Disambiguate to one generation id",
  },
  {
    name: "session",
    type: "string",
    summary: "Restore into this tmux session",
  },
  {
    name: "allow-empty",
    type: "boolean",
    default: false,
    summary: "Permit a zero-candidate --apply",
  },
  {
    name: "force",
    type: "boolean",
    default: false,
    summary: "Restore while autopilot is unpaused",
  },
  { name: "db", type: "string", summary: "keeper.db path override" },
] as const satisfies readonly FlagDescriptor[];

/** `keeper tabs repair` flags. */
export const TABS_REPAIR_FLAGS = [
  { name: "db", type: "string", summary: "keeper.db path override" },
] as const satisfies readonly FlagDescriptor[];

/** `keeper tabs dump` flags. */
export const TABS_DUMP_FLAGS = [
  {
    name: "include-managed",
    type: "boolean",
    default: false,
    summary: "Include already-managed sessions",
  },
  { name: "session", type: "string", summary: "Scope to one tmux session" },
  { name: "db", type: "string", summary: "keeper.db path override" },
] as const satisfies readonly FlagDescriptor[];

const HISTORY_FORMAT_FLAGS = [
  {
    name: "format",
    type: "string",
    summary: "Output format: human|json (default human)",
  },
  FLAG_JSON_ALIAS,
] as const satisfies readonly FlagDescriptor[];

export const HISTORY_LIST_FLAGS = [
  FLAG_HELP,
  { name: "project", type: "string", summary: "Restrict to one project path" },
  { name: "harness", type: "string", summary: "claude|pi" },
  { name: "offset", type: "string", summary: "Result offset (default 0)" },
  { name: "limit", type: "string", summary: "Max sessions" },
  ...HISTORY_FORMAT_FLAGS,
] as const satisfies readonly FlagDescriptor[];

export const HISTORY_SHOW_FLAGS = [
  FLAG_HELP,
  {
    name: "project",
    type: "string",
    summary: "Restrict resolution to one project path",
  },
  {
    name: "artifact",
    type: "string",
    summary: "Pin one artifact when id/project are duplicated",
  },
  {
    name: "subagent",
    type: "string",
    summary: "Claude subagent id/prefix, or all",
  },
  { name: "offset", type: "string", summary: "Filtered entry offset" },
  {
    name: "before",
    type: "string",
    summary: "Page backward before this offset",
  },
  { name: "limit", type: "string", summary: "Max entries" },
  { name: "max-chars", type: "string", summary: "Total character budget" },
  {
    name: "max-entry-chars",
    type: "string",
    summary: "Per-entry character cap",
  },
  { name: "tools", type: "string", summary: "none|compact|full" },
  {
    name: "role",
    type: "string",
    multiple: true,
    summary: "Repeatable role filter",
  },
  { name: "since", type: "string", summary: "Entry at/after time" },
  { name: "until", type: "string", summary: "Entry at/before time" },
  { name: "grep", type: "string", summary: "Content filter" },
  {
    name: "meta",
    type: "boolean",
    summary: "Include injected meta/system entries",
  },
  { name: "thinking", type: "boolean", summary: "Include thinking blocks" },
  ...HISTORY_FORMAT_FLAGS,
] as const satisfies readonly FlagDescriptor[];

export const HISTORY_SEARCH_FLAGS = [
  FLAG_HELP,
  {
    name: "session",
    type: "string",
    summary: "Restrict to one Session reference",
  },
  { name: "project", type: "string", summary: "Restrict to one project path" },
  { name: "harness", type: "string", summary: "claude|pi" },
  {
    name: "role",
    type: "string",
    multiple: true,
    summary: "Repeatable role filter",
  },
  { name: "since", type: "string", summary: "Entry at/after time" },
  { name: "until", type: "string", summary: "Entry at/before time" },
  { name: "offset", type: "string", summary: "Result offset (default 0)" },
  { name: "limit", type: "string", summary: "Max hits" },
  { name: "syntax", type: "string", summary: "literal|fts (default literal)" },
  ...HISTORY_FORMAT_FLAGS,
] as const satisfies readonly FlagDescriptor[];

export const HISTORY_FILES_FLAGS = [
  FLAG_HELP,
  {
    name: "session",
    type: "string",
    summary: "Restrict to one Session reference",
  },
  { name: "mentions", type: "boolean", summary: "Include textual mentions" },
  { name: "offset", type: "string", summary: "Result offset (default 0)" },
  { name: "limit", type: "string", summary: "Max matches" },
  ...HISTORY_FORMAT_FLAGS,
] as const satisfies readonly FlagDescriptor[];

export const HISTORY_INDEX_FLAGS = [
  FLAG_HELP,
  ...HISTORY_FORMAT_FLAGS,
] as const satisfies readonly FlagDescriptor[];

export const RESUME_FLAGS = [
  FLAG_HELP,
  {
    name: "project",
    type: "string",
    summary: "Restrict resolution to one artifact-derived project",
  },
  {
    name: "format",
    type: "string",
    summary: "Decision/error format: human|json (default human)",
  },
  FLAG_JSON_ALIAS,
] as const satisfies readonly FlagDescriptor[];

// ── native command tree ──────────────────────────────────────────────────────

/**
 * The keeper-native command surface, authored in the canonical subcommand order
 * (`SUBCOMMANDS` is derived from this). Plan/prompt carry summary + top-level
 * metadata only: their verb sets are the plugin CLIs' own responsibility, sourced
 * live from `plugins/{plan,prompt}/src/descriptor.ts` at the `keeper --help --json`
 * and completion merge in `cli/keeper.ts` — never restated here, so a plugin verb
 * can never drift from a stale native copy. The native leaves carry their full
 * derived flag sets.
 */
export const NATIVE_COMMANDS: readonly CommandDescriptor[] = [
  {
    name: "board",
    summary: "Epics board (TTY: live TUI; non-TTY: one snapshot + exit)",
    visibility: "public",
    mutates: false,
    requires_daemon: true,
    requires_tty: false,
    flags: VIEWER_FLAGS,
  },
  {
    name: "jobs",
    summary:
      "Jobs list w/ dead-letter banner + 'r' replay (TTY: live; non-TTY: snapshot)",
    visibility: "public",
    mutates: false,
    requires_daemon: true,
    requires_tty: false,
    flags: VIEWER_FLAGS,
  },
  {
    name: "git",
    summary: "Git status frames (TTY: live TUI; non-TTY: one snapshot + exit)",
    visibility: "public",
    mutates: false,
    requires_daemon: true,
    requires_tty: false,
    flags: GIT_FLAGS,
  },
  {
    name: "autopilot",
    summary:
      "Dispatch log viewer (TTY: live TUI; non-TTY: one snapshot + exit)",
    visibility: "public",
    mutates: true,
    requires_daemon: true,
    requires_tty: false,
    agent_help: true,
    flags: AUTOPILOT_FLAGS,
    verbs: [
      {
        name: "pause",
        summary: "Pause the reconciler",
        visibility: "public",
        mutates: true,
        requires_daemon: true,
        requires_tty: false,
        flags: [],
      },
      {
        name: "play",
        summary: "Resume the reconciler",
        visibility: "public",
        mutates: true,
        requires_daemon: true,
        requires_tty: false,
        flags: [],
      },
      {
        name: "mode",
        summary: "Switch mode (yolo|armed)",
        visibility: "public",
        mutates: true,
        requires_daemon: true,
        requires_tty: false,
        flags: [],
      },
      {
        name: "config",
        summary: "Patch an autopilot config setting",
        visibility: "public",
        mutates: true,
        requires_daemon: true,
        requires_tty: false,
        flags: [],
      },
      {
        name: "arm",
        summary: "Arm an epic for dispatch",
        visibility: "public",
        mutates: true,
        requires_daemon: true,
        requires_tty: false,
        flags: [],
      },
      {
        name: "disarm",
        summary: "Disarm an epic",
        visibility: "public",
        mutates: true,
        requires_daemon: true,
        requires_tty: false,
        flags: [],
      },
      {
        name: "worktree",
        summary: "Toggle worktree mode <on|off>",
        visibility: "public",
        mutates: true,
        requires_daemon: true,
        requires_tty: false,
        flags: [],
      },
      {
        name: "retry",
        summary: "Retry a stuck dispatch failure",
        visibility: "public",
        mutates: true,
        requires_daemon: true,
        requires_tty: false,
        flags: [],
      },
    ],
  },
  {
    name: "builds",
    summary:
      "Buildbot status dashboard (TTY: live TUI; non-TTY: one snapshot + exit)",
    visibility: "public",
    mutates: false,
    requires_daemon: true,
    requires_tty: false,
    flags: VIEWER_FLAGS,
  },
  {
    name: "frames",
    summary:
      "Agent frame stream: bounded NDJSON envelopes per rendered viewer frame (one process per --view)",
    visibility: "public",
    mutates: false,
    requires_daemon: true,
    requires_tty: false,
    agent_help: true,
    exit_codes: {
      "0": "a trailer was emitted (idle zero-frame chunks included)",
      "1": "the daemon was never reachable (no frame ever rendered)",
    },
    flags: FRAMES_FLAGS,
  },
  {
    name: "dash",
    summary: "Read-only opening screen: header + PLAN + AGENTS (TTY-only)",
    visibility: "public",
    mutates: false,
    requires_daemon: true,
    requires_tty: true,
    flags: DASH_FLAGS,
  },
  {
    name: "status",
    summary:
      "One-shot unified board + autopilot JSON read (orient in one call)",
    visibility: "public",
    mutates: false,
    requires_daemon: true,
    requires_tty: false,
    format_modes: ["json", "yaml"],
    flags: [
      FLAG_HELP,
      FLAG_FORMAT,
      FLAG_JSON_ALIAS,
      FLAG_SOCK,
      {
        name: "connect-timeout",
        type: "string",
        summary: "Daemon connect timeout (duration, e.g. 30s, 5m)",
      },
    ],
  },
  {
    name: "daemon",
    summary: "Daemon lifecycle operations",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    flags: [],
    verbs: [
      {
        name: "restart",
        summary: "Restart keeperd and wait for a caught-up serve",
        visibility: "public",
        mutates: true,
        requires_daemon: false,
        requires_tty: false,
        flags: [
          FLAG_HELP,
          {
            name: "timeout",
            type: "string",
            summary: "Overall restart timeout (duration, e.g. 30s, 2m)",
          },
          FLAG_SOCK,
        ],
      },
    ],
  },
  {
    name: "query",
    summary: "One-shot read of an allowlisted daemon collection (JSON)",
    visibility: "public",
    mutates: false,
    requires_daemon: true,
    requires_tty: false,
    format_modes: ["json", "yaml"],
    flags: [
      FLAG_HELP,
      FLAG_FORMAT,
      FLAG_JSON_ALIAS,
      {
        name: "filter",
        type: "string",
        multiple: true,
        summary: "Repeatable key=value row filter",
      },
      FLAG_SOCK,
    ],
  },
  {
    name: "watch",
    summary: "NDJSON tail of coarse board deltas (never exits)",
    visibility: "public",
    mutates: false,
    requires_daemon: true,
    requires_tty: false,
    format_modes: ["json"],
    flags: [
      FLAG_HELP,
      FLAG_FORMAT,
      FLAG_JSON_ALIAS,
      FLAG_SOCK,
      {
        name: "filter",
        type: "string",
        multiple: true,
        summary: "Repeatable delta-kind filter",
      },
    ],
  },
  {
    name: "await",
    summary: "Block until a plan/git/job condition holds",
    visibility: "public",
    mutates: false,
    requires_daemon: true,
    requires_tty: false,
    agent_help: true,
    format_modes: ["human", "json"],
    exit_codes: {
      "3": "own-deadline timeout",
      "4": "watched target was deleted",
      "5": "stuck verdict (only under --fail-on-stuck)",
      "9": "--probe: evaluated cleanly, condition does not hold",
    },
    flags: [
      FLAG_HELP,
      FLAG_AGENT_HELP_DEFAULTED,
      {
        name: "durable",
        type: "boolean",
        summary:
          "Persist the await and return immediately; keeperd fires a fresh follow-up",
      },
      {
        name: "timeout",
        type: "string",
        summary: "Own-deadline before giving up (duration, e.g. 30s, 5m)",
      },
      {
        name: "connect-timeout",
        type: "string",
        summary: "Daemon connect timeout (duration, e.g. 30s, 5m)",
      },
      {
        name: "fail-on-stuck",
        type: "boolean",
        summary: "Exit 5 on a stuck verdict instead of waiting",
      },
      {
        name: "scope",
        type: "string",
        summary: "drained scope: plan (default) | inflight | board (strict)",
      },
      {
        name: "no-armed-line",
        type: "boolean",
        summary: "Suppress the initial armed line",
      },
      {
        name: "heartbeat",
        type: "string",
        summary:
          "Stderr progress interval naming holders (duration or 'off'; default 60s)",
      },
      {
        name: "require-transition",
        type: "boolean",
        summary:
          "Require an observed transition, not an already-true condition",
      },
      {
        name: "probe",
        type: "boolean",
        summary:
          "Evaluate once and exit (0 holds, 9 does not); rejects edge-triggered conditions",
      },
      { name: "json", type: "boolean", summary: "Emit the JSON envelope" },
      FLAG_SOCK,
    ],
    verbs: [
      {
        name: "cancel",
        summary:
          "Retire a waiting durable await by id (arming session, or --force override)",
        visibility: "public",
        mutates: true,
        requires_daemon: true,
        requires_tty: false,
        flags: [
          FLAG_HELP,
          {
            name: "force",
            type: "boolean",
            summary:
              "Operator override: cancel an await this session did not arm (audited)",
          },
          FLAG_SOCK,
        ],
      },
    ],
  },
  {
    name: "commit-work",
    summary: "Preview ownership, freeze exact files, lint, publish, push",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    agent_help: true,
    flags: [
      FLAG_HELP,
      FLAG_AGENT_HELP_DEFAULTED,
      {
        name: "preview-files",
        type: "boolean",
        summary: "Emit the explained dirty surface and exit (no commit)",
      },
      {
        name: "session-id",
        type: "string",
        summary: "Session id to attribute files for (default: auto-detect)",
      },
      {
        name: "adopt",
        type: "string",
        multiple: true,
        summary: "Adopt one exact dirty path for this invocation only",
      },
      {
        name: "adopt-from",
        type: "string",
        multiple: true,
        summary: "Read exact paths from a versioned JSON adoption manifest",
      },
      {
        name: "message-file",
        type: "string",
        summary: "Read the commit message as bounded inert file data",
      },
      {
        name: "task-id",
        type: "string",
        summary: "Append one validated Task trailer mechanically",
      },
      {
        name: "max-files",
        type: "string",
        summary: "Cap the selected file count (0 disables)",
      },
      {
        name: "allow-stale-unstage",
        type: "boolean",
        summary: "Restore ambient staged entries outside the selected set",
      },
      {
        name: "override-jam",
        type: "boolean",
        summary: "Proceed past a verified shared-checkout jam",
      },
      {
        name: "allow-mass-reversion",
        type: "boolean",
        summary: "Proceed with an inspected bulk reversion",
      },
    ],
  },
  {
    name: "baseline",
    summary:
      "Read the suite-baseline result at a commit (--wait triggers + blocks)",
    visibility: "public",
    mutates: false,
    requires_daemon: false,
    requires_tty: false,
    format_modes: ["json"],
    exit_codes: {
      "1": "bare read with no terminal result yet (miss / computing)",
      "2": "usage / arg fault, or an unresolvable sha/repo",
      "3": "--wait gave up at its deadline with no terminal envelope",
    },
    flags: [
      FLAG_HELP,
      {
        name: "repo",
        type: "string",
        summary: "Repo to resolve against (default: cwd's git root)",
      },
      {
        name: "wait",
        type: "boolean",
        summary:
          "Trigger-and-await: spool ONE request, then poll to the deadline",
      },
      {
        name: "timeout",
        type: "string",
        summary: "--wait deadline (duration, e.g. 10m, 600s)",
      },
      {
        name: "poll-interval",
        type: "string",
        summary: "--wait poll gap (duration, e.g. 1s, 500ms)",
      },
    ],
  },
  {
    name: "setup-tmux",
    summary: "Provision the tmux control plane (dash + work sessions)",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    flags: [
      {
        name: "kill-sessions",
        type: "boolean",
        default: false,
        summary: "Tear down existing keeper sessions first",
      },
      FLAG_HELP_DEFAULTED,
    ],
  },
  {
    name: "tabs",
    summary:
      "Restore keeper agents after a crash: `keeper tabs <list|restore|dump>`",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    agent_help: true,
    exit_codes: {
      "6": "restore refused a non-TTY AMBIGUOUS selection (ranked table on stderr)",
      "7": "restore --apply found ZERO candidates without --allow-empty",
      "8": "restore --apply had a PARTIAL launch failure",
    },
    flags: [],
    verbs: [
      {
        name: "list",
        summary: "JSON envelope of the per-generation summaries",
        visibility: "public",
        mutates: false,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["json"],
        flags: TABS_LIST_FLAGS,
      },
      {
        name: "restore",
        summary: "DRY-RUN the restore plan; `--apply` launches",
        visibility: "public",
        mutates: true,
        requires_daemon: false,
        requires_tty: false,
        flags: TABS_RESTORE_FLAGS,
      },
      {
        name: "repair",
        summary:
          "Report non-claude tabs whose recorded resume target rotted (read-only)",
        visibility: "public",
        mutates: false,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["json"],
        flags: TABS_REPAIR_FLAGS,
      },
      {
        name: "dump",
        summary: "Emit a runnable revive script for the CURRENT live set",
        visibility: "public",
        mutates: false,
        requires_daemon: false,
        requires_tty: false,
        flags: TABS_DUMP_FLAGS,
      },
    ],
  },
  {
    // The four job-backed reads share the Session catalog selector contract.
    // Their established `--session-id` spelling remains a compatibility alias
    // that enters the same resolver and has no id-only path.
    name: "session",
    summary: "Session-reference reads and identity-checked process termination",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    flags: [],
    verbs: [
      {
        name: "state",
        summary: "Session git context + on-hook files (JSON)",
        visibility: "public",
        mutates: false,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["json"],
        flags: [
          FLAG_HELP,
          {
            name: "session",
            type: "string",
            summary: "Shared Session reference (default: ambient auto-detect)",
          },
          {
            name: "session-id",
            type: "string",
            summary: "Compatibility alias of --session",
          },
          {
            name: "log-count",
            type: "string",
            summary: "Recent-commit count to include (positive int)",
          },
        ],
      },
      {
        name: "files",
        summary: "Session's on-hook dirty files grouped by repo (JSON)",
        visibility: "public",
        mutates: false,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["json"],
        flags: [
          FLAG_HELP,
          {
            name: "session",
            type: "string",
            summary: "Shared Session reference",
          },
          {
            name: "session-id",
            type: "string",
            summary: "Compatibility alias of --session",
          },
          {
            name: "cwd",
            type: "string",
            summary: "Working directory to attribute against",
          },
        ],
      },
      {
        name: "events",
        summary: "Prompt/tool-call spine for one Session (JSON)",
        visibility: "public",
        mutates: false,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["json"],
        flags: [
          FLAG_HELP,
          {
            name: "session",
            type: "string",
            summary: "Shared Session reference",
          },
          {
            name: "session-id",
            type: "string",
            summary: "Compatibility alias of --session",
          },
          {
            name: "limit",
            type: "string",
            summary: "Max events to return (positive int)",
          },
        ],
      },
      {
        name: "summary",
        summary:
          "Bounded one-shot summary of one tracked Session (title/prompts/counts)",
        visibility: "public",
        mutates: false,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["json"],
        flags: [
          FLAG_HELP,
          {
            name: "session",
            type: "string",
            summary: "Shared Session reference",
          },
          {
            name: "session-id",
            type: "string",
            summary: "Compatibility alias of --session",
          },
          {
            name: "max-snippet",
            type: "string",
            summary: "Per-prompt snippet cap in chars (positive int)",
          },
        ],
      },
      {
        name: "terminate",
        summary: "TERM-then-KILL an identity-confirmed non-working Session",
        visibility: "public",
        mutates: true,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["json"],
        flags: [FLAG_HELP],
      },
      {
        name: "release",
        summary:
          "Voluntarily release named paths so a blocked peer can adopt them",
        visibility: "public",
        mutates: true,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["json"],
        flags: [
          FLAG_HELP,
          {
            name: "session-id",
            type: "string",
            summary: "Releasing session identity (defaults to the env carrier)",
          },
        ],
      },
    ],
  },
  {
    name: "conversation",
    summary: "Offline native Claude↔Pi Session conversion",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    agent_help: true,
    format_modes: ["human", "json"],
    flags: [FLAG_HELP_DEFAULTED, FLAG_AGENT_HELP_DEFAULTED],
    verbs: [
      {
        name: "convert",
        summary: "Convert native Session files between Claude and Pi",
        visibility: "public",
        mutates: true,
        requires_daemon: false,
        requires_tty: false,
        agent_help: true,
        format_modes: ["human", "json"],
        flags: [
          FLAG_HELP_DEFAULTED,
          FLAG_AGENT_HELP_DEFAULTED,
          {
            name: "from",
            type: "string",
            summary: "Source harness: claude|pi",
          },
          {
            name: "to",
            type: "string",
            summary: "Target harness: pi|claude",
          },
          {
            name: "project",
            type: "string",
            summary: "Project path used to disambiguate a Session reference",
          },
          {
            name: "source-path",
            type: "string",
            summary:
              "Explicit source JSONL path instead of a Session reference",
          },
          {
            name: "config-dir",
            type: "string",
            multiple: true,
            summary: "Claude source config directory (repeatable)",
          },
          {
            name: "output-dir",
            type: "string",
            summary: "Target Pi agent dir or Claude config dir",
          },
          {
            name: "dry-run",
            type: "boolean",
            default: false,
            summary: "Prepare and validate without writing destination files",
          },
          {
            name: "format",
            type: "string",
            summary: "Output format: human|json (default human)",
          },
          FLAG_JSON_ALIAS,
        ],
      },
    ],
  },
  {
    name: "transcript",
    summary:
      "Specialist bounded transcripts by harness and shared Session reference",
    visibility: "public",
    mutates: false,
    requires_daemon: false,
    requires_tty: false,
    agent_help: true,
    format_modes: ["human", "json"],
    flags: [FLAG_HELP, FLAG_AGENT_HELP_DEFAULTED],
    verbs: [
      {
        name: "list",
        summary: "List transcript sessions (cwd-scoped by default)",
        visibility: "public",
        mutates: false,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["human", "json"],
        flags: [
          FLAG_HELP,
          {
            name: "project",
            type: "string",
            summary: "Project path (default: cwd)",
          },
          { name: "global", type: "boolean", summary: "Search every project" },
          {
            name: "config-dir",
            type: "string",
            multiple: true,
            summary: "Claude config directory (repeatable)",
          },
          { name: "since", type: "string", summary: "Updated at/after time" },
          { name: "until", type: "string", summary: "Updated at/before time" },
          {
            name: "offset",
            type: "string",
            summary: "Result offset (default 0)",
          },
          {
            name: "limit",
            type: "string",
            summary: "Max sessions (default 20)",
          },
          FLAG_FORMAT,
          FLAG_JSON_ALIAS,
        ],
      },
      {
        name: "show",
        summary:
          "Extract a bounded page by native id, job alias, or exact title",
        visibility: "public",
        mutates: false,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["human", "json"],
        flags: [
          FLAG_HELP,
          {
            name: "project",
            type: "string",
            summary: "Project path used to disambiguate the session",
          },
          {
            name: "config-dir",
            type: "string",
            multiple: true,
            summary: "Claude config directory (repeatable)",
          },
          {
            name: "subagent",
            type: "string",
            summary: "Subagent id/prefix, or all (default main)",
          },
          {
            name: "offset",
            type: "string",
            summary:
              "Filtered entry offset, matches a shown #N label (default: newest page)",
          },
          {
            name: "before",
            type: "string",
            summary:
              "Page backward before a filtered entry offset (a shown #N label)",
          },
          {
            name: "limit",
            type: "string",
            summary: "Max entries (default 60)",
          },
          {
            name: "max-chars",
            type: "string",
            summary: "Total character budget, header + entries (default 32000)",
          },
          {
            name: "max-entry-chars",
            type: "string",
            summary: "Per-entry character cap (default 6000)",
          },
          {
            name: "tools",
            type: "string",
            summary: "Tool detail: none|compact|full",
          },
          {
            name: "role",
            type: "string",
            multiple: true,
            summary: "Role filter",
          },
          { name: "since", type: "string", summary: "Entry at/after time" },
          { name: "until", type: "string", summary: "Entry at/before time" },
          { name: "grep", type: "string", summary: "Content filter" },
          {
            name: "meta",
            type: "boolean",
            summary: "Include harness-injected meta/system entries",
          },
          {
            name: "thinking",
            type: "boolean",
            summary: "Include thinking blocks",
          },
          FLAG_FORMAT,
          FLAG_JSON_ALIAS,
        ],
      },
      {
        name: "turn",
        summary:
          "Extract a Session reference's selected-branch Latest turn (pi only)",
        visibility: "public",
        mutates: false,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["json"],
        flags: [
          FLAG_HELP,
          {
            name: "leaf",
            type: "string",
            summary: "Entry id, or root — the tree leaf to resolve from",
          },
          {
            name: "project",
            type: "string",
            summary: "Project path used to disambiguate the session",
          },
          {
            name: "strip-skills",
            type: "boolean",
            summary:
              "Remove expanded skill envelopes before bounding prompt text",
          },
          FLAG_FORMAT,
          FLAG_JSON_ALIAS,
        ],
      },
    ],
  },
  {
    name: "history",
    summary:
      "Unified Claude/Pi session history: list, show, search, files, and index",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    format_modes: ["human", "json"],
    flags: [FLAG_HELP],
    verbs: [
      {
        name: "list",
        summary: "List cataloged sessions globally by default",
        visibility: "public",
        mutates: false,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["human", "json"],
        flags: HISTORY_LIST_FLAGS,
      },
      {
        name: "show",
        summary:
          "Resolve a Session reference and render a bounded transcript page",
        visibility: "public",
        mutates: false,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["human", "json"],
        flags: HISTORY_SHOW_FLAGS,
      },
      {
        name: "search",
        summary: "Refresh the private index and search transcript entries",
        visibility: "public",
        mutates: true,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["human", "json"],
        flags: HISTORY_SEARCH_FLAGS,
      },
      {
        name: "files",
        summary:
          "Refresh the private index and search provenance-graded file evidence",
        visibility: "public",
        mutates: true,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["human", "json"],
        flags: HISTORY_FILES_FLAGS,
      },
      {
        name: "index",
        summary:
          "Inspect, refresh, rebuild, or purge the private history index",
        visibility: "public",
        mutates: true,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["human", "json"],
        flags: HISTORY_INDEX_FLAGS,
      },
    ],
  },
  {
    name: "resume",
    summary: "Resolve a Claude/Pi Session and continue it in the foreground",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    format_modes: ["human", "json"],
    flags: RESUME_FLAGS,
  },
  {
    name: "show-job",
    summary:
      "One job by shared Session reference or orthogonal job/cwd/pane selectors (JSON)",
    visibility: "public",
    mutates: false,
    requires_daemon: false,
    requires_tty: false,
    format_modes: ["json"],
    flags: [
      FLAG_HELP,
      {
        name: "session",
        type: "string",
        summary: "Resolve a shared Session reference",
      },
      {
        name: "session-title",
        type: "string",
        summary: "Compatibility alias of --session",
      },
      {
        name: "job-id",
        type: "string",
        summary: "Exact job-only filter or Session-job narrowing filter",
      },
      { name: "cwd", type: "string", summary: "Match by working directory" },
      {
        name: "cwd-exact",
        type: "boolean",
        summary: "Require an exact --cwd match",
      },
      { name: "pane", type: "string", summary: "Match by tmux pane id" },
      {
        name: "latest",
        type: "boolean",
        summary: "Pick the most-recent job-only cwd/pane match",
      },
      { name: "raw", type: "boolean", summary: "Emit the raw row, unshaped" },
    ],
  },
  {
    name: "escalation-brief",
    summary:
      "Read-only context envelope an autopilot escalation session loads at boot (JSON)",
    visibility: "public",
    mutates: false,
    requires_daemon: false,
    requires_tty: false,
    format_modes: ["json"],
    flags: [FLAG_HELP],
  },
  {
    // Verbs OMITTED by design: `cli/keeper.ts` merges the live set from
    // `plugins/plan/src/descriptor.ts` for `--help --json` + completions.
    name: "plan",
    summary:
      "The plan CLI: `keeper plan <verb>` runs the plan dispatcher in-process",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    agent_help: true,
    flags: [],
  },
  {
    // Verbs OMITTED by design: merged from `plugins/prompt/src/descriptor.ts`.
    name: "prompt",
    summary:
      "Snippet/bundle substrate engine: `keeper prompt <verb>` runs the prompt CLI in-process",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    agent_help: true,
    flags: [],
  },
  {
    name: "projects",
    summary:
      "List keeper-root projects ranked from keeper.db activity and manifest metadata",
    visibility: "public",
    mutates: false,
    requires_daemon: false,
    requires_tty: false,
    format_modes: ["json"],
    flags: [],
    verbs: ["roots", "names", "ranked", "grouped", "descriptions"].map(
      nameOnlyVerb,
    ),
  },
  {
    name: "note",
    summary:
      "Capture, process, and browse private notes in an independent notes.db",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    flags: [],
    verbs: [
      {
        name: "new",
        summary: "Edit a new note, then save, copy, send, or discard it",
        visibility: "public",
        mutates: true,
        requires_daemon: false,
        requires_tty: true,
        flags: [
          FLAG_HELP,
          {
            name: "fresh",
            type: "boolean",
            summary: "Start the Note composer without the recovery picker",
          },
        ],
      },
      {
        name: "browse",
        summary: "Browse active notes and archived processing history in fzf",
        visibility: "public",
        mutates: true,
        requires_daemon: false,
        requires_tty: true,
        flags: [FLAG_HELP],
      },
      {
        name: "list",
        summary: "List note summaries as JSON",
        visibility: "public",
        mutates: false,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["json"],
        flags: [
          FLAG_HELP,
          {
            name: "state",
            type: "string",
            summary: "active, archived, or all (default: active)",
          },
        ],
      },
      {
        name: "show",
        summary: "Show one note as JSON, exact raw text, or a safe preview",
        visibility: "public",
        mutates: false,
        requires_daemon: false,
        requires_tty: false,
        format_modes: ["json", "human"],
        flags: [
          FLAG_HELP,
          {
            name: "raw",
            type: "boolean",
            summary: "Write the exact note body",
          },
          {
            name: "preview",
            type: "boolean",
            summary: "Write a terminal-safe body preview",
          },
        ],
      },
    ],
  },
  {
    name: "repo",
    summary: "Create, clone, and fork GitHub repos into configured roots",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    flags: [],
    verbs: ["create", "clone", "fork"].map(nameOnlyVerb),
  },
  {
    name: "dispatch",
    summary:
      "Manually fire one claude worker into a tmux window (client-side escape hatch)",
    visibility: "public",
    mutates: true,
    requires_daemon: true,
    requires_tty: false,
    agent_help: true,
    exit_codes: { "2": "argument fault (bad/conflicting flags)" },
    flags: DISPATCH_FLAGS,
  },
  {
    name: "handoff",
    summary:
      "Enqueue a fire-and-forget claude worker with a contextful brief (`keeper handoff show <id>` reads it)",
    visibility: "public",
    mutates: true,
    requires_daemon: true,
    requires_tty: false,
    agent_help: true,
    exit_codes: {
      "2": "argument fault (bad/conflicting flags, or a bad capture/triple combination)",
      "3": "slug already in use",
    },
    flags: HANDOFF_FLAGS,
  },
  {
    name: "agent",
    summary:
      "Launch an agent CLI: `keeper agent <claude|pi> [args...]` (folded keeper agent launcher)",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    agent_help: true,
    exit_codes: {
      "3": "agent providers resolve: a wrapped model has no configured provider in the matrix roster (no_route) — add a serving provider to ~/.config/keeper/matrix.yaml or correct the model token",
      "9": "agent providers check: one or more roster/host-triple/reachability drift findings (an unreachable provider binary, or a well-formed host launch triple outside the enumerable cube)",
      "124":
        "agent panel wait: chunk elapsed with no terminal answer — re-issue the wait (a signal, not a failure)",
    },
    flags: [],
    verbs: [
      ...[
        "claude",
        "pi",
        "run",
        "wait",
        "panel",
        "presets",
        "providers",
        "transcript",
      ].map(nameOnlyVerb),
      {
        name: "accounts",
        summary: "Inspect account routing and manage durable Fable focus",
        visibility: "public",
        mutates: true,
        requires_daemon: false,
        requires_tty: false,
        flags: [],
        verbs: [
          {
            name: "check",
            summary: "Report the read-only claude-swap routing snapshot",
            visibility: "public",
            mutates: false,
            requires_daemon: false,
            requires_tty: false,
            flags: [FLAG_JSON_ALIAS],
          },
          {
            name: "fable-focus",
            summary: "Show, set, or clear one durable Fable focus policy",
            visibility: "public",
            mutates: true,
            requires_daemon: true,
            requires_tty: false,
            flags: [FLAG_JSON_ALIAS],
            verbs: ["show", "set", "clear"].map(nameOnlyVerb),
          },
        ],
      },
    ],
  },
  {
    name: "reclaim",
    summary:
      "OFFLINE size-reclaim of the live keeper.db (daemon must be stopped)",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    agent_help: true,
    flags: [
      FLAG_HELP,
      {
        name: "agent-help",
        type: "boolean",
        summary: "Show the terse operator runbook",
      },
      {
        name: "dry-run",
        type: "boolean",
        summary: "Report the reclaim plan; write nothing",
      },
      { name: "db", type: "string", summary: "keeper.db path override" },
      FLAG_SOCK,
    ],
  },
  {
    name: "bus",
    summary: "Agent Bus: `keeper bus <list|resolve|chat send|watch>`",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    agent_help: true,
    flags: [],
    verbs: ["list", "watch", "wake", "chat"].map(nameOnlyVerb),
  },
  {
    name: "statusline",
    summary:
      "Render a Claude Code statusLine payload and coalesce its telemetry leaf",
    visibility: "internal",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    flags: [FLAG_HELP],
  },
  {
    name: "statusline-sink",
    summary:
      "Coalesce a Claude Code statusLine payload (stdin) into a per-session leaf",
    visibility: "internal",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    flags: [FLAG_HELP],
  },
  {
    name: "completions",
    summary:
      "Emit a shell completion script: `keeper completions <bash|zsh|fish>`",
    visibility: "public",
    mutates: false,
    requires_daemon: false,
    requires_tty: false,
    flags: [],
  },
];

/** A verb declared by name only (its own flag surface lands in a later ordinal
 *  or is dispatched by the leaf itself). */
function nameOnlyVerb(name: string): CommandDescriptor {
  return {
    name,
    summary: name,
    visibility: "public",
    mutates: false,
    requires_daemon: false,
    requires_tty: false,
    flags: [],
  };
}

// ── lookups ──────────────────────────────────────────────────────────────────

const BY_NAME: ReadonlyMap<string, CommandDescriptor> = new Map(
  NATIVE_COMMANDS.map((c) => [c.name, c]),
);

/** The one descriptor for a top-level native command, or `undefined`. */
export function nativeDescriptor(name: string): CommandDescriptor | undefined {
  return BY_NAME.get(name);
}

/**
 * The derived `parseArgs` options for a native leaf (or one of its verbs). The
 * single call each derived leaf makes so its parse surface IS its descriptor.
 * Throws on an unknown command/verb — a wiring bug, never a runtime input.
 */
export function parseOptions(
  command: string,
  verb?: string,
): Record<string, ParseOption> {
  const top = BY_NAME.get(command);
  if (top === undefined) {
    throw new Error(`descriptor: unknown native command '${command}'`);
  }
  if (verb === undefined) {
    return buildParseOptions(top.flags);
  }
  const v = top.verbs?.find((x) => x.name === verb);
  if (v === undefined) {
    throw new Error(`descriptor: unknown verb '${command} ${verb}'`);
  }
  return buildParseOptions(v.flags);
}
