export type CodexResetNamedKey = "Down" | "Enter";

/** Terminal operations needed by the reset flow. Implementations own all timing. */
export interface CodexResetTerminal {
  start(): Promise<void>;
  capture(timeoutMs: number): Promise<string>;
  wait(ms: number): Promise<void>;
  sendLiteral(text: string): Promise<void>;
  sendKey(key: CodexResetNamedKey): Promise<void>;
  close(): Promise<void>;
}

export interface CodexUsageMenu {
  readonly selected: 1 | 2;
  readonly availability:
    | "You have 1 usage limit reset available."
    | "Check reset availability.";
}

export interface CodexResetMenu {
  readonly selected: 1 | 2;
  readonly expires: string;
}

export type CodexResetPreSubmitStage =
  | "start"
  | "open-usage"
  | "first-menu"
  | "select-redeem"
  | "redeem-menu"
  | "select-full-reset"
  | "revalidate-full-reset"
  | "before-final-enter";

export type CodexResetOutcome =
  | {
      readonly kind: "pre-submit-failure";
      readonly stage: CodexResetPreSubmitStage;
      readonly error: unknown;
    }
  | { readonly kind: "submitted" }
  | { readonly kind: "submitted-rejected"; readonly message: string }
  | { readonly kind: "final-enter-uncertain"; readonly error: unknown };

export interface RunCodexResetOptions {
  /** Total bound for each menu or post-submit screen. */
  readonly captureTimeoutMs?: number;
  /** Delay between bounded pane captures while a menu has not rendered. */
  readonly capturePollMs?: number;
  /** Potentially slow timing/provider preparation, before final menu recapture. */
  readonly prepareFinalEnter?: () => void | Promise<void>;
}

const USAGE_DESCRIPTION = "View account usage or redeem an earned reset.";
const SHOW_USAGE_ROW =
  "1. Show usage                View recent account token usage.";
const REDEEM_PREFIX = "2. Redeem usage limit reset  ";
const ACCEPTED_REDEEM_SUFFIXES = [
  "You have 1 usage limit reset available.",
  "Check reset availability.",
] as const;
const RESET_AVAILABILITY = "1 usage limit reset available.";
const CANCEL_ROW = "1. Cancel";
const FULL_RESET_PREFIX = "2. Full reset  Expires ";

interface ParsedChoice {
  readonly selected: boolean;
  readonly body: string;
}

function normalizedLines(screen: string): string[] {
  return screen
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""));
}

function unindentExact(line: string, expected: string): boolean {
  return line.replace(/^[ \t]*/u, "") === expected;
}

function isIndentedBlank(line: string): boolean {
  return line.replace(/[ \t]/gu, "") === "";
}

function parseChoice(line: string): ParsedChoice | null {
  const withoutIndent = line.replace(/^[ \t]*/u, "");
  if (withoutIndent.startsWith("› ")) {
    return { selected: true, body: withoutIndent.slice(2) };
  }
  if (/^\d+\./u.test(withoutIndent)) {
    return { selected: false, body: withoutIndent };
  }
  return null;
}

function numberedChoicesAfter(
  lines: readonly string[],
  heading: number,
): ParsedChoice[] {
  const choices: ParsedChoice[] = [];
  for (let i = heading + 1; i < lines.length; i += 1) {
    const choice = parseChoice(lines[i] ?? "");
    if (choice !== null) choices.push(choice);
  }
  return choices;
}

function parserFailure(menu: string): never {
  throw new Error(`unrecognized or ambiguous ${menu}`);
}

/**
 * Parse the first observed Codex /usage menu. No fuzzy labels, whitespace
 * collapsing, suffix inference, or selection inference is performed.
 */
export function parseCodexUsageMenu(screen: string): CodexUsageMenu {
  const lines = normalizedLines(screen);
  const matches: CodexUsageMenu[] = [];

  for (let i = 0; i + 4 < lines.length; i += 1) {
    if (!unindentExact(lines[i] ?? "", "Usage")) continue;
    if (!unindentExact(lines[i + 1] ?? "", USAGE_DESCRIPTION)) continue;
    if (!isIndentedBlank(lines[i + 2] ?? "")) continue;

    const first = parseChoice(lines[i + 3] ?? "");
    const second = parseChoice(lines[i + 4] ?? "");
    if (first?.body !== SHOW_USAGE_ROW || second === null) continue;
    if (!second.body.startsWith(REDEEM_PREFIX)) continue;
    const suffix = second.body.slice(REDEEM_PREFIX.length);
    if (
      suffix !== ACCEPTED_REDEEM_SUFFIXES[0] &&
      suffix !== ACCEPTED_REDEEM_SUFFIXES[1]
    ) {
      continue;
    }

    const choices = numberedChoicesAfter(lines, i);
    if (choices.length !== 2) continue;
    if (
      choices[0]?.body !== first.body ||
      choices[1]?.body !== second.body ||
      first.selected === second.selected
    ) {
      continue;
    }
    matches.push({
      selected: first.selected ? 1 : 2,
      availability: suffix,
    });
  }

  const relevantRows = lines
    .map(parseChoice)
    .filter(
      (choice): choice is ParsedChoice =>
        choice !== null &&
        (choice.body === SHOW_USAGE_ROW ||
          choice.body.startsWith(REDEEM_PREFIX)),
    );
  if (matches.length !== 1 || relevantRows.length !== 2) {
    return parserFailure("Codex usage menu");
  }
  return matches[0] as CodexUsageMenu;
}

