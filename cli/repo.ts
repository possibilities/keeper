#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import {
  resolveRepoCloneRoot,
  resolveRepoCreateRoot,
  resolveRepoForkRoot,
} from "../src/db";
import { cloneRepo, createRepo, forkRepo, RepoOpsError } from "../src/repo-ops";
import { emitEnvelope, errorEnvelope, successEnvelope } from "./envelope";

export const REPO_SCHEMA_VERSION = 1;

export const HELP = `keeper repo — create, clone, and fork GitHub repositories

Usage:
  keeper repo create <name> [--root <path>]
  keeper repo clone <owner>/<name-or-url> [--root <path>]
  keeper repo fork <owner>/<name-or-url> [--root <path>]

Defaults:
  create  repo_create_root / KEEPER_REPO_CREATE_ROOT / ~/code
  clone   repo_clone_root  / KEEPER_REPO_CLONE_ROOT  / ~/src
  fork    repo_fork_root   / KEEPER_REPO_FORK_ROOT   / ~/src

clone/fork destinations use <owner>--<repo> names under the destination root.
A self-owned fork also clones the upstream sibling and configures upstream.

Flags:
  --root <path>  Override the destination root for this invocation.
  --help, -h     Show this help
`;

interface ParsedRepoArgs {
  verb: string;
  target: string | null;
  root: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedRepoArgs {
  const first = argv[0];
  const out: ParsedRepoArgs = {
    verb: first === "--help" || first === "-h" ? "" : (first ?? ""),
    target: null,
    root: null,
    help: false,
  };
  for (let i = out.verb === "" ? 0 : 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--root") out.root = requireValue(argv, ++i, "--root");
    else if (a.startsWith("--root=")) out.root = a.slice("--root=".length);
    else if (a.startsWith("-")) usage(`unexpected argument '${a}'`);
    else if (out.target === null) out.target = a;
    else usage(`unexpected argument '${a}'`);
  }
  return out;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const value = argv[i];
  if (value === undefined) usage(`${flag} requires a value`);
  return value as string;
}

function usage(message: string): never {
  process.stderr.write(`keeper repo: ${message}\n\n${HELP}`);
  process.exit(2);
}

function emitResult(value: unknown): never {
  emitEnvelope(successEnvelope(REPO_SCHEMA_VERSION, value), {
    writeStdout: (s) => process.stdout.write(s),
    exit: (code) => process.exit(code),
  });
  process.exit(0);
}

function expandRoot(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function handleError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  emitEnvelope(
    errorEnvelope(REPO_SCHEMA_VERSION, {
      code:
        err instanceof RepoOpsError
          ? "repo_ops_failed"
          : "repo_unexpected_error",
      message: "repo operation failed",
      recovery:
        "Fix the reported GitHub or git issue and retry. clone/fork are idempotent when the destination origin matches; create is safe to retry only after checking the destination and GitHub repo state.",
      details: { reason: message },
    }),
    {
      writeStdout: (s) => process.stdout.write(s),
      exit: (code) => process.exit(code),
    },
  );
  process.exit(1);
}

export function main(argv: string[]): never {
  const parsed = parseArgs(argv);
  if (parsed.help || parsed.verb === "") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (parsed.target === null) {
    usage(`<target> is required for '${parsed.verb}'`);
  }

  try {
    switch (parsed.verb) {
      case "create":
        return emitResult(
          createRepo({
            name: parsed.target,
            destinationRoot:
              parsed.root !== null
                ? expandRoot(parsed.root)
                : resolveRepoCreateRoot(),
          }),
        );
      case "clone":
        return emitResult(
          cloneRepo({
            input: parsed.target,
            destinationRoot:
              parsed.root !== null
                ? expandRoot(parsed.root)
                : resolveRepoCloneRoot(),
          }),
        );
      case "fork":
        return emitResult(
          forkRepo({
            input: parsed.target,
            destinationRoot:
              parsed.root !== null
                ? expandRoot(parsed.root)
                : resolveRepoForkRoot(),
          }),
        );
      default:
        return usage(`unknown verb '${parsed.verb}'`);
    }
  } catch (err) {
    handleError(err);
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}
