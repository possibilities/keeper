import { Temporal } from "@js-temporal/polyfill";
import { parse as parseClaude } from "./parse-claude-usage";
import { parse as parseCodex } from "./parse-codex-status";

/**
 * Parse-only stdin bridge for cross-checking the parsers against a rendered
 * screen. Reads panel text on stdin, takes `--target claude|codex` and an
 * optional `--now <offset-iso>`, and prints one line to stdout: the parsed
 * usage JSON (exit 0) or, on any thrown parser error, `{"error_type": "<name>",
 * "message": "..."}` (exit 1). `error_type` is the thrown error's class name
 * (e.g. ClaudeUsageParseError, ClaudeUsageEndpointRateLimited,
 * NoActiveSubscription, CodexStatusParseError).
 *
 * `now` is built per target to match each parser's timezone semantics: claude
 * reprojects the resolved reset to the system zone, so it needs a real IANA
 * zone; codex keeps `now`'s own fixed offset (never reprojecting), so it keeps
 * the argv offset as a fixed-offset zone.
 */

type Target = "claude" | "codex";

const OFFSET_RE = /([+-]\d{2}:?\d{2}|Z)$/;

function offsetZoneFrom(nowArg: string): string {
  const m = OFFSET_RE.exec(nowArg);
  if (!m) {
    throw new Error(`--now must carry a UTC offset: '${nowArg}'`);
  }
  const off = m[1];
  if (off === "Z") {
    return "+00:00";
  }
  return off.includes(":") ? off : `${off.slice(0, 3)}:${off.slice(3)}`;
}

function buildNow(
  target: Target,
  nowArg: string | undefined,
): Temporal.ZonedDateTime {
  if (nowArg === undefined) {
    return Temporal.Now.zonedDateTimeISO();
  }
  const instant = Temporal.Instant.from(nowArg);
  if (target === "claude") {
    return instant.toZonedDateTimeISO(Temporal.Now.timeZoneId());
  }
  return instant.toZonedDateTimeISO(offsetZoneFrom(nowArg));
}

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);
  let target: string | undefined;
  let nowArg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--target") {
      target = args[++i];
    } else if (arg === "--now") {
      nowArg = args[++i];
    } else {
      await Bun.write(Bun.stderr, `unknown argument: ${arg}\n`);
      return 2;
    }
  }

  if (target !== "claude" && target !== "codex") {
    await Bun.write(Bun.stderr, "--target must be 'claude' or 'codex'\n");
    return 2;
  }

  const text = await Bun.stdin.text();
  const now = buildNow(target, nowArg);

  try {
    const usage =
      target === "claude" ? parseClaude(text, now) : parseCodex(text, now);
    await Bun.write(Bun.stdout, `${JSON.stringify(usage)}\n`);
    return 0;
  } catch (err) {
    const errorType = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    await Bun.write(
      Bun.stdout,
      `${JSON.stringify({ error_type: errorType, message })}\n`,
    );
    return 1;
  }
}

process.exit(await main());
