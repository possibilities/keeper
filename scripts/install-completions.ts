#!/usr/bin/env bun
/**
 * Installer bridge: write keeper's shell-completion scripts into shell-owned user
 * locations, idempotently, and print any activation snippet the human must opt
 * into. `scripts/install.sh` calls this after `bun link`; a `KEEPER_SKIP_COMPLETIONS=1`
 * escape hatch (checked in the bash caller) skips it entirely.
 *
 * The scripts themselves come from the same in-process Clerc metadata as
 * `keeper --help --json` via {@link generateCompletionScript}, so no linked
 * `keeper` binary is required to generate them. This helper NEVER edits `.zshrc`,
 * `.bashrc`, `.bash_profile`, or fish config — it only writes managed completion
 * files and prints activation notes for shells that need a user opt-in.
 *
 * Destination selection and write planning are pure functions (they take a fake
 * home, XDG variables, an optional brew prefix, and a writability probe) so tests
 * exercise them against temporary directories only.
 */
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type CompletionShell, generateCompletionScript } from "../cli/keeper";
import packageJson from "../package.json" with { type: "json" };

export type ShellName = CompletionShell;

/** Inputs to destination planning. `dirWritable` is injected so planning stays
 *  pure and testable — the CLI supplies a real filesystem probe. */
export interface DestEnv {
  home: string;
  xdgConfigHome?: string;
  xdgDataHome?: string;
  /** Homebrew prefix, when detectable — enables a zsh site-functions placement
   *  that is already on the default `fpath` (no rc edit needed). */
  brewPrefix?: string;
  /** True iff `dir` is an existing writable directory. */
  dirWritable: (dir: string) => boolean;
}

export interface CompletionDest {
  shell: ShellName;
  /** Directory to create (`mkdir -p`) before writing. */
  dir: string;
  /** Absolute path of the managed completion file. */
  path: string;
  /** A concise activation snippet the human must opt into, or null when the
   *  location autoloads with no user action. */
  activation: string | null;
}

function trimmed(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && v.length > 0 ? v : undefined;
}

function configHome(env: DestEnv): string {
  return trimmed(env.xdgConfigHome) ?? join(env.home, ".config");
}

function dataHome(env: DestEnv): string {
  return trimmed(env.xdgDataHome) ?? join(env.home, ".local", "share");
}

/** fish autoloads user completions from its config dir — no activation needed. */
export function planFishDest(env: DestEnv): CompletionDest {
  const dir = join(configHome(env), "fish", "completions");
  return {
    shell: "fish",
    dir,
    path: join(dir, "keeper.fish"),
    activation: null,
  };
}

/** bash-completion v2 autoloads command files from the XDG data dir; the only
 *  caveat is that the bash-completion package must be installed and sourced. */
export function planBashDest(env: DestEnv): CompletionDest {
  const dir = join(dataHome(env), "bash-completion", "completions");
  return {
    shell: "bash",
    dir,
    path: join(dir, "keeper"),
    activation:
      "bash: completions autoload via the bash-completion package (v2.11+). " +
      "If TAB does not complete `keeper`, install bash-completion and ensure it " +
      "is sourced from your shell startup.",
  };
}

/** Prefer a writable site-functions dir already on the default `fpath` (brew's
 *  zsh puts `<prefix>/share/zsh/site-functions` there) so no rc edit is needed;
 *  otherwise fall back to a user dir with an explicit fpath activation note. */
export function planZshDest(env: DestEnv): CompletionDest {
  const brewPrefix = trimmed(env.brewPrefix);
  if (brewPrefix) {
    const siteFns = join(brewPrefix, "share", "zsh", "site-functions");
    if (env.dirWritable(siteFns)) {
      return {
        shell: "zsh",
        dir: siteFns,
        path: join(siteFns, "_keeper"),
        activation: null,
      };
    }
  }
  const dir = join(dataHome(env), "zsh", "site-functions");
  return {
    shell: "zsh",
    dir,
    path: join(dir, "_keeper"),
    activation:
      "zsh: add this directory to fpath before compinit, e.g. in ~/.zshrc:\n" +
      `  fpath=(${dir} $fpath)\n` +
      "  autoload -Uz compinit && compinit",
  };
}

