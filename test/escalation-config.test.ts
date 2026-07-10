/**
 * Unit tests for `src/escalation-config.ts` — the escalation-session launch-config
 * resolver. Mirrors the `resolveWorkerLaunchConfig` coverage: the `ESCALATION_*`
 * constant fallback, an `escalation` launch-triple override, the independence from
 * the `worker` triple, the swallow-to-constants posture on a missing/malformed
 * catalog, and the once-per-value non-claude harness warn.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEscalationLaunchConfig } from "../src/escalation-config";
import { ESCALATION_EFFORT, ESCALATION_MODEL } from "../src/reconcile-core";

test("resolveEscalationLaunchConfig: no registry file → ESCALATION_* constants", () => {
  const dir = mkdtempSync(join(tmpdir(), "kpr-esc-presets-"));
  try {
    const cfg = resolveEscalationLaunchConfig(join(dir, "presets.yaml"));
    expect(cfg).toEqual({ model: ESCALATION_MODEL, effort: ESCALATION_EFFORT });
    // The constants pin sonnet/high by default.
    expect(cfg).toEqual({ model: "sonnet", effort: "high" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveEscalationLaunchConfig: an `escalation` triple overrides model/effort", () => {
  const dir = mkdtempSync(join(tmpdir(), "kpr-esc-presets-"));
  try {
    const path = join(dir, "presets.yaml");
    writeFileSync(path, "escalation: claude::opus::max\n");
    expect(resolveEscalationLaunchConfig(path)).toEqual({
      model: "opus",
      effort: "max",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveEscalationLaunchConfig: independent of the `worker` triple (reads ONLY escalation)", () => {
  const dir = mkdtempSync(join(tmpdir(), "kpr-esc-presets-"));
  try {
    const path = join(dir, "presets.yaml");
    // A `worker` triple is present but there is NO `escalation` triple — the
    // escalation config must ignore `worker` entirely and fall to the constants.
    writeFileSync(path, "worker: claude::opus::high\n");
    expect(resolveEscalationLaunchConfig(path)).toEqual({
      model: ESCALATION_MODEL,
      effort: ESCALATION_EFFORT,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveEscalationLaunchConfig: a malformed registry FALLS BACK to constants without throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "kpr-esc-presets-"));
  try {
    const path = join(dir, "presets.yaml");
    writeFileSync(path, "escalation: not-a-triple\n");
    expect(resolveEscalationLaunchConfig(path)).toEqual({
      model: ESCALATION_MODEL,
      effort: ESCALATION_EFFORT,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveEscalationLaunchConfig: a non-claude escalation harness warns ONCE per value and still launches on claude", () => {
  const dir = mkdtempSync(join(tmpdir(), "kpr-esc-presets-"));
  const errs: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    errs.push(args.map(String).join(" "));
  };
  try {
    const codexPath = join(dir, "codex.yaml");
    writeFileSync(codexPath, "escalation: codex::gpt::high\n");
    // A fresh per-call memo standing in for the dispatch-loop process memo.
    const warned = new Set<string>();
    // The harness is DROPPED, not honored — model/effort still resolve from the
    // triple so the launch proceeds on claude with the configured knobs.
    expect(resolveEscalationLaunchConfig(codexPath, warned)).toEqual({
      model: "gpt",
      effort: "high",
    });
    // A second resolution re-reads the SAME offending value: no new warn.
    resolveEscalationLaunchConfig(codexPath, warned);
    expect(errs.filter((e) => e.includes("pins harness 'codex'")).length).toBe(
      1,
    );
  } finally {
    console.error = origError;
    rmSync(dir, { recursive: true, force: true });
  }
});
