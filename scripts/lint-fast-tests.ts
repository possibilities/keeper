#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  loadTestManifest,
  repoRootFromScripts,
  type TestClass,
} from "./test-manifest";

export type FastTestPolicyRule =
  | "fixed-sleep"
  | "process-launch"
  | "large-timeout"
  | "production-scale-fixture"
  | "full-migration";

export type PolicyViolation = {
  file: string;
  rule: FastTestPolicyRule;
  line: number;
  column: number;
  detail: string;
};

export type PolicyAllowance = {
  file: string;
  rule: FastTestPolicyRule;
  reason: string;
};

// Each allowance is rule- and file-specific. A new file, a different slow
// dependency, or a misspelled path remains a hard failure.
export const FAST_TEST_POLICY_ALLOWLIST: readonly PolicyAllowance[] = [
  {
    file: "plugins/plan/test/audit-followup-submit.test.ts",
    rule: "production-scale-fixture",
    reason: "Reviewed byte-limit boundary requires an over-limit payload.",
  },
  {
    file: "plugins/plan/test/audit-submit.test.ts",
    rule: "production-scale-fixture",
    reason: "Reviewed byte-limit boundary requires an over-limit payload.",
  },
  {
    file: "plugins/plan/test/audit-verdict-submit.test.ts",
    rule: "production-scale-fixture",
    reason: "Reviewed byte-limit boundary requires an over-limit payload.",
  },
  {
    file: "plugins/plan/test/commit-guard.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-boundary compatibility fixture remains isolated and bounded.",
  },
  {
    file: "plugins/plan/test/consistency-generated-guard.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-boundary compatibility fixture remains isolated and bounded.",
  },
  {
    file: "plugins/plan/test/lib.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-boundary compatibility fixture remains isolated and bounded.",
  },
  {
    file: "plugins/plan/test/saga-epic-rm.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-boundary compatibility fixture remains isolated and bounded.",
  },
  {
    file: "plugins/plan/test/saga-scaffold.test.ts",
    rule: "production-scale-fixture",
    reason: "Reviewed byte-limit boundary requires an over-limit payload.",
  },
  {
    file: "plugins/plan/test/src-creation-machinery.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-boundary compatibility fixture remains isolated and bounded.",
  },
  {
    file: "plugins/plan/test/src-integrity.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-boundary compatibility fixture remains isolated and bounded.",
  },
  {
    file: "plugins/plan/test/src-scaffold-dryrun.test.ts",
    rule: "production-scale-fixture",
    reason: "Reviewed byte-limit boundary requires an over-limit payload.",
  },
  {
    file: "plugins/plan/test/src-store-write.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-boundary compatibility fixture remains isolated and bounded.",
  },
  {
    file: "plugins/plan/test/state-read-guard.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-boundary compatibility fixture remains isolated and bounded.",
  },
  {
    file: "plugins/plan/test/stop-guard.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-boundary compatibility fixture remains isolated and bounded.",
  },
  {
    file: "plugins/plan/test/subagent-stop-guard.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-boundary compatibility fixture remains isolated and bounded.",
  },
  {
    file: "plugins/plan/test/verbs-creation.test.ts",
    rule: "production-scale-fixture",
    reason: "Reviewed byte-limit boundary requires an over-limit payload.",
  },
  {
    file: "plugins/prompt/test/render_plugin_templates.test.ts",
    rule: "large-timeout",
    reason:
      "Reviewed multi-root compiler publication fixture retains its scoped timeout.",
  },
  {
    file: "test/autopilot-worker.test.ts",
    rule: "fixed-sleep",
    reason:
      "Reviewed scheduler-boundary fixture retains its legacy timing probe.",
  },
  {
    file: "test/autopilot-worker.test.ts",
    rule: "full-migration",
    reason:
      "Reviewed schema or file-connection semantics require a real migrated database.",
  },
  {
    file: "test/autopilot-worker.test.ts",
    rule: "large-timeout",
    reason: "Reviewed stress-boundary case retains its scoped timeout.",
  },
  {
    file: "test/autopilot-worker.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-boundary compatibility fixture remains isolated and bounded.",
  },
  {
    file: "test/await.test.ts",
    rule: "fixed-sleep",
    reason:
      "Reviewed scheduler-boundary fixture retains its legacy timing probe.",
  },
  {
    file: "test/baseline-worker.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-boundary compatibility fixture remains isolated and bounded.",
  },
  {
    file: "test/birth-ingest-worker.test.ts",
    rule: "full-migration",
    reason:
      "Reviewed schema or file-connection semantics require a real migrated database.",
  },
  {
    file: "test/commit-work-foundation.test.ts",
    rule: "fixed-sleep",
    reason:
      "Reviewed scheduler-boundary fixture retains its legacy timing probe.",
  },
  {
    file: "test/commit-work.test.ts",
    rule: "production-scale-fixture",
    reason: "Reviewed adoption-count boundary requires one over-limit payload.",
  },
  {
    file: "test/daemon.test.ts",
    rule: "full-migration",
    reason:
      "Reviewed schema or file-connection semantics require a real migrated database.",
  },
  {
    file: "test/daemon.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-boundary compatibility fixture remains isolated and bounded.",
  },
  {
    file: "test/dash-app.test.ts",
    rule: "fixed-sleep",
    reason:
      "Reviewed scheduler-boundary fixture retains its legacy timing probe.",
  },
  {
    file: "test/db.test.ts",
    rule: "full-migration",
    reason:
      "Reviewed schema or file-connection semantics require a real migrated database.",
  },
  {
    file: "test/dead-letter-worker.test.ts",
    rule: "full-migration",
    reason:
      "Reviewed schema or file-connection semantics require a real migrated database.",
  },
  {
    file: "test/docs-pusher.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-boundary compatibility fixture remains isolated and bounded.",
  },
  {
    file: "test/events-ingest-worker.test.ts",
    rule: "full-migration",
    reason:
      "Reviewed schema or file-connection semantics require a real migrated database.",
  },
  {
    file: "test/events-ingest-worker.test.ts",
    rule: "large-timeout",
    reason: "Reviewed stress-boundary case retains its scoped timeout.",
  },
  {
    file: "test/escalation-guard.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-vector decision fixture does not execute its git tokens.",
  },
  {
    file: "test/exit-watcher.test.ts",
    rule: "fixed-sleep",
    reason:
      "Reviewed scheduler-boundary fixture retains its legacy timing probe.",
  },
  {
    file: "test/exit-watcher.test.ts",
    rule: "full-migration",
    reason:
      "Reviewed schema or file-connection semantics require a real migrated database.",
  },
  {
    file: "test/git-boot-seed.test.ts",
    rule: "full-migration",
    reason:
      "Reviewed schema or file-connection semantics require a real migrated database.",
  },
  {
    file: "test/hermes-shim.test.ts",
    rule: "production-scale-fixture",
    reason: "Reviewed byte-limit boundary requires an over-limit payload.",
  },
  {
    file: "test/keeper-cli.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-vector decision fixture does not execute its git tokens.",
  },
  {
    file: "test/lint-retired-name.test.ts",
    rule: "process-launch",
    reason:
      "Reviewed command-boundary compatibility fixture remains isolated and bounded.",
  },
  {
    file: "test/maintenance-worker.test.ts",
    rule: "full-migration",
    reason:
      "Reviewed schema or file-connection semantics require a real migrated database.",
  },
  {
    file: "test/plan-worker.test.ts",
    rule: "full-migration",
    reason:
      "Reviewed schema or file-connection semantics require a real migrated database.",
  },
  {
    file: "test/readiness-client.test.ts",
    rule: "fixed-sleep",
    reason:
      "Reviewed scheduler-boundary fixture retains its legacy timing probe.",
  },
  {
    file: "test/rebase-schema-migration.test.ts",
    rule: "full-migration",
    reason:
      "Reviewed schema or file-connection semantics require a real migrated database.",
  },
  {
    file: "test/reclaim.test.ts",
    rule: "large-timeout",
    reason: "Reviewed stress-boundary case retains its scoped timeout.",
  },
  {
    file: "test/refold-equivalence.test.ts",
    rule: "full-migration",
    reason:
      "Reviewed schema or file-connection semantics require a real migrated database.",
  },
  {
    file: "test/session-state.test.ts",
    rule: "full-migration",
    reason:
      "Reviewed schema or file-connection semantics require a real migrated database.",
  },
  {
    file: "test/tabs.test.ts",
    rule: "fixed-sleep",
    reason:
      "Reviewed scheduler-boundary fixture retains its legacy timing probe.",
  },
  {
    file: "test/template-db.test.ts",
    rule: "full-migration",
    reason:
      "Reviewed schema or file-connection semantics require a real migrated database.",
  },
  {
    file: "test/tmux-control-worker.test.ts",
    rule: "fixed-sleep",
    reason:
      "Reviewed scheduler-boundary fixture retains its legacy timing probe.",
  },
  {
    file: "test/wake-worker.test.ts",
    rule: "fixed-sleep",
    reason:
      "Reviewed scheduler-boundary fixture retains its legacy timing probe.",
  },
  {
    file: "test/wake-worker.test.ts",
    rule: "full-migration",
    reason:
      "Reviewed schema or file-connection semantics require a real migrated database.",
  },
];