/** Parse the reset confirmation menu, including its exact one-reset invariant. */
export function parseCodexResetMenu(screen: string): CodexResetMenu {
  const lines = normalizedLines(screen);
  const matches: CodexResetMenu[] = [];

  for (let i = 0; i + 4 < lines.length; i += 1) {
    if (!unindentExact(lines[i] ?? "", "Usage limit resets")) continue;
    if (!unindentExact(lines[i + 1] ?? "", RESET_AVAILABILITY)) continue;
    if (!isIndentedBlank(lines[i + 2] ?? "")) continue;

    const first = parseChoice(lines[i + 3] ?? "");
    const second = parseChoice(lines[i + 4] ?? "");
    if (first?.body !== CANCEL_ROW || second === null) continue;
    if (!second.body.startsWith(FULL_RESET_PREFIX)) continue;
    const expires = second.body.slice(FULL_RESET_PREFIX.length);
    if (expires === "") continue;

    const choices = numberedChoicesAfter(lines, i);
    if (choices.length !== 2) continue;
    if (
      choices[0]?.body !== first.body ||
      choices[1]?.body !== second.body ||
      first.selected === second.selected
    ) {
      continue;
    }
    matches.push({ selected: first.selected ? 1 : 2, expires });
  }

  const relevantRows = lines
    .map(parseChoice)
    .filter(
      (choice): choice is ParsedChoice =>
        choice !== null &&
        (choice.body === CANCEL_ROW || choice.body.startsWith("2. Full reset")),
    );
  if (matches.length !== 1 || relevantRows.length !== 2) {
    return parserFailure("Codex reset menu");
  }
  return matches[0] as CodexResetMenu;
}

