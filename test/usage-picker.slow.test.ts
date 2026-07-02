/**
 * `pickProfile` — the large-N statistical proportionality proofs deliberately
 * held OUT of the fast pure-in-process tier. The fast sibling
 * (`test/usage-picker.test.ts`) keeps deterministic weighting coverage (exact
 * pick sequence + credit math) via the injected clock; this file runs the four
 * heavy disk-bound loops (~2000 serial picks total) that pin the credit-weighted
 * distribution across full N. Each pick costs a flock + config read + envelope
 * reads + an atomic tmp-write+rename, so the aggregate blows the fast tier's 10s
 * per-test ceiling under host contention — the exact flap this suite removes.
 *
 * SKIPPED by default. Run it out-of-band with
 * `KEEPER_RUN_SLOW=1 bun test test/usage-picker.slow.test.ts`, or via
 * `scripts/test-full.ts --slow`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pickProfile,
  resetClock,
  setClock,
  setStateDir,
} from "../src/usage-picker";

const SLOW_ENABLED = process.env.KEEPER_RUN_SLOW !== undefined;

describe.skipIf(!SLOW_ENABLED)(
  "weighted balancing — large-N distribution",
  () => {
    let tmpDir: string;
    let stateDir: string;
    let configHome: string;
    let savedXdg: string | undefined;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "agentusage-picker-slow-"));
      stateDir = join(tmpDir, "state");
      mkdirSync(stateDir);
      configHome = join(tmpDir, "config");
      mkdirSync(join(configHome, "agentusage"), { recursive: true });
      setStateDir(stateDir);
      savedXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = configHome;
    });

    afterEach(() => {
      resetClock();
      if (savedXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = savedXdg;
      }
      rmSync(tmpDir, { recursive: true, force: true });
    });

    // ---------- helpers -------------------------------------------------------

    function writeConfig(profiles: string[]): void {
      const yaml = `profiles:\n${profiles.map((p) => `  - ${p}`).join("\n")}\n`;
      writeFileSync(join(configHome, "agentusage", "config.yaml"), yaml);
    }

    interface EnvelopeOpts {
      subscription_active: unknown;
      multiplier?: unknown;
      session_percent?: unknown;
      usage?: unknown;
    }

    function writeEnvelope(name: string, opts: EnvelopeOpts): void {
      let usage: unknown = opts.usage;
      if (usage === undefined) {
        usage =
          opts.session_percent === undefined
            ? null
            : { session: { percent_used: opts.session_percent } };
      }
      const envelope: Record<string, unknown> = {
        schema_version: 1,
        id: name,
        target: "claude",
        subscription_active: opts.subscription_active,
        status: "active",
        usage,
        lift_at: null,
      };
      if (opts.multiplier !== undefined) {
        envelope.multiplier = opts.multiplier;
      }
      writeFileSync(join(stateDir, `${name}.json`), JSON.stringify(envelope));
    }

    function readCounts(): Record<string, number> {
      const state = JSON.parse(
        readFileSync(join(stateDir, "picker.json"), "utf8"),
      );
      const out: Record<string, number> = {};
      for (const [name, entry] of Object.entries(state.picks)) {
        out[name] = (entry as { count: number }).count;
      }
      return out;
    }

    /** Monotonic clock — strictly increasing stamps, defeats microsecond ties. */
    function installMonotonicClock(): void {
      let counter = 0;
      setClock(() => {
        counter += 1;
        return new Date(Date.UTC(2026, 0, 1, 0, 0, counter));
      });
    }

    test("5x picked five times as often at equal headroom", () => {
      installMonotonicClock();
      writeConfig(["pro", "max5"]);
      writeEnvelope("pro", { subscription_active: true, multiplier: 1 });
      writeEnvelope("max5", { subscription_active: true, multiplier: 5 });

      for (let i = 0; i < 600; i++) {
        pickProfile();
      }

      const counts = readCounts();
      const ratio = counts.max5 / counts.pro;
      expect(ratio).toBeGreaterThanOrEqual(4.5);
      expect(ratio).toBeLessThanOrEqual(5.5);
    });

    test("headroom scales multiplier to even split", () => {
      installMonotonicClock();
      writeConfig(["a", "b"]);
      writeEnvelope("a", {
        subscription_active: true,
        multiplier: 10,
        session_percent: 50.0,
      });
      writeEnvelope("b", {
        subscription_active: true,
        multiplier: 5,
        session_percent: 0.0,
      });

      for (let i = 0; i < 400; i++) {
        pickProfile();
      }

      const counts = readCounts();
      expect(Math.abs(counts.a - counts.b)).toBeLessThanOrEqual(1);
    });

    test("all sessions burned falls back to multiplier credit", () => {
      installMonotonicClock();
      writeConfig(["pro", "max5"]);
      writeEnvelope("pro", {
        subscription_active: true,
        multiplier: 1,
        session_percent: 100.0,
      });
      writeEnvelope("max5", {
        subscription_active: true,
        multiplier: 5,
        session_percent: 100.0,
      });

      for (let i = 0; i < 600; i++) {
        pickProfile();
      }

      const counts = readCounts();
      expect(counts.pro + counts.max5).toBe(600);
      const ratio = counts.max5 / counts.pro;
      expect(ratio).toBeGreaterThanOrEqual(4.5);
      expect(ratio).toBeLessThanOrEqual(5.5);
    });

    test("missing usage means full headroom", () => {
      installMonotonicClock();
      writeConfig(["nousage", "nosession", "nopercent", "full"]);
      writeEnvelope("nousage", { subscription_active: true, usage: null });
      writeEnvelope("nosession", { subscription_active: true, usage: {} });
      writeEnvelope("nopercent", {
        subscription_active: true,
        usage: { session: {} },
      });
      writeEnvelope("full", {
        subscription_active: true,
        session_percent: 0.0,
      });

      for (let i = 0; i < 400; i++) {
        pickProfile();
      }

      const counts = readCounts();
      const vals = Object.values(counts);
      expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1);
    });
  },
);
