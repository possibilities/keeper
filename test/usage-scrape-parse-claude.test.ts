import { describe, expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";
import {
  ClaudeUsageEndpointRateLimited,
  ClaudeUsageParseError,
  deriveLiftAt,
  NoActiveSubscription,
  parse,
} from "../src/usage-scrape/parse-claude-usage";

// Pinned NOW: 2026-05-29 noon in New York. Reset times reproject to `now`'s
// zone, so pinning a real IANA zone makes the expected offsets deterministic.
// Expected strings below are hand-computed, not re-derived by the parser.
const NOW = Temporal.ZonedDateTime.from("2026-05-29T12:00[America/New_York]");

const NO_SUB_SCREEN = `  Settings  Status   Config   usage   Stats

  What's contributing to your limits usage?

   Models                  % of usage
   Sonnet 4.6                     58%
   Esc to cancel
`;

const API_BILLING_NO_BARS_SCREEN = `   Settings  Status   Config   usage   Stats
   Session
   Total cost:            $0.0000
   API Usage Billing
   Esc to cancel
`;

const API_BILLING_ENDPOINT_RATE_LIMIT_SCREEN = `${API_BILLING_NO_BARS_SCREEN}   Error: Usage endpoint is rate limited. Please try again in a moment.
`;

const SUBSCRIBED_SCREEN = `  Settings  Status   Config   Usage   Stats

  Current session
  [████████░░░░░░░░] 42% used
  Resets 3pm (America/New_York)

  Current week (all models)
  [██░░░░░░░░░░░░░░] 17% used
  Resets May 31 at 9am (America/New_York)
`;

const SUBSCRIBED_WITH_SONNET = `${SUBSCRIBED_SCREEN}
  Current week (Sonnet only)
  [█░░░░░░░░░░░░░░░] 9% used
  Resets May 31 at 9am (America/New_York)
`;

const DEPLETED_WEEK_SCREEN = `  Settings  Status   Config   Usage   Stats

  Current session
                                  0% used
  Current week (all models)
  [██████████████████] 100% used
  Resets Jun 13 at 3:59am (America/New_York)
`;

describe("parse — subscribed bars path", () => {
  test("parses session and week with inverted-free percents and NY resets", () => {
    const out = parse(SUBSCRIBED_SCREEN, NOW);
    expect(Object.keys(out).sort()).toEqual(["session", "week"]);
    expect(out.session.percent_used).toBe(42);
    expect(out.session.resets_at).toBe("2026-05-29T15:00:00-04:00");
    expect(out.week.percent_used).toBe(17);
    expect(out.week.resets_at).toBe("2026-05-31T09:00:00-04:00");
  });

  test("optional sonnet_week block parses when present", () => {
    const out = parse(SUBSCRIBED_WITH_SONNET, NOW);
    expect(Object.keys(out).sort()).toEqual(["session", "sonnet_week", "week"]);
    expect(out.sonnet_week.percent_used).toBe(9);
  });

  test("depleted week: 0% session is null-reset, week binds the lift", () => {
    const out = parse(DEPLETED_WEEK_SCREEN, NOW);
    expect(Object.keys(out).sort()).toEqual(["session", "week"]);
    expect(out.session.percent_used).toBe(0);
    expect(out.session.resets_at).toBeNull();
    expect(out.week.percent_used).toBe(100);
    expect(out.week.resets_at).toBe("2026-06-13T03:59:00-04:00");
    expect(deriveLiftAt(out)).toBe(out.week.resets_at);
  });

  test("nonzero window missing its reset line is real drift and throws", () => {
    const drifted = DEPLETED_WEEK_SCREEN.replace("0% used", "5% used");
    expect(() => parse(drifted, NOW)).toThrow(ClaudeUsageParseError);
  });
});

describe("parse — no-bars branching precedence", () => {
  test("no-sub breakdown throws NoActiveSubscription", () => {
    expect(() => parse(NO_SUB_SCREEN, NOW)).toThrow(NoActiveSubscription);
  });

  test("API-billing without bars throws NoActiveSubscription", () => {
    expect(() => parse(API_BILLING_NO_BARS_SCREEN, NOW)).toThrow(
      NoActiveSubscription,
    );
  });

  test("endpoint rate-limit outranks the no-sub breakdown", () => {
    expect(() => parse(API_BILLING_ENDPOINT_RATE_LIMIT_SCREEN, NOW)).toThrow(
      ClaudeUsageEndpointRateLimited,
    );
  });

  test("empty screen with no bars and no breakdown throws parse error", () => {
    expect(() => parse("some unrelated screen", NOW)).toThrow(
      ClaudeUsageParseError,
    );
  });
});

describe("deriveLiftAt — soonest reset among >=100% windows", () => {
  test("null/empty usage yields null", () => {
    expect(deriveLiftAt(null)).toBeNull();
    expect(deriveLiftAt({})).toBeNull();
  });

  test("below 100% everywhere never binds", () => {
    expect(
      deriveLiftAt({
        session: { percent_used: 42, resets_at: "2026-05-29T15:00:00-04:00" },
        week: { percent_used: 88.5, resets_at: "2026-06-02T09:00:00-04:00" },
      }),
    ).toBeNull();
  });

  test("a sub-limit window resetting sooner does not outrank a 100% window", () => {
    const weekReset = "2026-06-02T09:00:00-04:00";
    expect(
      deriveLiftAt({
        session: { percent_used: 99, resets_at: "2026-05-29T15:00:00-04:00" },
        week: { percent_used: 100, resets_at: weekReset },
      }),
    ).toBe(weekReset);
  });
});
