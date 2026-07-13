/**
 * Passthrough detection — decides whether an invocation is a built-in
 * management subcommand (`mcp`, `plugin`, `auth`, Pi package commands, …) or
 * informational flag (`--help`, `--version`, `--list-models`, …) that must
 * bypass launch-session wrapper logic and exec the agent directly.
 *
 * The subcommand scan walks argv skipping global options, using three option-
 * value sets so a value that happens to spell a subcommand name (e.g.
 * `--model mcp`) is not mistaken for the subcommand. A 1:1 port of
 * `_find_passthrough_command` and the effort/model precedence helpers.
 */

/** Built-in claude subcommands that bypass the wrapper entirely. */
export const PASSTHROUGH_COMMANDS: ReadonlySet<string> = new Set([
  "agents",
  "auth",
  "doctor",
  "install",
  "mcp",
  "plugin",
  "plugins",
  "setup-token",
  "update",
  "upgrade",
]);

/** Built-in Pi package/config commands that bypass launch-session setup. */
export const PI_PASSTHROUGH_COMMANDS: ReadonlySet<string> = new Set([
  "config",
  "install",
  "list",
  "remove",
  "uninstall",
  "update",
]);

/**
 * Built-in Hermes management/info subcommands that bypass launch-session setup.
 * The interactive/one-shot launch is the bare invocation (`hermes [-z <prompt>]`),
 * NOT a subcommand — these are the non-interactive management verbs, so keeper
 * neither injects a model default nor applies the fresh-launch gate to them.
 */
export const HERMES_PASSTHROUGH_COMMANDS: ReadonlySet<string> = new Set([
  "auth",
  "backup",
  "checkpoints",
  "config",
  "cron",
  "doctor",
  "debug",
  "dump",
  "hooks",
  "import",
  "login",
  "logout",
  "mcp",
  "model",
  "plugins",
  "profile",
  "secrets",
  "security",
  "sessions",
  "setup",
  "skills",
  "status",
  "uninstall",
  "update",
  "version",
]);

/** Options whose next token is always a value (consume two). */
export const CLAUDE_OPTIONS_WITH_REQUIRED_VALUE: ReadonlySet<string> = new Set([
  "--add-dir",
  "--agent",
  "--agents",
  "--allowedTools",
  "--allowed-tools",
  "--append-system-prompt",
  "--betas",
  "--debug-file",
  "--disallowedTools",
  "--disallowed-tools",
  "--effort",
  "--fallback-model",
  "--file",
  "--input-format",
  "--json-schema",
  "--max-budget-usd",
  "--mcp-config",
  "--model",
  "-n",
  "--name",
  "--output-format",
  "--permission-mode",
  "--plugin-dir",
  "--session-id",
  "--setting-sources",
  "--settings",
  "--system-prompt",
  "--tools",
]);

/** Options whose next token MAY be a value (consume two only if value-shaped). */
export const CLAUDE_OPTIONS_WITH_OPTIONAL_VALUE: ReadonlySet<string> = new Set([
  "-d",
  "--debug",
  "--fork-session",
  "--from-pr",
  "-r",
  "--resume",
  "--tmux",
  "-w",
  "--worktree",
]);

/** Pi options whose next token is always a value. */
export const PI_OPTIONS_WITH_REQUIRED_VALUE: ReadonlySet<string> = new Set([
  "--api-key",
  "--append-system-prompt",
  "--exclude-tools",
  "-e",
  "--extension",
  "--export",
  "--fork",
  "--mode",
  "--model",
  "--models",
  "-n",
  "--name",
  "--prompt-template",
  "--provider",
  "--session",
  "--session-dir",
  "--session-id",
  "--skill",
  "--system-prompt",
  "--theme",
  "--thinking",
  "-t",
  "--tools",
  "-xt",
]);

/** Pi options whose next token may be a value. */
export const PI_OPTIONS_WITH_OPTIONAL_VALUE: ReadonlySet<string> = new Set([
  "-p",
  "--print",
  "--list-models",
]);

/** Hermes global options whose next token is always a value. */
export const HERMES_OPTIONS_WITH_REQUIRED_VALUE: ReadonlySet<string> = new Set([
  "-z",
  "--oneshot",
  "-m",
  "--model",
  "--provider",
  "-t",
  "--toolsets",
  "--resume",
  "-r",
  "--skills",
]);

/** Hermes options whose next token MAY be a value (`--continue`/`-c` take an
 *  optional session name). */
export const HERMES_OPTIONS_WITH_OPTIONAL_VALUE: ReadonlySet<string> = new Set([
  "--continue",
  "-c",
]);

/**
 * Detect a built-in claude subcommand after global options, or null. Walks
 * argv: an option with `=` consumes one token; a required-value option consumes
 * two; an optional-value option consumes two only when the next token is itself
 * value-shaped (not flag-like, not a subcommand name); a bare `--` stops the
 * scan. The first non-option token decides: a known subcommand returns its
 * name, anything else returns null.
 */
export function findPassthroughCommand(args: string[]): string | null {
  return findAgentPassthroughCommand(
    args,
    PASSTHROUGH_COMMANDS,
    CLAUDE_OPTIONS_WITH_REQUIRED_VALUE,
    CLAUDE_OPTIONS_WITH_OPTIONAL_VALUE,
  );
}