function numberValue(node: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll("_", ""));
  if (ts.isParenthesizedExpression(node)) return numberValue(node.expression);
  if (ts.isBinaryExpression(node)) {
    const left = numberValue(node.left);
    const right = numberValue(node.right);
    if (left === undefined || right === undefined) return undefined;
    if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken)
      return left * right;
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return left + right;
  }
  return undefined;
}

function callName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression))
    return `${callName(expression.expression)}.${expression.name.text}`;
  return "";
}

function hasMigrateFalse(node: ts.CallExpression): boolean {
  const options = node.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === "migrate") ||
        (ts.isStringLiteral(property.name) &&
          property.name.text === "migrate")) &&
      property.initializer.kind === ts.SyntaxKind.FalseKeyword,
  );
}

export function lintFastTestSource(
  file: string,
  source: string,
): PolicyViolation[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: PolicyViolation[] = [];
  const report = (
    node: ts.Node,
    rule: FastTestPolicyRule,
    detail: string,
  ): void => {
    const pos = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
    violations.push({
      file,
      rule,
      line: pos.line + 1,
      column: pos.character + 1,
      detail,
    });
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (
        [
          "node:child_process",
          "child_process",
          "node:worker_threads",
          "worker_threads",
        ].includes(node.moduleSpecifier.text)
      ) {
        report(node, "process-launch", `imports ${node.moduleSpecifier.text}`);
      }
    }
    if (
      ts.isNewExpression(node) &&
      callName(node.expression).endsWith("Worker")
    ) {
      report(node, "process-launch", "constructs a Worker");
    }
    if (ts.isTaggedTemplateExpression(node) && callName(node.tag) === "$") {
      report(node, "process-launch", "uses Bun shell");
    }
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (
        [
          "Bun.spawn",
          "Bun.spawnSync",
          "spawn",
          "spawnSync",
          "exec",
          "execSync",
          "execFile",
          "execFileSync",
          "fork",
        ].includes(name)
      ) {
        report(node, "process-launch", `calls ${name}`);
      }
      if (/^(?:start|boot|run)Daemon$/.test(name)) {
        report(node, "process-launch", `calls ${name}`);
      }
      if (/(?:run|launch|command|exec|spawn)$/i.test(name)) {
        const first = node.arguments[0];
        const command =
          first && ts.isStringLiteral(first)
            ? first.text
            : first &&
                ts.isArrayLiteralExpression(first) &&
                first.elements[0] &&
                ts.isStringLiteral(first.elements[0])
              ? first.elements[0].text
              : undefined;
        if (command && /^(?:git|tmux|keeper(?:d)?)(?:\s|$)/.test(command)) {
          report(node, "process-launch", `launches ${command.split(/\s+/)[0]}`);
        }
      }
      if (name === "Bun.sleep" || name === "sleep") {
        report(node, "fixed-sleep", `calls ${name}`);
      }
      if (name === "setTimeout") {
        const delay = node.arguments[1]
          ? numberValue(node.arguments[1])
          : undefined;
        if (delay !== undefined && delay > 0)
          report(node, "fixed-sleep", `setTimeout(${delay}ms)`);
      }
      if (
        ["test", "it", "describe", "test.serial", "it.serial"].includes(name)
      ) {
        const timeout = node.arguments[2]
          ? numberValue(node.arguments[2])
          : undefined;
        if (timeout !== undefined && timeout > 5_000)
          report(node, "large-timeout", `${name} timeout ${timeout}ms`);
      }
      if (name === "setDefaultTimeout") {
        const timeout = node.arguments[0]
          ? numberValue(node.arguments[0])
          : undefined;
        if (timeout !== undefined && timeout > 5_000)
          report(node, "large-timeout", `default timeout ${timeout}ms`);
      }
      if (name === "migrate" || (name === "openDb" && !hasMigrateFalse(node))) {
        report(node, "full-migration", `calls ${name} without migrate:false`);
      }
      if (
        name === "Array.from" &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const length = node.arguments[0].properties.find(
          (property) =>
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === "length",
        );
        if (length && ts.isPropertyAssignment(length)) {
          const size = numberValue(length.initializer);
          if (size !== undefined && size > 10_000)
            report(
              node,
              "production-scale-fixture",
              `Array.from length ${size}`,
            );
        }
      }
      if (name.endsWith(".repeat") && node.arguments[0]) {
        const size = numberValue(node.arguments[0]);
        if (size !== undefined && size > 100_000)
          report(node, "production-scale-fixture", `repeat count ${size}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return violations;
}

export function applyPolicyAllowlist(
  violations: readonly PolicyViolation[],
  allowances: readonly PolicyAllowance[] = FAST_TEST_POLICY_ALLOWLIST,
): PolicyViolation[] {
  for (const allowance of allowances) {
    if (allowance.reason.trim().length < 12)
      throw new Error(
        `fast-test policy allowance needs a semantic reason: ${allowance.file}:${allowance.rule}`,
      );
  }
  return violations.filter(
    (violation) =>
      !allowances.some(
        (allowance) =>
          allowance.file === violation.file &&
          allowance.rule === violation.rule,
      ),
  );
}

export function lintFastTests(repoRoot: string): PolicyViolation[] {
  const audit = loadTestManifest(repoRoot);
  const phases: TestClass[] = ["root", "plan", "prompt", "opentui"];
  const violations = phases
    .flatMap((phase) => audit.files[phase])
    .flatMap((file) =>
      lintFastTestSource(file, readFileSync(join(repoRoot, file), "utf8")),
    );
  return applyPolicyAllowlist(violations).sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.rule.localeCompare(b.rule),
  );
}

export function formatPolicyViolations(
  violations: readonly PolicyViolation[],
): string {
  return violations
    .map((v) => `${v.file}:${v.line}:${v.column} [${v.rule}] ${v.detail}`)
    .join("\n");
}

function main(): number {
  const violations = lintFastTests(repoRootFromScripts());
  if (violations.length === 0) {
    process.stdout.write("fast-test policy: PASS\n");
    return 0;
  }
  process.stderr.write(
    `fast-test policy: FAIL (${violations.length})\n${formatPolicyViolations(violations)}\n`,
  );
  return 1;
}

if (import.meta.main) process.exit(main());