/** Plan every shell's destination. Order is stable for deterministic output. */
export function planCompletionDests(env: DestEnv): CompletionDest[] {
  return [planBashDest(env), planZshDest(env), planFishDest(env)];
}

export type WriteOutcome = "written" | "unchanged";

export interface WriteResult {
  shell: ShellName;
  path: string;
  outcome: WriteOutcome;
  activation: string | null;
}

/** Write one managed completion file idempotently: a rerun whose generated
 *  content matches the existing file is a no-op (`unchanged`); otherwise the file
 *  is created or overwritten in place. Never appends — the file is fully managed. */
export function writeCompletion(
  dest: CompletionDest,
  content: string,
): WriteResult {
  if (existsSync(dest.path) && readFileSync(dest.path, "utf8") === content) {
    return {
      shell: dest.shell,
      path: dest.path,
      outcome: "unchanged",
      activation: dest.activation,
    };
  }
  mkdirSync(dest.dir, { recursive: true });
  writeFileSync(dest.path, content);
  return {
    shell: dest.shell,
    path: dest.path,
    outcome: "written",
    activation: dest.activation,
  };
}

/** Plan destinations, generate each script, and write it. `generate` is injected
 *  so tests can supply fixed content instead of running the Clerc generator. */
export async function installCompletions(
  env: DestEnv,
  generate: (shell: ShellName) => Promise<string> = (shell) =>
    generateCompletionScript(shell, packageJson.version),
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  for (const dest of planCompletionDests(env)) {
    const content = await generate(dest.shell);
    results.push(writeCompletion(dest, content));
  }
  return results;
}

/** Existing writable directory probe for the real filesystem. */
export function realDirWritable(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a Homebrew prefix from the environment, falling back to the two
 *  conventional install roots when the dir exists. Returns undefined when none
 *  is detectable — zsh then falls back to the user site-functions dir. */
export function detectBrewPrefix(
  env: Record<string, string | undefined>,
): string | undefined {
  const fromEnv = trimmed(env.HOMEBREW_PREFIX);
  if (fromEnv) return fromEnv;
  for (const candidate of ["/opt/homebrew", "/usr/local"]) {
    if (existsSync(join(candidate, "share", "zsh", "site-functions"))) {
      return candidate;
    }
  }
  return undefined;
}

/** Build the real-filesystem environment from process env. */
export function envFromProcess(
  procEnv: Record<string, string | undefined>,
): DestEnv {
  const home = trimmed(procEnv.HOME);
  if (!home) {
    throw new Error("install-completions: HOME is not set");
  }
  return {
    home,
    xdgConfigHome: procEnv.XDG_CONFIG_HOME,
    xdgDataHome: procEnv.XDG_DATA_HOME,
    brewPrefix: detectBrewPrefix(procEnv),
    dirWritable: realDirWritable,
  };
}

async function cli(): Promise<void> {
  let results: WriteResult[];
  try {
    results = await installCompletions(envFromProcess(process.env));
  } catch (err) {
    // Visible but non-blocking: a completion failure must never fail the daemon
    // install. Report it and exit 0.
    process.stderr.write(
      `install: completions skipped (${
        err instanceof Error ? err.message : String(err)
      })\n`,
    );
    return;
  }

  for (const r of results) {
    process.stdout.write(
      `install: ${r.shell} completions ${
        r.outcome === "written" ? "written to" : "unchanged at"
      } ${r.path}\n`,
    );
  }

  const notes = results
    .filter(
      (r): r is WriteResult & { activation: string } => r.activation !== null,
    )
    .map((r) => r.activation);
  if (notes.length > 0) {
    process.stdout.write("install: shell activation notes:\n");
    for (const note of notes) {
      for (const line of note.split("\n")) {
        process.stdout.write(`  ${line}\n`);
      }
    }
  }
}

if (import.meta.main) {
  void cli();
}