/** Detect a built-in Pi package/config command after global options. */
export function findPiPassthroughCommand(args: string[]): string | null {
  return findAgentPassthroughCommand(
    args,
    PI_PASSTHROUGH_COMMANDS,
    PI_OPTIONS_WITH_REQUIRED_VALUE,
    PI_OPTIONS_WITH_OPTIONAL_VALUE,
    true,
  );
}

/** Detect a built-in Hermes management/info command after global options. */
export function findHermesPassthroughCommand(args: string[]): string | null {
  return findAgentPassthroughCommand(
    args,
    HERMES_PASSTHROUGH_COMMANDS,
    HERMES_OPTIONS_WITH_REQUIRED_VALUE,
    HERMES_OPTIONS_WITH_OPTIONAL_VALUE,
    true,
  );
}

function findAgentPassthroughCommand(
  args: string[],
  commands: ReadonlySet<string>,
  requiredValueOptions: ReadonlySet<string>,
  optionalValueOptions: ReadonlySet<string>,
  optionalValuesMayBeCommands = false,
): string | null {
  let idx = 0;
  while (idx < args.length) {
    const arg = args[idx] as string;
    if (arg === "--") {
      return null;
    }

    if (arg.startsWith("-") && arg !== "-") {
      if (arg.includes("=")) {
        idx += 1;
        continue;
      }

      if (requiredValueOptions.has(arg)) {
        idx += 2;
        continue;
      }

      if (optionalValueOptions.has(arg)) {
        if (idx + 1 < args.length) {
          const nextArg = args[idx + 1] as string;
          if (
            !nextArg.startsWith("-") &&
            (optionalValuesMayBeCommands || !commands.has(nextArg))
          ) {
            idx += 2;
            continue;
          }
        }
        idx += 1;
        continue;
      }

      idx += 1;
      continue;
    }

    if (commands.has(arg)) {
      return arg;
    }
    return null;
  }

  return null;
}

/** True iff `--effort` (split or joined) appears before a bare `--`. */
export function hasExplicitEffortArg(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") {
      return false;
    }
    if (arg === "--effort" || arg.startsWith("--effort=")) {
      return true;
    }
  }
  return false;
}

/**
 * The wrapper-owned effort override, or null to leave it to the caller.
 * Precedence: an explicit `--effort` or a non-empty `CLAUDE_CODE_EFFORT_LEVEL`
 * env var wins (return null); otherwise the configured default applies (itself
 * null when unset).
 */
export function resolveStartupEffortOverride(
  args: string[],
  defaultEffort: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (hasExplicitEffortArg(args)) {
    return null;
  }
  if ((env.CLAUDE_CODE_EFFORT_LEVEL ?? "").trim()) {
    return null;
  }
  return defaultEffort;
}

/** True iff `--model` (split or joined) appears before a bare `--`. */
export function hasExplicitModelArg(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") {
      return false;
    }
    if (arg === "--model" || arg.startsWith("--model=")) {
      return true;
    }
  }
  return false;
}

/** True iff `-m`/`--model` (split or joined) appears before a bare `--`. */
export function hasExplicitShortModelArg(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") {
      return false;
    }
    if (arg === "-m" || arg === "--model" || arg.startsWith("--model=")) {
      return true;
    }
  }
  return false;
}

/** True iff `--thinking` (split or joined) appears before a bare `--`. */
export function hasExplicitThinkingArg(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") {
      return false;
    }
    if (arg === "--thinking" || arg.startsWith("--thinking=")) {
      return true;
    }
  }
  return false;
}

/**
 * The model override, or null to leave it to the caller. An explicit `--model`
 * wins (return null); otherwise the configured default applies (itself null
 * when unset).
 */
export function resolveStartupModelOverride(
  args: string[],
  defaultModel: string | null,
): string | null {
  if (hasExplicitModelArg(args)) {
    return null;
  }
  return defaultModel;
}

/** The Pi thinking override, or null when explicit/already unset. */
export function resolveStartupThinkingOverride(
  args: string[],
  defaultThinking: string | null,
): string | null {
  if (hasExplicitThinkingArg(args)) {
    return null;
  }
  return defaultThinking;
}

/** Pi thinking tokens valid as a `--model <id>:<thinking>` shorthand suffix. */
const PI_THINKING_TOKENS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

/** The value of `--model x` (split) or `--model=x` (joined) before a bare `--`. */
function piModelArgValue(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      return null;
    }
    if (arg === "--model") {
      return args[i + 1] ?? null;
    }
    if (arg.startsWith("--model=")) {
      return arg.slice("--model=".length);
    }
  }
  return null;
}

/**
 * The pi thinking level embedded in a `--model <id>:<thinking>` shorthand, or
 * null. pi parses the trailing `:<token>` off its OWN `--model`, so when the
 * suffix after the LAST `:` is a valid thinking token keeper treats thinking as
 * caller-supplied — it satisfies the both-explicit escape from the fresh-launch
 * default gate AND suppresses the default `--thinking` injection (pi would reject
 * a conflicting flag). A colon-less model, an empty id, or a non-token suffix
 * yields null.
 */
export function piModelColonThinking(args: string[]): string | null {
  const model = piModelArgValue(args);
  if (model === null) {
    return null;
  }
  const idx = model.lastIndexOf(":");
  if (idx <= 0 || idx === model.length - 1) {
    return null;
  }
  const suffix = model.slice(idx + 1);
  return PI_THINKING_TOKENS.has(suffix) ? suffix : null;
}
