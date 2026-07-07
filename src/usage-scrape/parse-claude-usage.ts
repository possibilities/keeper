import { Temporal } from "@js-temporal/polyfill";
import { claudeSessionResetAt, claudeWeekResetAt, to24h } from "./reset-time";

/**
 * Parse the rendered claude /usage panel into structured data.
 *
 * Strict by design: any divergence from the observed TUI format throws so we
 * notice when claude updates the panel rather than silently writing stale or
 * partial data.
 *
 * Two-axis result contract:
 * - Subscribed accounts render rate-limit bars (`"% used"`) and parse into a
 *   `{session, week[, sonnet_week]}` object.
 * - No-subscription accounts render a usage-contribution breakdown
 *   (`"% of usage"`) with no bars; `NoActiveSubscription` is thrown so the
 *   caller treats this as a successful read of "no subscription" rather than a
 *   parse failure.
 * - Anything else (panel never rendered, real format drift) throws
 *   `ClaudeUsageParseError`.
 *
 * Precedence inside `parse`: subscribed-bars > endpoint-rate-limit > no-sub >
 * api-billing > error.
 */

/** Thrown when the /usage panel doesn't match the expected shape. */
export class ClaudeUsageParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeUsageParseError";
  }
}

/** Thrown when the /usage panel reports its data endpoint is rate-limited. */
export class ClaudeUsageEndpointRateLimited extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeUsageEndpointRateLimited";
  }
}

/**
 * Thrown when the /usage panel rendered but the account has no plan limits.
 *
 * The panel shows the usage-contribution breakdown (no rate-limit bars).
 * Callers should treat this as a successful read of "no subscription" rather
 * than a parse failure: there is nothing to parse and nothing wrong.
 */
export class NoActiveSubscription extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoActiveSubscription";
  }
}

/**
 * Thrown when the profile is logged out and renders the OAuth sign-in screen.
 *
 * Unlike the others here, this is NOT thrown by `parse` — a logged-out profile
 * never reaches the parser. The scrape driver detects the sign-in screen
 * PRE-SEND and throws this so the caller emits a successful `signed_out` read
 * rather than burning the sentinel-retry budget on a panel that never renders.
 * The class lives here to keep the claude-usage error vocabulary in one place,
 * mirroring `NoActiveSubscription`.
 */
export class SignedOut extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignedOut";
  }
}

/** One parsed rate-limit window. `resets_at` is null for a bar-less 0% window. */
export interface UsageWindow {
  percent_used: number;
  resets_at: string | null;
}

/** The subscribed-account parse result: session/week windows keyed by name. */
export type ClaudeUsage = Record<string, UsageWindow>;

export const PANEL_HEADER = "Settings  Status   Config   Usage   Stats";

// Shared sentinel for the no-subscription usage-contribution breakdown. Keyed
// on the same literal by scrape's appear-sentinel retry loop — change both in
// lockstep.
export const NO_SUB_SENTINEL = "% of usage";

// API-billing orgs render no limit bars and may omit the contribution
// breakdown. Treat that as no-subscription unless the panel rendered a
// transient endpoint rate-limit error instead.
export const API_BILLING_SENTINEL = "API Usage Billing";
export const USAGE_ENDPOINT_RATE_LIMIT_SENTINEL =
  "Usage endpoint is rate limited";

const REQUIRED_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["session", "Current session"],
  ["week", "Current week (all models)"],
];
const OPTIONAL_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["sonnet_week", "Current week (Sonnet only)"],
];

const PERCENT_RE = /(\d+(?:\.\d+)?)% used/;
const RESETS_RE = /^\s*Resets (.+?) \(([^)]+)\)\s*$/;
const SESSION_TIME_RE = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/i;
const WEEK_TIME_RE =
  /^([A-Za-z]{3}) (\d{1,2}) at (\d{1,2})(?::(\d{2}))?(am|pm)$/i;

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

/** Titlecase a single token: first char upper, the rest lower. */
function titleCase(word: string): string {
  if (word.length === 0) {
    return word;
  }
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

function resolveSession(
  raw: string,
  tzName: string,
  now: Temporal.ZonedDateTime,
): string {
  const m = SESSION_TIME_RE.exec(raw.trim());
  if (!m) {
    throw new ClaudeUsageParseError(`unknown session reset time: '${raw}'`);
  }
  const hour = to24h(Number.parseInt(m[1], 10), m[3]);
  const minute = m[2] ? Number.parseInt(m[2], 10) : 0;
  return claudeSessionResetAt(hour, minute, tzName, now);
}

function resolveWeek(
  raw: string,
  tzName: string,
  now: Temporal.ZonedDateTime,
): string {
  const m = WEEK_TIME_RE.exec(raw.trim());
  if (!m) {
    throw new ClaudeUsageParseError(`unknown week reset time: '${raw}'`);
  }
  const mon = titleCase(m[1]);
  const month = MONTHS[mon];
  if (month === undefined) {
    throw new ClaudeUsageParseError(`unknown month '${mon}' in '${raw}'`);
  }
  const day = Number.parseInt(m[2], 10);
  const hour = to24h(Number.parseInt(m[3], 10), m[5]);
  const minute = m[4] ? Number.parseInt(m[4], 10) : 0;
  return claudeWeekResetAt(month, day, hour, minute, tzName, now);
}

/** The two non-blank lines (percent, reset) following `label`, or null. */
function findBlock(lines: string[], label: string): [string, string] | null {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === label) {
      const rest = lines.slice(i + 1).filter((ln) => ln.trim() !== "");
      if (rest.length < 2) {
        throw new ClaudeUsageParseError(
          `label '${label}' found but missing percent/reset lines`,
        );
      }
      return [rest[0], rest[1]];
    }
  }
  return null;
}

