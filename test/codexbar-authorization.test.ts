import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderRunOutcome } from "../src/account-observation";
import {
  codexBarClaudeUsageArgv,
  codexBarCodexUsageArgv,
} from "../src/account-routing-config";
import {
  authorizeCodexBar,
  codexBarAuthorizationPath,
  grantCodexBarAuthorization,
  isCodexBarProviderAuthorized,
  makeAuthorizedCodexBarRunner,
  makeCodexBarFingerprintResolver,
  makeGenerationBoundCodexBarRunner,
  readCodexBarAuthorization,
} from "../src/codexbar-authorization";

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);

function executable(dir: string, body = "managed-codexbar"): string {
  const path = join(dir, "codexbar");
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

function providerOutcome(argv: string[]): ProviderRunOutcome {
  const provider = argv[argv.indexOf("--provider") + 1];
  if (provider === "claude") {
    return {
      code: 0,
      stdout: JSON.stringify({
        provider: "claude",
        usage: { primary: { usedPercent: 20 } },
      }),
    };
  }
  return {
    code: 0,
    stdout: JSON.stringify({
      provider: "codex",
      usage: {
        secondary: { usedPercent: 40 },
        codexResetCredits: { availableCount: 1 },
      },
    }),
  };
}

describe("CodexBar authorization receipt", () => {
  test("foreground authorization runs providers serially and writes only PII-free authority", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-codexbar-auth-"));
    try {
      const bin = executable(dir);
      const stateDir = join(dir, "state");
      const calls: string[][] = [];
      let active = 0;
      let maximumActive = 0;
      const result = await authorizeCodexBar({
        stateDir,
        codexbarBin: bin,
        nowMs: () => NOW,
        runner: async (argv) => {
          calls.push(argv);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Promise.resolve();
          active -= 1;
          return providerOutcome(argv);
        },
      });

      expect(result.ok).toBe(true);
      expect(maximumActive).toBe(1);
      expect(calls).toEqual([
        codexBarClaudeUsageArgv(realpathSync(bin)),
        codexBarCodexUsageArgv(realpathSync(bin)),
      ]);
      const receipt = readCodexBarAuthorization(stateDir);
      expect(receipt?.binary_sha256).toBe(result.binary_sha256 ?? undefined);
      expect(receipt?.authorized_providers).toEqual(["claude", "codex"]);
      expect(JSON.stringify(receipt)).not.toContain("usedPercent");
      expect(statSync(codexBarAuthorizationPath(stateDir)).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unauthorized provider is skipped while unrelated commands pass through", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-codexbar-auth-"));
    try {
      const bin = executable(dir);
      const stateDir = join(dir, "state");
      const fingerprint = makeCodexBarFingerprintResolver(bin)();
      if (fingerprint === null) throw new Error("fixture fingerprint missing");
      const calls: string[][] = [];
      const runner = makeAuthorizedCodexBarRunner({
        stateDir,
        codexbarBin: bin,
        nowMs: () => NOW,
        runner: async (argv) => {
          calls.push(argv);
          return providerOutcome(argv);
        },
      });

      const blocked = await runner(codexBarClaudeUsageArgv(bin));
      expect(blocked).toEqual({
        code: null,
        stdout: "",
        failure: "authorization-required",
        binary_sha256: fingerprint.sha256,
      });
      const unrelated = ["cswap", "list", "--json"];
      await runner(unrelated);
      expect(calls).toEqual([unrelated]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("generation-bound foreground runner never falls through when fingerprinting fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-codexbar-auth-"));
    try {
      const missing = join(dir, "missing-codexbar");
      let calls = 0;
      const runner = makeGenerationBoundCodexBarRunner({
        codexbarBin: missing,
        runner: async () => {
          calls += 1;
          return { code: 0, stdout: "must-not-run" };
        },
      });
      const outcome = await runner(codexBarClaudeUsageArgv(missing));
      expect(outcome).toEqual({ code: null, stdout: "", failure: "spawn" });
      expect(calls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a provider failure durably blocks later unattended attempts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-codexbar-auth-"));
    try {
      const bin = executable(dir);
      const stateDir = join(dir, "state");
      const fingerprint = makeCodexBarFingerprintResolver(bin)();
      if (fingerprint === null) throw new Error("fixture fingerprint missing");
      grantCodexBarAuthorization(stateDir, fingerprint, "claude", NOW);

      let calls = 0;
      const runner = makeAuthorizedCodexBarRunner({
        stateDir,
        codexbarBin: bin,
        nowMs: () => NOW + 1,
        runner: async () => {
          calls += 1;
          expect(
            readCodexBarAuthorization(stateDir)?.authorized_providers,
          ).not.toContain("claude");
          return { code: null, stdout: "", failure: "timeout" };
        },
      });
      const first = await runner(codexBarClaudeUsageArgv(bin));
      const second = await runner(codexBarClaudeUsageArgv(bin));

      expect(first.failure).toBe("timeout");
      expect(second.failure).toBe("authorization-required");
      expect(calls).toBe(1);
      expect(
        isCodexBarProviderAuthorized(stateDir, fingerprint, "claude"),
      ).toBe(false);
      expect(
        readCodexBarAuthorization(stateDir)?.blocked_providers.claude?.reason,
      ).toBe("provider-failure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrent observer calls atomically consume one provider authority", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-codexbar-auth-"));
    try {
      const bin = executable(dir);
      const stateDir = join(dir, "state");
      const fingerprint = makeCodexBarFingerprintResolver(bin)();
      if (fingerprint === null) throw new Error("fixture fingerprint missing");
      grantCodexBarAuthorization(stateDir, fingerprint, "claude", NOW);

      let rawCalls = 0;
      let announceStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        announceStarted = resolve;
      });
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runner = makeAuthorizedCodexBarRunner({
        stateDir,
        codexbarBin: bin,
        runner: async (argv) => {
          rawCalls += 1;
          announceStarted?.();
          await held;
          return providerOutcome(argv);
        },
      });

      const first = runner(codexBarClaudeUsageArgv(bin));
      await started;
      const second = await runner(codexBarClaudeUsageArgv(bin));
      release?.();
      const firstResult = await first;

      expect(firstResult.code).toBe(0);
      expect(second.failure).toBe("authorization-required");
      expect(rawCalls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stale same-generation completion cannot undo foreground authorization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-codexbar-auth-"));
    try {
      const bin = executable(dir);
      const stateDir = join(dir, "state");
      const fingerprint = makeCodexBarFingerprintResolver(bin)();
      if (fingerprint === null) throw new Error("fixture fingerprint missing");
      grantCodexBarAuthorization(stateDir, fingerprint, "claude", NOW);

      let announceStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        announceStarted = resolve;
      });
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const observer = makeAuthorizedCodexBarRunner({
        stateDir,
        codexbarBin: bin,
        runner: async () => {
          announceStarted?.();
          await held;
          return { code: null, stdout: "", failure: "timeout" };
        },
      });

      const stale = observer(codexBarClaudeUsageArgv(bin));
      await started;
      const foreground = await authorizeCodexBar({
        stateDir,
        codexbarBin: bin,
        nowMs: () => NOW + 10,
        runner: async (argv) => providerOutcome(argv),
      });
      release?.();
      const staleResult = await stale;

      expect(foreground.ok).toBe(true);
      expect(staleResult.failure).toBe("authorization-required");
      expect(readCodexBarAuthorization(stateDir)?.authorized_providers).toEqual(
        ["claude", "codex"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("generation nonce fences an A to B to A rollback ABA", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-codexbar-auth-"));
    try {
      const aBin = join(dir, "codexbar-a");
      const bBin = join(dir, "codexbar-b");
      writeFileSync(aBin, "generation-a");
      writeFileSync(bBin, "generation-b-with-different-bytes");
      chmodSync(aBin, 0o755);
      chmodSync(bBin, 0o755);
      const stableBin = join(dir, "codexbar");
      symlinkSync(aBin, stableBin);
      const stateDir = join(dir, "state");
      const aFingerprint = makeCodexBarFingerprintResolver(stableBin)();
      const bFingerprint = makeCodexBarFingerprintResolver(bBin)();
      if (aFingerprint === null || bFingerprint === null) {
        throw new Error("fixture fingerprint missing");
      }
      grantCodexBarAuthorization(stateDir, aFingerprint, "claude", NOW);

      let announceStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        announceStarted = resolve;
      });
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const oldObserver = makeAuthorizedCodexBarRunner({
        stateDir,
        codexbarBin: stableBin,
        runner: async (argv) => {
          announceStarted?.();
          await held;
          return providerOutcome(argv);
        },
      });
      const staleA = oldObserver(codexBarClaudeUsageArgv(stableBin));
      await started;

      unlinkSync(stableBin);
      symlinkSync(bBin, stableBin);
      grantCodexBarAuthorization(stateDir, bFingerprint, "claude", NOW + 1);
      unlinkSync(stableBin);
      symlinkSync(aBin, stableBin);
      const deniedNewA = await authorizeCodexBar({
        stateDir,
        codexbarBin: stableBin,
        nowMs: () => NOW + 2,
        runner: async () => ({ code: 1, stdout: "" }),
      });
      const replacementReceipt = readCodexBarAuthorization(stateDir);
      release?.();
      const staleResult = await staleA;

      expect(deniedNewA.ok).toBe(false);
      expect(staleResult.failure).toBe("authorization-required");
      const finalReceipt = readCodexBarAuthorization(stateDir);
      expect(finalReceipt?.binary_sha256).toBe(aFingerprint.sha256);
      expect(finalReceipt?.generation_nonce).toBe(
        replacementReceipt?.generation_nonce,
      );
      expect(finalReceipt?.authorized_providers).not.toContain("claude");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("zero-exit malformed output remains blocked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-codexbar-auth-"));
    try {
      const bin = executable(dir);
      const stateDir = join(dir, "state");
      const fingerprint = makeCodexBarFingerprintResolver(bin)();
      if (fingerprint === null) throw new Error("fixture fingerprint missing");
      grantCodexBarAuthorization(stateDir, fingerprint, "claude", NOW);
      let calls = 0;
      const runner = makeAuthorizedCodexBarRunner({
        stateDir,
        codexbarBin: bin,
        runner: async () => {
          calls += 1;
          return { code: 0, stdout: "not-json" };
        },
      });

      const first = await runner(codexBarClaudeUsageArgv(bin));
      const second = await runner(codexBarClaudeUsageArgv(bin));
      expect(first.code).toBe(0);
      expect(second.failure).toBe("authorization-required");
      expect(calls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("foreground reauthorization immediately re-arms an existing observer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-codexbar-auth-"));
    try {
      const bin = executable(dir);
      const stateDir = join(dir, "state");
      const fingerprint = makeCodexBarFingerprintResolver(bin)();
      if (fingerprint === null) throw new Error("fixture fingerprint missing");
      grantCodexBarAuthorization(stateDir, fingerprint, "claude", NOW);

      let observerCalls = 0;
      let fail = true;
      const runner = makeAuthorizedCodexBarRunner({
        stateDir,
        codexbarBin: bin,
        nowMs: () => NOW + observerCalls,
        runner: async (argv) => {
          observerCalls += 1;
          return fail
            ? { code: null, stdout: "", failure: "timeout" }
            : providerOutcome(argv);
        },
      });
      await runner(codexBarClaudeUsageArgv(bin));
      fail = false;
      await authorizeCodexBar({
        stateDir,
        codexbarBin: bin,
        nowMs: () => NOW + 10,
        runner: async (argv) => providerOutcome(argv),
      });
      const recovered = await runner(codexBarClaudeUsageArgv(bin));

      expect(recovered.code).toBe(0);
      expect(observerCalls).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("receipt I/O failure prevents spawn before and after worker restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-codexbar-auth-"));
    try {
      const bin = executable(dir);
      const stateDir = join(dir, "state");
      const fingerprint = makeCodexBarFingerprintResolver(bin)();
      if (fingerprint === null) throw new Error("fixture fingerprint missing");
      grantCodexBarAuthorization(stateDir, fingerprint, "claude", NOW);
      const lockPath = `${codexBarAuthorizationPath(stateDir)}.lock`;
      rmSync(lockPath, { force: true });
      mkdirSync(lockPath);

      let calls = 0;
      const makeRunner = () =>
        makeAuthorizedCodexBarRunner({
          stateDir,
          codexbarBin: bin,
          runner: async (argv) => {
            calls += 1;
            return providerOutcome(argv);
          },
        });
      const first = await makeRunner()(codexBarClaudeUsageArgv(bin));
      const afterRestart = await makeRunner()(codexBarClaudeUsageArgv(bin));

      expect(first.failure).toBe("authorization-required");
      expect(afterRestart.failure).toBe("authorization-required");
      expect(calls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("spawns the fingerprinted generation and cannot clobber newer authority", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-codexbar-auth-"));
    try {
      const oldBin = join(dir, "codexbar-old");
      const newBin = join(dir, "codexbar-new");
      writeFileSync(oldBin, "old-generation");
      writeFileSync(newBin, "new-generation-with-a-different-digest");
      chmodSync(oldBin, 0o755);
      chmodSync(newBin, 0o755);
      const stableBin = join(dir, "codexbar");
      symlinkSync(oldBin, stableBin);
      const stateDir = join(dir, "state");
      const oldFingerprint = makeCodexBarFingerprintResolver(stableBin)();
      const newFingerprint = makeCodexBarFingerprintResolver(newBin)();
      if (oldFingerprint === null || newFingerprint === null) {
        throw new Error("fixture fingerprint missing");
      }
      grantCodexBarAuthorization(stateDir, oldFingerprint, "claude", NOW);

      const spawned: string[][] = [];
      const runner = makeAuthorizedCodexBarRunner({
        stateDir,
        codexbarBin: stableBin,
        nowMs: () => NOW + 1,
        runner: async (argv) => {
          spawned.push(argv);
          unlinkSync(stableBin);
          symlinkSync(newBin, stableBin);
          grantCodexBarAuthorization(
            stateDir,
            newFingerprint,
            "codex",
            NOW + 1,
          );
          return { code: null, stdout: "", failure: "timeout" };
        },
      });
      await runner(codexBarClaudeUsageArgv(stableBin));

      expect(spawned[0]?.[0]).toBe(realpathSync(oldBin));
      const receipt = readCodexBarAuthorization(stateDir);
      expect(receipt?.binary_sha256).toBe(newFingerprint.sha256);
      expect(receipt?.authorized_providers).toEqual(["codex"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale foreground authorization cannot overwrite a newer receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-codexbar-auth-"));
    try {
      const oldBin = join(dir, "codexbar-old");
      const newBin = join(dir, "codexbar-new");
      writeFileSync(oldBin, "old-generation");
      writeFileSync(newBin, "new-generation-with-a-different-digest");
      chmodSync(oldBin, 0o755);
      chmodSync(newBin, 0o755);
      const stableBin = join(dir, "codexbar");
      symlinkSync(oldBin, stableBin);
      const stateDir = join(dir, "state");
      const newFingerprint = makeCodexBarFingerprintResolver(newBin)();
      if (newFingerprint === null) throw new Error("new fingerprint missing");
      let calls = 0;

      const result = await authorizeCodexBar({
        stateDir,
        codexbarBin: stableBin,
        nowMs: () => NOW + calls,
        runner: async (argv) => {
          calls += 1;
          unlinkSync(stableBin);
          symlinkSync(newBin, stableBin);
          grantCodexBarAuthorization(
            stateDir,
            newFingerprint,
            "codex",
            NOW + 1,
          );
          return providerOutcome(argv);
        },
      });

      expect(result.ok).toBe(false);
      expect(calls).toBe(1);
      const receipt = readCodexBarAuthorization(stateDir);
      expect(receipt?.binary_sha256).toBe(newFingerprint.sha256);
      expect(receipt?.authorized_providers).toEqual(["codex"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("changing the executable digest invalidates prior authorization", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-codexbar-auth-"));
    try {
      const bin = executable(dir, "first-generation");
      const stateDir = join(dir, "state");
      const first = makeCodexBarFingerprintResolver(bin)();
      if (first === null) throw new Error("first fingerprint missing");
      grantCodexBarAuthorization(stateDir, first, "claude", NOW);

      writeFileSync(bin, "different-second-generation");
      chmodSync(bin, 0o755);
      const second = makeCodexBarFingerprintResolver(bin)();
      if (second === null) throw new Error("second fingerprint missing");

      expect(second.sha256).not.toBe(first.sha256);
      expect(isCodexBarProviderAuthorized(stateDir, second, "claude")).toBe(
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
