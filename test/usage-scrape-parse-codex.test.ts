import { describe, expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";
import {
  CodexStatusParseError,
  parse,
} from "../src/usage-scrape/parse-codex-status";

// Pinned NOW: 2026-05-15 12:00 (-04:00). Codex keeps `now`'s own fixed offset
// across resets, so a fixed-offset zone makes every reset carry -04:00. Expected
// values are hand-computed, not re-derived by the parser.
const NOW = Temporal.Instant.from(
  "2026-05-15T12:00:00-04:00",
).toZonedDateTimeISO("-04:00");

const VALID_PANEL = `│  Token usage:  1,234 used
│
│  5h limit:   [████░░░░] 99% left (resets 14:05)
│  Weekly limit:  [██░░░░░░] 29% left (resets 18:28 on 30 May)
│
│  Esc to dismiss
`;

const SPARK_PANEL = `│  Token usage:  1,234 used
│
│  5h limit:   [████░░░░] 99% left (resets 14:05)
│  Weekly limit:  [██░░░░░░] 29% left (resets 18:28 on 30 May)
│  GPT-5.3-Codex-Spark limit:
│  5h limit:   [████░░░░] 73% left (resets 23:59)
│  Weekly limit:  [██░░░░░░] 52% left (resets 21:00 on 28 Jun)
│
│  Esc to dismiss
`;

describe("parse — primary limit rows", () => {
  test("inverts percent-left to percent-used for both windows", () => {
    const out = parse(VALID_PANEL, NOW);
    expect(Object.keys(out).sort()).toEqual(["session", "week"]);
    expect(out.session.percent_used).toBe(1); // 100 - 99
    expect(out.week.percent_used).toBe(71); // 100 - 29
  });

  test("resolves reset clocks in now's fixed offset", () => {
    const out = parse(VALID_PANEL, NOW);
    // 14:05 today is after 12:00 now → stays today.
    expect(out.session.resets_at).toBe("2026-05-15T14:05:00-04:00");
    // 18:28 on 30 May this year is still future → stays this year.
    expect(out.week.resets_at).toBe("2026-05-30T18:28:00-04:00");
  });
});

describe("parse — optional Codex-Spark block", () => {
  test("emits spark windows only when the spark sentinel is present", () => {
    expect(parse(VALID_PANEL, NOW).codex_spark_session).toBeUndefined();

    const out = parse(SPARK_PANEL, NOW);
    expect(Object.keys(out).sort()).toEqual([
      "codex_spark_session",
      "codex_spark_week",
      "session",
      "week",
    ]);
    expect(out.codex_spark_session?.percent_used).toBe(27); // 100 - 73
    expect(out.codex_spark_session?.resets_at).toBe(
      "2026-05-15T23:59:00-04:00",
    );
    expect(out.codex_spark_week?.percent_used).toBe(48); // 100 - 52
    expect(out.codex_spark_week?.resets_at).toBe("2026-06-28T21:00:00-04:00");
  });

  test("a spark header with no complete rows throws", () => {
    const text = `${VALID_PANEL}│  GPT-5.3-Codex-Spark limit:\n`;
    expect(() => parse(text, NOW)).toThrow(CodexStatusParseError);
  });
});

describe("parse — strict error paths", () => {
  test("missing 5h sentinel throws", () => {
    expect(() => parse("some unrelated status screen", NOW)).toThrow(
      CodexStatusParseError,
    );
  });

  test("a day with no month in the reset suffix is drift and throws", () => {
    const text =
      "│  5h limit:   [████] 99% left (resets 14:05)\n" +
      "│  Weekly limit:  [██░░] 29% left (resets 18:28 on 30)\n";
    expect(() => parse(text, NOW)).toThrow(CodexStatusParseError);
  });
});
