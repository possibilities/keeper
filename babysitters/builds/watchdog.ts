#!/usr/bin/env bun
/**
 * `babysitters/builds/watchdog.ts` — the external dead-man for the `builds`
 * sitter's scanner (`watch.ts`). The sitter writes a `heartbeat.json` stamp as
 * the LAST action on every completed tick (see `watch.ts` `writeHeartbeat`).
 * This watchdog — a SEPARATE launchd job — reads that heartbeat and alarms if it
 * goes stale, catching the one failure class the sitter structurally cannot
 * self-report: its own death (a crashed/hung tick never reaches its heartbeat
 * write, and a dead monitor never runs its monitor).
 *
 * For the `builds` sitter this dead-man is the ONLY notification in the whole
 * system: the sitter NEVER pages on the findings path (it silently collects a
 * followup corpus the human works via `/babysit-triage builds`). So a stale
 * heartbeat is the sole signal that something has gone wrong — making this
 * watchdog load-bearing, not merely a backstop.
 *
 * "Who watches the watcher": this binary is deliberately STANDALONE. It reads
 * ONLY the heartbeat file — it does NOT open buildbot's state.sqlite, does NOT
 * import the sitter's scan path, and does NOT depend on the sitter or buildbot
 * being up. So when those die (the exact case it exists to catch) the watchdog
 * still runs and still pages. Decision logic is a PURE function of injected
 * (now, heartbeat-read, last-all-clear-day) so it unit-tests with no real botctl
 * and no real clock. Pages go to Telegram only (the "Keeper" topic).
 *
 * NOT a `keeper` subcommand — its own binary, like the sitter's `watch.ts`.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../src/db";
import { babysitterStateDir } from "../lib/state";

/** The sitter this watchdog guards — its heartbeat lives under this slug. */
const SLUG = "builds";

const HELP = `babysitter builds — watchdog [options]

External dead-man for the builds sitter. Reads the sitter's heartbeat.json and
alarms (botctl Telegram, "Keeper" topic) when it goes stale. This is the ONLY
notification the builds sitter emits (the findings path pages nothing). Standalone:
reads ONLY the heartbeat file — never opens any DB, never depends on the sitter
being up. NOT a 'keeper' subcommand.

Options:
  --json   Emit the decision as JSON instead of acting on it (no notify)
  --help   Show this help
`;

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** The sitter's launchd interval (…builds.watch StartInterval), seconds. */
export const WATCH_INTERVAL_SECS = 300;

/**
 * Staleness alarm threshold: `max(3 × interval, 900)` = 900s. The 3× factor is
 * the dead-man rule of thumb (one missed tick is jitter, three is a death); the
 * 900s floor absorbs launchd `StartInterval` jitter — the interval resets from
 * process EXIT, so a slow tick legitimately pushes the next one out.
 */
export const WATCHDOG_STALE_SECS = Math.max(3 * WATCH_INTERVAL_SECS, 900);

// ---------------------------------------------------------------------------
// Path resolvers (pure; share the sitter state-dir helper with watch.ts)
// ---------------------------------------------------------------------------

/** The sitter's liveness heartbeat — the ONLY input this watchdog reads. */
export function resolveHeartbeatPath(): string {
  return join(babysitterStateDir(SLUG), "heartbeat.json");
}

/** The watchdog's OWN once-a-day all-clear marker (its only persisted state). */
export function resolveWatchdogDayPath(): string {
  return join(babysitterStateDir(SLUG), "watchdog.day");
}

// ---------------------------------------------------------------------------
// Heartbeat read (degrade-don't-throw)
// ---------------------------------------------------------------------------

/**
 * Read the heartbeat `ts`. A missing file resolves to `null` (first-run: the
 * sitter hasn't ticked yet — NOT dead). A present-but-corrupt file also resolves
 * to `null`, treated as first-run (the next valid tick re-seeds it); a
 * torn/garbage heartbeat is not itself proof of death. NEVER throws.
 */
