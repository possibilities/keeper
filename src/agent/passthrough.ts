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

/** Built-in Codex subcommands that bypass launch-session wrapper setup. */
export const CODEX_PASSTHROUGH_COMMANDS: ReadonlySet<string> = new Set([
  "app",
  "app-server",
  "apply",
  "archive",
  "cloud",
  "completion",
  "debug",
  "delete",
  "doctor",
  "features",
  "help",
  "login",
  "logout",
  "mcp",
  "mcp-server",
  "plugin",
  "remote-control",
  "sandbox",
  "unarchive",
  "update",
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

/** Codex global options whose next token is always a value. */
export const CODEX_OPTIONS_WITH_REQUIRED_VALUE: ReadonlySet<string> = new Set([
  "-a",
  "--add-dir",
  "--ask-for-approval",
  "-c",
  "-C",
  "--cd",
  "--color",
  "--config",
  "--disable",
  "--enable",
  "-i",
  "--image",
  "--local-provider",
  "-m",
  "--model",
  "-o",
  "--output-last-message",
  "--output-schema",
  "-p",
  "--profile",
  "--remote",
  "--remote-auth-token-env",
  "-s",
  "--sandbox",
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

/** Detect a built-in Codex management subcommand after global options. */
export function findCodexPassthroughCommand(args: string[]): string | null {
  return findAgentPassthroughCommand(
    args,
    CODEX_PASSTHROUGH_COMMANDS,
    CODEX_OPTIONS_WITH_REQUIRED_VALUE,
    new Set(),
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
export function hasExplicitCodexModelArg(args: string[]): boolean {
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

/** True iff `-p`/`--profile` (split or joined) appears before a bare `--`. */
export function hasExplicitCodexProfileArg(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") {
      return false;
    }
    if (arg === "-p" || arg === "--profile" || arg.startsWith("--profile=")) {
      return true;
    }
  }
  return false;
}

/** True iff Codex reasoning effort is explicitly set through `-c/--config`. */
export function hasExplicitCodexEffortArg(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      return false;
    }
    if (arg === "-c" || arg === "--config") {
      const value = args[i + 1] ?? "";
      if (isCodexEffortConfig(value)) {
        return true;
      }
      i += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      if (isCodexEffortConfig(arg.slice("--config=".length))) {
        return true;
      }
    }
  }
  return false;
}

function isCodexEffortConfig(value: string): boolean {
  return value.trim().startsWith("model_reasoning_effort=");
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