function requireSelection(actual: 1 | 2, expected: 1 | 2, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} must have option ${expected} selected`);
  }
}

function hasExactLine(screen: string, expected: string): boolean {
  return normalizedLines(screen).some((line) => unindentExact(line, expected));
}

async function waitForParsedMenu<T>(input: {
  terminal: CodexResetTerminal;
  timeoutMs: number;
  pollMs: number;
  parse: (screen: string) => T;
  relevant: (screen: string) => boolean;
  label: string;
}): Promise<T> {
  let remainingMs = input.timeoutMs;
  let lastError: unknown;
  let lastRelevantScreen: string | null = null;
  while (remainingMs > 0) {
    const delay = Math.min(input.pollMs, remainingMs);
    await input.terminal.wait(delay);
    remainingMs -= delay;
    const screen = await input.terminal.capture(input.timeoutMs);
    try {
      return input.parse(screen);
    } catch (error) {
      lastError = error;
      // A target menu that is malformed in two identical captures is a stable
      // format change or ambiguity. One partial render gets a single retry.
      if (input.relevant(screen)) {
        if (screen === lastRelevantScreen) throw error;
        lastRelevantScreen = screen;
      } else {
        lastRelevantScreen = null;
      }
    }
  }
  throw new Error(`${input.label} did not appear before its deadline`, {
    cause: lastError,
  });
}

type PostSubmitResult =
  | { readonly kind: "confirmed" }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "unknown"; readonly error?: unknown };

const POST_SUBMIT_REJECTIONS = [
  "Couldn't reset usage. Please try again.",
  "Your usage does not need a reset right now.",
  "That reset is no longer available.",
  "No usage limit resets are available.",
] as const;

async function waitAfterFinalEnter(
  terminal: CodexResetTerminal,
  timeoutMs: number,
  pollMs: number,
): Promise<PostSubmitResult> {
  let remainingMs = timeoutMs;
  while (remainingMs > 0) {
    const delay = Math.min(pollMs, remainingMs);
    await terminal.wait(delay);
    remainingMs -= delay;
    let screen: string;
    try {
      screen = await terminal.capture(timeoutMs);
    } catch (error) {
      // Keep the owned pane alive for the remainder of the processing grace.
      // A capture transport fault must not make cleanup race the queued Enter.
      if (remainingMs > 0) await terminal.wait(remainingMs);
      return { kind: "unknown", error };
    }
    if (hasExactLine(screen, "Usage reset.")) {
      return { kind: "confirmed" };
    }
    for (const message of POST_SUBMIT_REJECTIONS) {
      if (hasExactLine(screen, message)) {
        return { kind: "rejected", message };
      }
    }
  }
  return {
    kind: "unknown",
    error: new Error("Codex did not render a recognized post-submit result"),
  };
}

/**
 * Execute the strict, one-way reset flow. The final Enter has its own outcome:
 * transport failure is uncertain and is never retried.
 */
export async function runCodexResetTui(
  terminal: CodexResetTerminal,
  beforeFinalEnter: () => void | Promise<void>,
  options: RunCodexResetOptions = {},
): Promise<CodexResetOutcome> {
  const captureTimeoutMs = options.captureTimeoutMs ?? 10_000;
  const capturePollMs = options.capturePollMs ?? 250;
  if (
    !Number.isFinite(captureTimeoutMs) ||
    captureTimeoutMs <= 0 ||
    !Number.isFinite(capturePollMs) ||
    capturePollMs <= 0
  ) {
    return {
      kind: "pre-submit-failure",
      stage: "start",
      error: new Error("captureTimeoutMs and capturePollMs must be positive"),
    };
  }

  let outcome: CodexResetOutcome;
  let stage: CodexResetPreSubmitStage = "start";
  let started = false;
  try {
    await terminal.start();
    started = true;

    stage = "open-usage";
    await terminal.sendLiteral("/usage");
    await terminal.sendKey("Enter");

    stage = "first-menu";
    const initialUsage = await waitForParsedMenu({
      terminal,
      timeoutMs: captureTimeoutMs,
      pollMs: capturePollMs,
      parse: parseCodexUsageMenu,
      relevant: (screen) =>
        hasExactLine(screen, "Usage") ||
        screen.includes("Redeem usage limit reset"),
      label: "Codex usage menu",
    });
    requireSelection(initialUsage.selected, 1, "initial usage menu");

    stage = "select-redeem";
    await terminal.sendKey("Down");
    const selectedUsage = await waitForParsedMenu({
      terminal,
      timeoutMs: captureTimeoutMs,
      pollMs: capturePollMs,
      parse: parseCodexUsageMenu,
      relevant: (screen) =>
        hasExactLine(screen, "Usage") ||
        screen.includes("Redeem usage limit reset"),
      label: "selected Codex usage menu",
    });
    requireSelection(selectedUsage.selected, 2, "usage menu after Down");
    if (selectedUsage.availability !== initialUsage.availability) {
      throw new Error("usage menu changed while selecting redeem");
    }
    await terminal.sendKey("Enter");

    stage = "redeem-menu";
    const initialReset = await waitForParsedMenu({
      terminal,
      timeoutMs: captureTimeoutMs,
      pollMs: capturePollMs,
      parse: parseCodexResetMenu,
      relevant: (screen) =>
        hasExactLine(screen, "Usage limit resets") ||
        screen.includes("Full reset"),
      label: "Codex Full reset menu",
    });
    requireSelection(initialReset.selected, 1, "initial reset menu");

    stage = "select-full-reset";
    await terminal.sendKey("Down");
    const selectedReset = await waitForParsedMenu({
      terminal,
      timeoutMs: captureTimeoutMs,
      pollMs: capturePollMs,
      parse: parseCodexResetMenu,
      relevant: (screen) =>
        hasExactLine(screen, "Usage limit resets") ||
        screen.includes("Full reset"),
      label: "selected Codex Full reset menu",
    });
    requireSelection(selectedReset.selected, 2, "reset menu after Down");
    if (selectedReset.expires !== initialReset.expires) {
      throw new Error("reset menu changed while selecting full reset");
    }

    await options.prepareFinalEnter?.();
    stage = "revalidate-full-reset";
    const finalReset = await waitForParsedMenu({
      terminal,
      timeoutMs: captureTimeoutMs,
      pollMs: capturePollMs,
      parse: parseCodexResetMenu,
      relevant: (screen) =>
        hasExactLine(screen, "Usage limit resets") ||
        screen.includes("Full reset"),
      label: "final selected Codex Full reset menu",
    });
    requireSelection(finalReset.selected, 2, "reset menu before final Enter");
    if (finalReset.expires !== initialReset.expires) {
      throw new Error("reset menu changed before final Enter");
    }

    stage = "before-final-enter";
    await beforeFinalEnter();
    try {
      await terminal.sendKey("Enter");
      // Keep the owned pane alive long enough for Codex to process the queued
      // key and render a terminal result. Confirmation remains the caller's
      // normalized-data responsibility; this wait never retries Enter.
      const postSubmit = await waitAfterFinalEnter(
        terminal,
        captureTimeoutMs,
        capturePollMs,
      );
      outcome =
        postSubmit.kind === "confirmed"
          ? { kind: "submitted" }
          : postSubmit.kind === "rejected"
            ? { kind: "submitted-rejected", message: postSubmit.message }
            : {
                kind: "final-enter-uncertain",
                error:
                  postSubmit.error ??
                  new Error("Codex post-submit result was not recognized"),
              };
    } catch (error) {
      outcome = { kind: "final-enter-uncertain", error };
    }
  } catch (error) {
    outcome = { kind: "pre-submit-failure", stage, error };
  }

  if (started) {
    try {
      await terminal.close();
    } catch (error) {
      if (outcome.kind === "pre-submit-failure") {
        outcome = {
          ...outcome,
          error: new AggregateError(
            [outcome.error, error],
            "reset flow and cleanup failed",
          ),
        };
      }
    }
  }
  return outcome;
}
