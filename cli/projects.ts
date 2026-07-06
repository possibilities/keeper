#!/usr/bin/env bun
import {
  loadProjectRoots,
  type ProjectRoot,
  projectDescriptions,
  rankProjects,
  resolveRootSelector,
} from "../src/projects";
import { emitEnvelope, successEnvelope } from "./envelope";

export const PROJECTS_SCHEMA_VERSION = 1;

export const HELP = `keeper projects — list keeper-root projects ranked from keeper activity

Usage:
  keeper projects roots [--names]
  keeper projects names [--root <name-or-path>] [--limit <n>] [--raw-list|--names]
  keeper projects ranked [--root <name-or-path>] [--limit <n>]
  keeper projects grouped [--raw-list]
  keeper projects descriptions [--root <name-or-path>] [--limit <n>] [--raw-list] [--compact]

Project discovery uses keeper's configured roots (~/.config/keeper/config.yaml
'roots:', default ~/code). Ranking uses keeper.db job activity for sessions whose
cwd is inside an immediate child of a configured root, plus cheap git-index and
directory mtime hints.

Flags:
  --root <name-or-path>  Filter to a configured root. Root names are basenames
                         (e.g. ~/code -> code); absolute paths also work.
  --limit <n>           Max rows (0 = all). names/ranked default 0;
                         descriptions default 20.
  --raw-list            Emit the bare JSON list, for form option providers.
  --names               roots: emit root names; names: alias for --raw-list.
  --compact             descriptions: comma-separated single line.
  --help, -h            Show this help
`;

interface ParsedArgs {
  verb: string;
  root: string | null;
  limit: number | null;
  rawList: boolean;
  names: boolean;
  compact: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const first = argv[0];
  const out: ParsedArgs = {
    verb: first === "--help" || first === "-h" ? "" : (first ?? ""),
    root: null,
    limit: null,
    rawList: false,
    names: false,
    compact: false,
    help: false,
  };
  for (let i = out.verb === "" ? 0 : 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--raw-list") out.rawList = true;
    else if (a === "--names") out.names = true;
    else if (a === "--compact") out.compact = true;
    else if (a === "--root") out.root = requireValue(argv, ++i, "--root");
    else if (a.startsWith("--root=")) out.root = a.slice("--root=".length);
    else if (a === "--limit")
      out.limit = parseLimit(requireValue(argv, ++i, "--limit"));
    else if (a.startsWith("--limit="))
      out.limit = parseLimit(a.slice("--limit=".length));
    else usage(`unexpected argument '${a}'`);
  }
  return out;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const value = argv[i];
  if (value === undefined) usage(`${flag} requires a value`);
  return value as string;
}

function parseLimit(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    usage(`--limit must be a non-negative integer (got '${raw}')`);
  }
  return n;
}

function usage(message: string): never {
  process.stderr.write(`keeper projects: ${message}\n\n${HELP}`);
  process.exit(2);
}

function emitJson(value: unknown): never {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exit(0);
}

function filteredRoots(
  roots: readonly ProjectRoot[],
  selector: string | null,
): ProjectRoot[] {
  if (selector === null) return [...roots];
  const root = resolveRootSelector(roots, selector);
  if (root === null) usage(`unknown root '${selector}'`);
  return [root];
}

function applyLimit<T>(rows: T[], limit: number): T[] {
  return limit > 0 ? rows.slice(0, limit) : rows;
}

export function main(argv: string[]): never {
  const parsed = parseArgs(argv);
  if (parsed.help || parsed.verb === "") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const roots = loadProjectRoots();
  switch (parsed.verb) {
    case "roots": {
      if (parsed.names || parsed.rawList) emitJson(roots.map((r) => r.name));
      emitEnvelope(successEnvelope(PROJECTS_SCHEMA_VERSION, { roots }), {
        writeStdout: (s) => process.stdout.write(s),
        exit: (code) => process.exit(code),
      });
      return process.exit(0);
    }
    case "names": {
      const ranked = applyLimit(
        rankProjects(filteredRoots(roots, parsed.root)),
        parsed.limit ?? 0,
      );
      if (parsed.names || parsed.rawList) emitJson(ranked.map((p) => p.name));
      emitEnvelope(
        successEnvelope(PROJECTS_SCHEMA_VERSION, { projects: ranked }),
        {
          writeStdout: (s) => process.stdout.write(s),
          exit: (code) => process.exit(code),
        },
      );
      return process.exit(0);
    }
    case "ranked": {
      const ranked = applyLimit(
        rankProjects(filteredRoots(roots, parsed.root)),
        parsed.limit ?? 0,
      );
      emitEnvelope(
        successEnvelope(PROJECTS_SCHEMA_VERSION, { projects: ranked }),
        {
          writeStdout: (s) => process.stdout.write(s),
          exit: (code) => process.exit(code),
        },
      );
      return process.exit(0);
    }
    case "grouped": {
      const tabs = roots.map((root) => ({
        name: root.name,
        options: rankProjects([root]).map((p) => p.name),
      }));
      if (parsed.rawList) emitJson(tabs);
      emitEnvelope(successEnvelope(PROJECTS_SCHEMA_VERSION, { groups: tabs }), {
        writeStdout: (s) => process.stdout.write(s),
        exit: (code) => process.exit(code),
      });
      return process.exit(0);
    }
    case "descriptions": {
      const ranked = applyLimit(
        rankProjects(filteredRoots(roots, parsed.root)),
        parsed.limit ?? 20,
      );
      const descriptions = projectDescriptions(ranked);
      const lines = descriptions.map((d) => d.line);
      if (parsed.compact) {
        process.stdout.write(`${lines.join(",")}\n`);
        process.exit(0);
      }
      if (parsed.rawList || parsed.names) emitJson(lines);
      emitEnvelope(successEnvelope(PROJECTS_SCHEMA_VERSION, { descriptions }), {
        writeStdout: (s) => process.stdout.write(s),
        exit: (code) => process.exit(code),
      });
      return process.exit(0);
    }
    default:
      usage(`unknown verb '${parsed.verb}'`);
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}
