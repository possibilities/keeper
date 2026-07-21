import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveKeeperStateDir, resolveRestartLedgerPath } from "../src/db";
import { resolveOperatorReloadAttributionPath } from "../src/restart-ledger";

// Pins the writer (scripts/install.sh's `fingerprint_dir`) and reader
// (resolveRestartLedgerPath / resolveOperatorReloadAttributionPath) to the
// SAME directory for both a set and an unset XDG_STATE_HOME, so the
// operator-reload attribution leaf install.sh writes is always found —
// see docs/adr for the writer-side convention this mirrors.

const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
const ORIGINAL_KEEPER_RESTART_LEDGER = process.env.KEEPER_RESTART_LEDGER;

afterEach(() => {
  if (ORIGINAL_XDG_STATE_HOME === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME;
  }
  if (ORIGINAL_KEEPER_RESTART_LEDGER === undefined) {
    delete process.env.KEEPER_RESTART_LEDGER;
  } else {
    process.env.KEEPER_RESTART_LEDGER = ORIGINAL_KEEPER_RESTART_LEDGER;
  }
});

test("resolveKeeperStateDir: unset XDG_STATE_HOME falls back to ~/.local/state/keeper", () => {
  delete process.env.XDG_STATE_HOME;
  expect(resolveKeeperStateDir()).toBe(
    join(homedir(), ".local", "state", "keeper"),
  );
});

test("resolveKeeperStateDir: empty XDG_STATE_HOME falls back to ~/.local/state/keeper", () => {
  process.env.XDG_STATE_HOME = "";
  expect(resolveKeeperStateDir()).toBe(
    join(homedir(), ".local", "state", "keeper"),
  );
});

test("resolveKeeperStateDir: non-default XDG_STATE_HOME matches install.sh's fingerprint_dir convention", () => {
  process.env.XDG_STATE_HOME = "/custom/xdg-state";
  // Mirrors scripts/install.sh:451 —
  // fingerprint_dir="${XDG_STATE_HOME:-${HOME}/.local/state}/keeper"
  expect(resolveKeeperStateDir()).toBe("/custom/xdg-state/keeper");
});

test("resolveRestartLedgerPath: unset XDG_STATE_HOME resolves under ~/.local/state/keeper", () => {
  delete process.env.XDG_STATE_HOME;
  delete process.env.KEEPER_RESTART_LEDGER;
  expect(resolveRestartLedgerPath()).toBe(
    join(homedir(), ".local", "state", "keeper", "restart-ledger.json"),
  );
});

test("resolveRestartLedgerPath: non-default XDG_STATE_HOME resolves under the SAME dir install.sh writes to", () => {
  process.env.XDG_STATE_HOME = "/custom/xdg-state";
  delete process.env.KEEPER_RESTART_LEDGER;
  expect(resolveRestartLedgerPath()).toBe(
    "/custom/xdg-state/keeper/restart-ledger.json",
  );
});

test("resolveRestartLedgerPath: KEEPER_RESTART_LEDGER override wins even when XDG_STATE_HOME is set", () => {
  process.env.XDG_STATE_HOME = "/custom/xdg-state";
  process.env.KEEPER_RESTART_LEDGER = "/explicit/override/restart-ledger.json";
  expect(resolveRestartLedgerPath()).toBe(
    "/explicit/override/restart-ledger.json",
  );
});

test("resolveOperatorReloadAttributionPath: tracks the restart-ledger dir under a non-default XDG_STATE_HOME", () => {
  process.env.XDG_STATE_HOME = "/custom/xdg-state";
  delete process.env.KEEPER_RESTART_LEDGER;
  const restartLedgerPath = resolveRestartLedgerPath();
  expect(resolveOperatorReloadAttributionPath(restartLedgerPath)).toBe(
    "/custom/xdg-state/keeper/install-reload-attribution.json",
  );
});

test("resolveOperatorReloadAttributionPath: shares the KEEPER_RESTART_LEDGER override's directory", () => {
  process.env.XDG_STATE_HOME = "/custom/xdg-state";
  process.env.KEEPER_RESTART_LEDGER = "/explicit/override/restart-ledger.json";
  const restartLedgerPath = resolveRestartLedgerPath();
  expect(resolveOperatorReloadAttributionPath(restartLedgerPath)).toBe(
    "/explicit/override/install-reload-attribution.json",
  );
});
