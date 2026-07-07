import { Temporal } from "@js-temporal/polyfill";
import { NoActiveSubscription } from "../../src/usage-scrape/parse-claude-usage";
import { detectSignedOut, TARGETS } from "../../src/usage-scrape/scrape";
import {
  classifyParseError,
  ERROR_KIND_SCRAPE_FAILED,
  PARSERS,
  SCHEMA_VERSION,
  screenExcerpt,
} from "../../src/usage-scrape/scrape-cli";

/**
 * Re-derive a corpus case's expected discriminated-contract payload from its
 * frozen `screen.txt`, tmux- and subprocess-free.
 *
 * This is the parser-level twin of scrape-cli's `run()`: it reproduces the exact
 * arm branching (pre-send signed-out → no-subscription → parse error → subscribed)
 * over an already-rendered screen, reusing the production `PARSERS`,
 * `classifyParseError`, `screenExcerpt`, and `detectSignedOut` so the derivation
 * cannot drift from the live CLI. The conformance suite asserts this equals the
 * committed `expected.json`.
 */

export type Target = "claude" | "codex";

export interface CaseMeta {
  target: Target;
  now: string;
  tz: string;
  logged_in?: boolean;
  expected_exit_code: number;
}

const OFFSET_RE = /([+-]\d{2}:?\d{2}|Z)$/;

/** The argv offset of an offset-bearing ISO stamp as a fixed-offset zone id. */
function offsetZoneFrom(nowArg: string): string {
  const m = OFFSET_RE.exec(nowArg);
  if (!m) {
    throw new Error(`now must carry a UTC offset: '${nowArg}'`);
  }
  const off = m[1];
  if (off === "Z") {
    return "+00:00";
  }
  return off.includes(":") ? off : `${off.slice(0, 3)}:${off.slice(3)}`;
}

/**
 * Build the parser's `now` from the case's pinned stamp. Mirrors scrape-cli's
 * per-target zoning, but resolves claude against the case's explicit `tz` rather
 * than the process zone: the live CLI reads `TZ` (pinned per case by the driver),
 * so binding to `tz` here makes the in-process derivation portable across boxes.
 */
export function buildNow(
  target: Target,
  nowArg: string,
  tz: string,
): Temporal.ZonedDateTime {
  const instant = Temporal.Instant.from(nowArg);
  if (target === "claude") {
    return instant.toZonedDateTimeISO(tz);
  }
  return instant.toZonedDateTimeISO(offsetZoneFrom(nowArg));
}

function okSubscribed(
  usage: unknown,
  subscriptionActive: boolean | null,
): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    status: "ok",
    usage,
    subscription_active: subscriptionActive,
  };
}

function okNoSubscription(): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    status: "ok",
    no_subscription: true,
  };
}

function okSignedOut(): Record<string, unknown> {
  return { schema_version: SCHEMA_VERSION, status: "ok", signed_out: true };
}

function errorArm(
  errorType: string,
  message: string,
  screen: string[],
  errorKind: string,
): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    status: "error",
    error_kind: errorKind,
    error_type: errorType,
    message,
    screen_excerpt: screen,
  };
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The claude pre-send sign-in gate over a rendered screen. Reuses scrape's real
 * quorum detector with an injected probe that hands it the frozen text (the
 * alt-screen is always active for a corpus render), so a logged-out screen
 * classifies signed_out exactly as the live driver does — before any parse.
 */
async function detectSignedOutText(screen: string): Promise<boolean> {
  const sentinels = TARGETS.claude.signedOutSentinels;
  if (!sentinels) {
    return false;
  }
  return detectSignedOut("", sentinels, 2, {
    alternateOn: async () => true,
    capturePane: async () => ({ stdout: screen, exitCode: 0 }),
  });
}

export interface DerivedContract {
  payload: Record<string, unknown>;
  exitCode: number;
}

/**
 * Derive the payload + exit code a scrape of this rendered screen would emit.
 *
 * A scrape driver failure (binary missing, PTY error) has no screen to render,
 * so it is out of scope here — a frozen screen means the render already
 * succeeded. `error_kind: scrape_failed` therefore never originates from this
 * path; it is imported only to keep the arm vocabulary co-located.
 */
export async function deriveContract(
  meta: CaseMeta,
  screen: string,
): Promise<DerivedContract> {
  void ERROR_KIND_SCRAPE_FAILED;
  const now = buildNow(meta.target, meta.now, meta.tz);

  if (meta.target === "claude" && (await detectSignedOutText(screen))) {
    return { payload: okSignedOut(), exitCode: 0 };
  }

  const parser = PARSERS[meta.target];
  let usage: unknown;
  try {
    usage = parser(screen, now);
  } catch (err) {
    if (err instanceof NoActiveSubscription) {
      // The live CLI confirms a logged-out profile via `claude auth status`; a
      // definitive logged-out answer becomes signed_out, anything else stays
      // no_subscription. The corpus encodes that answer in `logged_in`.
      if (meta.target === "claude" && meta.logged_in === false) {
        return { payload: okSignedOut(), exitCode: 0 };
      }
      return { payload: okNoSubscription(), exitCode: 0 };
    }
    const kind = classifyParseError(meta.target, err, screen);
    return {
      payload: errorArm(
        errName(err),
        errMessage(err),
        screenExcerpt(screen),
        kind,
      ),
      exitCode: 1,
    };
  }

  const subscriptionActive: boolean | null =
    meta.target === "claude" ? true : null;
  return { payload: okSubscribed(usage, subscriptionActive), exitCode: 0 };
}
