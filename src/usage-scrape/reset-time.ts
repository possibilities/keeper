// @js-temporal/polyfill is pinned EXACT in package.json — its serialization
// format is spec-sensitive, so a version bump can change `toString` output.
import { Temporal } from "@js-temporal/polyfill";

/**
 * Timezone/wall-clock math for reset-time resolution. The parsers own regex
 * extraction; this module owns every Temporal operation so resolution keeps
 * aware-datetime wall-clock semantics (not epoch math) across DST edges.
 *
 * `now` is a `Temporal.ZonedDateTime` — the resolution reference. In production
 * it is `Temporal.Now.zonedDateTimeISO()` (the system zone); tests pin it for
 * deterministic assertions.
 *
 * The two families differ in ONE load-bearing way that guards envelope
 * compatibility: a claude reset is resolved in its panel's named IANA zone and
 * then REPROJECTED to `now`'s zone, while a codex reset is resolved in `now`'s
 * OWN zone and keeps that offset (never reprojected). Preserve that split.
 */

// Wall-clock reconstruction: derive the offset purely from the new wall-clock
// fields via `disambiguation: 'compatible'`, and reject invalid dates (Feb 30)
// rather than clamp them.
const WITH_OPTS = {
  offset: "ignore",
  disambiguation: "compatible",
  overflow: "reject",
} as const;

/** Seconds-precision, offset-bearing ISO with the `[Zone]` bracket stripped and no fractional seconds. */
function formatResetAt(zdt: Temporal.ZonedDateTime): string {
  return zdt.toString({ smallestUnit: "second", timeZoneName: "never" });
}

/**
 * 12-hour clock to 24-hour: `12am` -> 0, `12pm` -> 12, other am hours
 * unchanged, other pm hours + 12.
 */
export function to24h(hour12: number, ampm: string): number {
  if (ampm.toLowerCase() === "am") {
    return hour12 === 12 ? 0 : hour12;
  }
  return hour12 === 12 ? 12 : hour12 + 12;
}

/**
 * Claude session reset (`HH:MM`, no date) resolved as wall-clock in the named
 * IANA `tzName` — next occurrence today, else tomorrow — then reprojected to
 * `now`'s zone (system-local in production). Throws `RangeError` on an unknown
 * IANA zone, natively via `withTimeZone`.
 */
export function claudeSessionResetAt(
  hour24: number,
  minute: number,
  tzName: string,
  now: Temporal.ZonedDateTime,
): string {
  const localNow = now.withTimeZone(tzName);
  let candidate = localNow.with(
    {
      hour: hour24,
      minute,
      second: 0,
      millisecond: 0,
      microsecond: 0,
      nanosecond: 0,
    },
    WITH_OPTS,
  );
  if (Temporal.ZonedDateTime.compare(candidate, localNow) <= 0) {
    candidate = candidate.add({ days: 1 });
  }
  return formatResetAt(candidate.withTimeZone(now.timeZoneId));
}

/**
 * Claude weekly reset (`Mon DD at HH:MM`) resolved as wall-clock in the named
 * IANA `tzName` — this year, else next — then reprojected to `now`'s zone.
 * `month` is 1-based. Throws `RangeError` on an unknown IANA zone or an invalid
 * calendar date.
 */
export function claudeWeekResetAt(
  month: number,
  day: number,
  hour24: number,
  minute: number,
  tzName: string,
  now: Temporal.ZonedDateTime,
): string {
  const localNow = now.withTimeZone(tzName);
  let candidate = localNow.with(
    {
      month,
      day,
      hour: hour24,
      minute,
      second: 0,
      millisecond: 0,
      microsecond: 0,
      nanosecond: 0,
    },
    WITH_OPTS,
  );
  if (Temporal.ZonedDateTime.compare(candidate, localNow) <= 0) {
    candidate = candidate.with({ year: candidate.year + 1 }, WITH_OPTS);
  }
  return formatResetAt(candidate.withTimeZone(now.timeZoneId));
}

/**
 * Codex date-less reset (`resets HH:MM`) resolved as wall-clock in `now`'s own
 * zone (system-local only — no named zone) — today, else tomorrow.
 */
export function codexTodayResetAt(
  hour24: number,
  minute: number,
  now: Temporal.ZonedDateTime,
): string {
  let candidate = now.with(
    {
      hour: hour24,
      minute,
      second: 0,
      millisecond: 0,
      microsecond: 0,
      nanosecond: 0,
    },
    WITH_OPTS,
  );
  if (Temporal.ZonedDateTime.compare(candidate, now) <= 0) {
    candidate = candidate.add({ days: 1 });
  }
  return formatResetAt(candidate);
}

/**
 * Codex date-bearing reset (`resets HH:MM on DD Mon`) resolved as wall-clock in
 * `now`'s own zone — this year, else next. `month` is 1-based. Throws
 * `RangeError` on an invalid calendar date.
 */
export function codexDateResetAt(
  month: number,
  day: number,
  hour24: number,
  minute: number,
  now: Temporal.ZonedDateTime,
): string {
  let candidate = now.with(
    {
      month,
      day,
      hour: hour24,
      minute,
      second: 0,
      millisecond: 0,
      microsecond: 0,
      nanosecond: 0,
    },
    WITH_OPTS,
  );
  if (Temporal.ZonedDateTime.compare(candidate, now) <= 0) {
    candidate = candidate.with({ year: candidate.year + 1 }, WITH_OPTS);
  }
  return formatResetAt(candidate);
}
