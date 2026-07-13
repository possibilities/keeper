import { describe, expect, test } from "bun:test";
import {
  applyPolicyAllowlist,
  type FastTestPolicyRule,
  lintFastTestSource,
} from "../scripts/lint-fast-tests";

function rules(source: string): FastTestPolicyRule[] {
  return lintFastTestSource("test/new-proof.test.ts", source).map(
    (violation) => violation.rule,
  );
}

describe("fast-test structural policy", () => {
  test("rejects fixed sleeps without matching comments or strings", () => {
    expect(
      rules(`test("wait", async () => { await Bun.sleep(25); });`),
    ).toContain("fixed-sleep");
    expect(rules(`const text = "Bun.sleep(25)"; // setTimeout(20)`)).toEqual(
      [],
    );
  });

  test("rejects real process, Worker, git, tmux, and daemon launch dependencies", () => {
    expect(
      rules(`import { spawn } from "node:child_process"; spawn("x");`),
    ).toContain("process-launch");
    expect(rules(`new Worker("./worker.ts");`)).toContain("process-launch");
    expect(rules(`runner.run(["git", "status"]);`)).toContain("process-launch");
    expect(rules(`launch("tmux new-session");`)).toContain("process-launch");
    expect(rules(`runCommand("keeperd --foreground");`)).toContain(
      "process-launch",
    );
    expect(rules(`startDaemon({});`)).toContain("process-launch");
  });

  test("rejects large scoped timeouts and production-scale fixtures", () => {
    expect(rules(`test("slow", () => {}, 5001);`)).toContain("large-timeout");
    expect(rules(`const body = "x".repeat(1024 * 1024);`)).toContain(
      "production-scale-fixture",
    );
    expect(
      rules(`const rows = Array.from({ length: 10001 }, () => 1);`),
    ).toContain("production-scale-fixture");
  });

  test("rejects direct full migration but permits an explicit no-migrate connection", () => {
    expect(rules(`migrate(db); openDb(":memory:");`)).toEqual([
      "full-migration",
      "full-migration",
    ]);
    expect(rules(`openDb(path, { migrate: false });`)).toEqual([]);
  });

  test("an allowance is exact to file and rule and requires a semantic reason", () => {
    const violations = lintFastTestSource(
      "test/new-proof.test.ts",
      `Bun.sleep(1); migrate(db);`,
    );
    const remaining = applyPolicyAllowlist(violations, [
      {
        file: "test/new-proof.test.ts",
        rule: "fixed-sleep",
        reason: "Scheduler boundary is the reviewed subject.",
      },
    ]);
    expect(remaining.map((violation) => violation.rule)).toEqual([
      "full-migration",
    ]);
    expect(() =>
      applyPolicyAllowlist(violations, [
        {
          file: "test/new-proof.test.ts",
          rule: "fixed-sleep",
          reason: "too short",
        },
      ]),
    ).toThrow("semantic reason");
  });
});