function parseBlock(
  lines: string[],
  key: string,
  label: string,
  optional: boolean,
  now: Temporal.ZonedDateTime,
  out: ClaudeUsage,
): void {
  const found = findBlock(lines, label);
  if (found === null) {
    if (optional) {
      return;
    }
    throw new ClaudeUsageParseError(`required label not found: '${label}'`);
  }
  const [percentLine, resetLine] = found;

  const pm = PERCENT_RE.exec(percentLine);
  if (!pm) {
    throw new ClaudeUsageParseError(
      `label '${label}': percent line did not match: '${percentLine}'`,
    );
  }
  const percent = Number.parseFloat(pm[1]);

  const rm = RESETS_RE.exec(resetLine);
  if (!rm) {
    // A window at 0% usage renders bar-less with NO "Resets …" line — the panel
    // collapses it to a bare "0% used", so findBlock's second line is actually
    // the NEXT block's label. This is the normal shape when a sibling window is
    // depleted (hitting the weekly cap drops the session window to 0% and omits
    // its reset). Emit the window with a null reset rather than treating the
    // absent line as drift. A NONZERO window must still carry a reset line — a
    // missing one there is real drift and throws. deriveLiftAt skips null-reset
    // windows.
    if (percent === 0) {
      out[key] = { percent_used: percent, resets_at: null };
      return;
    }
    throw new ClaudeUsageParseError(
      `label '${label}': reset line did not match: '${resetLine}'`,
    );
  }
  const rawWhen = rm[1];
  const tzName = rm[2];

  // Validate the IANA zone up front so an unknown zone surfaces as a strict
  // parse error, distinct from the resolver's own calendar-overflow throw.
  try {
    now.withTimeZone(tzName);
  } catch {
    throw new ClaudeUsageParseError(`unknown timezone '${tzName}'`);
  }

  const resetsAt =
    key === "session"
      ? resolveSession(rawWhen, tzName, now)
      : resolveWeek(rawWhen, tzName, now);

  out[key] = { percent_used: percent, resets_at: resetsAt };
}

/**
 * The binding rate-limit lift time for a parsed `usage` object.
 *
 * The lift is the soonest `resets_at` among windows whose `percent_used` has
 * hit or exceeded 100% — the wall-clock instant the binding limit releases.
 * Windows below 100% never bind even if they reset sooner. Comparison is a
 * lexicographic ISO-string compare (offset-bearing, seconds precision).
 *
 * Returns null when `usage` is null/empty, no window is at >=100%, or every
 * >=100% window is missing `resets_at`. Pure: inspects the already-parsed
 * windows, no clock reads.
 */
export function deriveLiftAt(
  usage: Record<string, UsageWindow> | null | undefined,
): string | null {
  if (!usage) {
    return null;
  }
  let soonest: string | null = null;
  for (const window of Object.values(usage)) {
    if (typeof window !== "object" || window === null) {
      continue;
    }
    const percent = window.percent_used;
    const resetsAt = window.resets_at;
    if (percent == null || resetsAt == null) {
      continue;
    }
    if (percent < 100) {
      continue;
    }
    if (soonest === null || resetsAt < soonest) {
      soonest = resetsAt;
    }
  }
  return soonest;
}

export function parse(
  text: string,
  now: Temporal.ZonedDateTime = Temporal.Now.zonedDateTimeISO(),
): ClaudeUsage {
  // Bars are the positive signal for a subscribed account: the rate-limit rows
  // render "<pct>% used", a literal the no-sub breakdown never emits (it uses
  // "% of usage"). Branching on bar presence — not the panel header — keeps the
  // subscribed and no-sub paths fully disjoint.
  const hasBars = PERCENT_RE.test(text);

  if (hasBars) {
    // Relax the header gate to case-insensitive on the bars path: the tab strip
    // casing varies between scrapes ("Usage" vs "usage") and a cosmetic flip
    // must not spuriously throw on a panel that otherwise has all its bars.
    if (!text.toLowerCase().includes(PANEL_HEADER.toLowerCase())) {
      throw new ClaudeUsageParseError(
        `panel header not found: '${PANEL_HEADER}' — /usage screen likely changed`,
      );
    }

    const lines = text.split(/\r?\n/);
    const out: ClaudeUsage = {};

    for (const [key, label] of REQUIRED_LABELS) {
      parseBlock(lines, key, label, false, now, out);
    }
    for (const [key, label] of OPTIONAL_LABELS) {
      parseBlock(lines, key, label, true, now, out);
    }

    return out;
  }

  // No bars — either no subscription (breakdown rendered), a transient endpoint
  // rate-limit, or the panel genuinely never rendered (real failure / drift).
  if (text.includes(USAGE_ENDPOINT_RATE_LIMIT_SENTINEL)) {
    throw new ClaudeUsageEndpointRateLimited(
      "claude /usage endpoint is rate limited — retry later",
    );
  }

  if (text.includes(NO_SUB_SENTINEL)) {
    throw new NoActiveSubscription(
      "claude /usage panel rendered the usage-contribution breakdown with no " +
        "rate-limit bars — account has no active subscription",
    );
  }

  if (text.includes(API_BILLING_SENTINEL)) {
    throw new NoActiveSubscription(
      "claude /usage panel rendered API Usage Billing with no rate-limit bars " +
        "— account has no active subscription limits",
    );
  }

  throw new ClaudeUsageParseError(
    "no rate-limit bars and no no-subscription breakdown found — /usage panel " +
      "did not render or its format changed",
  );
}