export function readHeartbeatTs(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const ts = (parsed as Record<string, unknown>).ts;
    if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
    return ts;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The pure staleness decision
// ---------------------------------------------------------------------------

/** What the watchdog should do this run. */
export type WatchdogAction = "first-run" | "ok" | "all-clear" | "alarm";

export interface WatchdogDecision {
  action: WatchdogAction;
  /** Heartbeat ts read this run (null = missing/corrupt = first-run). */
  heartbeatTs: number | null;
  /** now − heartbeatTs in seconds, or null when there is no heartbeat. */
  ageSecs: number | null;
  /** Human-readable one-liner for the alarm / all-clear channels. */
  message: string;
}

/** UTC calendar day (YYYY-MM-DD) for the once-daily all-clear de-dup. */
export function utcDay(nowSecs: number): string {
  return new Date(nowSecs * 1000).toISOString().slice(0, 10);
}

/**
 * Pure decision: given the current time, the heartbeat ts, and the day the last
 * all-clear was sent, decide what to do. No I/O — the caller injects all three.
 *
 *   - heartbeat missing/corrupt  → `first-run` (silent: not yet ticked / re-seed)
 *   - age > WATCHDOG_STALE_SECS  → `alarm` (the sitter is dead/hung)
 *   - fresh + new UTC day        → `all-clear` (daily heartbeat so silence ≠ dead)
 *   - fresh + same day           → `ok` (silent)
 */
export function decideWatchdog(input: {
  nowSecs: number;
  heartbeatTs: number | null;
  lastAllClearDay: string | null;
  staleSecs?: number;
}): WatchdogDecision {
  const stale = input.staleSecs ?? WATCHDOG_STALE_SECS;
  if (input.heartbeatTs === null) {
    return {
      action: "first-run",
      heartbeatTs: null,
      ageSecs: null,
      message:
        "babysitter builds: no heartbeat yet (sitter not yet ticked) — silent first-run.",
    };
  }
  const ageSecs = input.nowSecs - input.heartbeatTs;
  if (ageSecs > stale) {
    const mins = Math.round(ageSecs / 60);
    return {
      action: "alarm",
      heartbeatTs: input.heartbeatTs,
      ageSecs,
      message: `babysitter builds: 🚨 sitter heartbeat STALE — last tick ${mins} min ago (> ${Math.round(
        stale / 60,
      )} min threshold). The builds sitter is dead or hung; it can no longer collect CI failures or self-report. Investigate launchctl print gui/$(id -u)/arthack.babysitter.builds.watch.`,
    };
  }
  // Fresh heartbeat. Emit a once-a-day all-clear so a silent watchdog never
  // means the watchdog itself died.
  const today = utcDay(input.nowSecs);
  if (input.lastAllClearDay !== today) {
    const mins = Math.round(ageSecs / 60);
    return {
      action: "all-clear",
      heartbeatTs: input.heartbeatTs,
      ageSecs,
      message: `babysitter builds: ✅ sitter alive — last heartbeat ${mins} min ago. (Daily all-clear; the dead-man is watching.)`,
    };
  }
  return {
    action: "ok",
    heartbeatTs: input.heartbeatTs,
    ageSecs,
    message: "babysitter builds: heartbeat fresh — ok (silent).",
  };
}

// ---------------------------------------------------------------------------
// Day-marker persistence (the watchdog's only state; degrade-don't-throw)
// ---------------------------------------------------------------------------

/** Read the last all-clear UTC day, or null when absent/unreadable. */
export function readLastAllClearDay(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Atomically persist the all-clear day marker. Never throws. */
export function writeLastAllClearDay(path: string, day: string): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    atomicWriteFile(path, `${day}\n`);
  } catch {
    // Swallow: a marker-write failure just re-sends an all-clear tomorrow.
  }
}

// ---------------------------------------------------------------------------
// Alarm sink (botctl Telegram, "Keeper" topic) — best-effort, Telegram-only
// ---------------------------------------------------------------------------

/** The Telegram topic every babysitter routes its pages to. */
export const KEEPER_TOPIC = "Keeper";

/** The shape the CLI hands its notifier; injectable for tests. */
export interface NotifyDeps {
  /** Chat message (botctl --topic Keeper). The ONLY channel — no desktop notify. */
  chat: (message: string) => void;
}

/** Production notifier: shell out to botctl (Telegram only; no notifyctl). */
export function liveNotifyDeps(): NotifyDeps {
  return {
    chat: (message) => {
      try {
        Bun.spawnSync(
          ["botctl", "send-message", "--topic", KEEPER_TOPIC, message],
          { stdout: "ignore", stderr: "ignore" },
        );
      } catch {
        // Best-effort: a missing botctl must not crash the dead-man.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Run (impure: wires the decision to real reads + notifiers)
// ---------------------------------------------------------------------------

export interface RunDeps {
  nowSecs: () => number;
  heartbeatPath: string;
  dayPath: string;
  notify: NotifyDeps;
}

/** Production run-deps. */
export function liveRunDeps(): RunDeps {
  return {
    nowSecs: () => Date.now() / 1000,
    heartbeatPath: resolveHeartbeatPath(),
    dayPath: resolveWatchdogDayPath(),
    notify: liveNotifyDeps(),
  };
}

/**
 * One watchdog run: read the heartbeat + last all-clear day, decide, then act.
 * Returns the decision for the CLI + tests. Always degrades to no-throw so a
 * read/notify hiccup can never wedge the launchd job (always-exit-0 posture).
 */
export function run(deps: RunDeps): WatchdogDecision {
  const nowSecs = deps.nowSecs();
  const heartbeatTs = readHeartbeatTs(deps.heartbeatPath);
  const lastAllClearDay = readLastAllClearDay(deps.dayPath);
  const decision = decideWatchdog({ nowSecs, heartbeatTs, lastAllClearDay });

  if (decision.action === "alarm") {
    deps.notify.chat(decision.message);
  } else if (decision.action === "all-clear") {
    deps.notify.chat(decision.message);
    writeLastAllClearDay(deps.dayPath, utcDay(nowSecs));
  }
  // first-run / ok: silent.
  return decision;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export function main(argv: string[]): void {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes("--json")) {
    // Inspect-only: report the decision WITHOUT notifying (no side effects).
    const nowSecs = Date.now() / 1000;
    const heartbeatTs = readHeartbeatTs(resolveHeartbeatPath());
    const lastAllClearDay = readLastAllClearDay(resolveWatchdogDayPath());
    const decision = decideWatchdog({ nowSecs, heartbeatTs, lastAllClearDay });
    process.stdout.write(`${JSON.stringify({ success: true, decision })}\n`);
    return;
  }
  run(liveRunDeps());
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
