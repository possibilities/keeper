import { Temporal } from "@js-temporal/polyfill";
import { codexDateResetAt, codexTodayResetAt } from "./reset-time";

/**
 * Parse the rendered codex /status panel into structured data.
 *
 * Strict by design: any divergence from the observed TUI format throws so we
 * notice when codex updates the panel rather than silently writing stale or
 * partial data.
 *
 * Codex displays reset times in the user's local timezone (24h clock, no
 * label). We resolve against `now`'s own zone at parse time. The optional
 * Codex-Spark section is emitted as `codex_spark_session` + `codex_spark_week`.
 */

/** Thrown when the /status panel doesn't match the expected shape. */
export class CodexStatusParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexStatusParseError";
  }
}

/** One parsed limit window. Codex always renders a reset clock (never null). */
export interface UsageWindow {
  percent_used: number;
  resets_at: string;
}

/** The parse result: primary session/week plus optional Codex-Spark windows. */
export interface CodexUsage {
  session: UsageWindow;
  week: UsageWindow;
  codex_spark_session?: UsageWindow;
  codex_spark_week?: UsageWindow;
}

export const PANEL_SENTINEL = "5h limit:";
export const SPARK_SENTINEL = "Codex-Spark limit:";

// Both rows render percent-left plus a reset clock whose date suffix is
// optional: codex emits `resets HH:MM` or `resets HH:MM on DD Mon` on either
// the 5h or the weekly row. Date-less values resolve via today/tomorrow,
// date-bearing values via this-year/next-year. `.` never crosses a newline
// (no `s` flag), so each row match stays on its own line.
const RESET_SUFFIX = String.raw`(\d+)%\s+left\s+\(resets\s+(\d{1,2}):(\d{2})(?:\s+on\s+(\d{1,2})\s+([A-Za-z]+))?\)`;
const FIVE_HOUR_RE = new RegExp(`5h limit:.*?${RESET_SUFFIX}`);
const WEEKLY_RE = new RegExp(`Weekly limit:.*?${RESET_SUFFIX}`);

const MONTHS: Record<string, number> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

/** Month name to 1-based number (first-three-letter, title-cased), throwing on unknown. */
function resolveMonth(monthName: string): number {
  const first = monthName.length === 0 ? "" : monthName[0].toUpperCase();
  const mon = (first + monthName.slice(1).toLowerCase()).slice(0, 3);
  const num = MONTHS[mon];
  if (num === undefined) {
    throw new CodexStatusParseError(`unknown month '${monthName}'`);
  }
  return num;
}

/**
 * Parse one limit row's percent-left and reset suffix. Resolves a date-less
 * `resets HH:MM` against today/tomorrow and a date-bearing `resets HH:MM on
 * DD Mon` against this-year/next-year, both in `now`'s own zone.
 */
function parseLimitRow(
  pattern: RegExp,
  text: string,
  now: Temporal.ZonedDateTime,
  what: string,
): UsageWindow {
  const m = pattern.exec(text);
  if (!m) {
    throw new CodexStatusParseError(`${what} line not found or didn't match`);
  }
  const pctLeft = Number.parseInt(m[1], 10);
  const hour = Number.parseInt(m[2], 10);
  const minute = Number.parseInt(m[3], 10);
  const resetsAt =
    m[4] !== undefined
      ? codexDateResetAt(
          resolveMonth(m[5]),
          Number.parseInt(m[4], 10),
          hour,
          minute,
          now,
        )
      : codexTodayResetAt(hour, minute, now);
  return { percent_used: 100 - pctLeft, resets_at: resetsAt };
}

function parseFiveHour(
  text: string,
  now: Temporal.ZonedDateTime,
  label: string,
): UsageWindow {
  return parseLimitRow(FIVE_HOUR_RE, text, now, `${label} 5h limit`);
}

function parseWeekly(
  text: string,
  now: Temporal.ZonedDateTime,
  label: string,
): UsageWindow {
  return parseLimitRow(WEEKLY_RE, text, now, `${label} Weekly limit`);
}

export function parse(
  text: string,
  now: Temporal.ZonedDateTime = Temporal.Now.zonedDateTimeISO(),
): CodexUsage {
  if (!text.includes(PANEL_SENTINEL)) {
    throw new CodexStatusParseError(
      `panel sentinel '${PANEL_SENTINEL}' not found — /status screen likely changed`,
    );
  }

  const sparkIdx = text.indexOf(SPARK_SENTINEL);
  const primaryText = sparkIdx < 0 ? text : text.slice(0, sparkIdx);

  const out: CodexUsage = {
    session: parseFiveHour(primaryText, now, "primary"),
    week: parseWeekly(primaryText, now, "primary"),
  };

  if (sparkIdx >= 0) {
    const sparkText = text.slice(sparkIdx);
    out.codex_spark_session = parseFiveHour(sparkText, now, "Codex-Spark");
    out.codex_spark_week = parseWeekly(sparkText, now, "Codex-Spark");
  }

  return out;
}
