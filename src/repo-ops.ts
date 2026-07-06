import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export class RepoOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoOpsError";
  }
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(argv: readonly string[], opts?: { cwd?: string }): CommandResult;
}

export const defaultCommandRunner: CommandRunner = {
  run(argv, opts) {
    try {
      const proc = Bun.spawnSync([...argv], {
        cwd: opts?.cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env as Record<string, string | undefined>,
      });
      return {
        code: proc.exitCode,
        stdout: new TextDecoder().decode(proc.stdout),
        stderr: new TextDecoder().decode(proc.stderr),
      };
    } catch (err) {
      return {
        code: 127,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

export interface RepoRef {
  owner: string;
  name: string;
}

export function parseRepoInput(input: string): RepoRef {
  const s = input.trim().replace(/\/+$/, "");
  const patterns = [
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(s);
    if (match) {
      return { owner: match[1] as string, name: match[2] as string };
    }
  }
  if (s.includes("/")) {
    const [owner, name] = s.split("/", 2);
    if (owner && name) {
      return { owner, name: name.replace(/\/+$/, "") };
    }
  }
  throw new RepoOpsError(
    "bare names are not accepted; use <owner>/<name> or a GitHub URL",
  );
}

export function canonicalizeRemoteUrl(url: string): string {
  try {
    const ref = parseRepoInput(url);
    return `https://github.com/${ref.owner.toLowerCase()}/${ref.name.toLowerCase()}`;
  } catch {
    return url.toLowerCase().replace(/\/+$/, "");
  }
}

export function resolveSpecialOwner(
  runner: CommandRunner = defaultCommandRunner,
): string {
  const git = runner.run(["git", "config", "--get", "github.user"]);
  if (git.code === 0 && git.stdout.trim() !== "") {
    return git.stdout.trim();
  }
  const gh = runner.run(["gh", "api", "user", "--jq", ".login"]);
  if (gh.code === 0 && gh.stdout.trim() !== "") {
    return gh.stdout.trim();
  }
  throw new RepoOpsError(
    "could not derive GitHub owner from git config or gh auth",
  );
}

interface GhRepoView {
  owner: { login: string };
  name: string;
  isFork?: boolean;
  parent?: { owner: { login: string }; name: string } | null;
  defaultBranchRef?: { name?: string | null } | null;
}

export interface CloneRepoOptions {
  input: string;
  destinationRoot: string;
  runner?: CommandRunner;
}

export interface CloneRepoResult {
  success: true;
  owner: string;
  name: string;
  isFork: boolean;
  primary_path: string;
  sibling_path: string | null;
}

export function cloneRepo(options: CloneRepoOptions): CloneRepoResult {
  const runner = options.runner ?? defaultCommandRunner;
  const parsed = parseRepoInput(options.input);
  const repoData = ghRepoView(runner, parsed.owner, parsed.name);
  const owner = repoData.owner.login;
  const name = repoData.name;
  const isFork = repoData.isFork === true;
  const specialOwner = resolveSpecialOwner(runner);
  const root = options.destinationRoot;

  if (owner === specialOwner && isFork) {
    const parent = repoData.parent;
    if (parent == null) {
      throw new RepoOpsError("fork parent unavailable; clone manually");
    }
    const primary = join(root, `${specialOwner}--${name}`);
    const upstreamOwner = parent.owner.login;
    const upstreamName = parent.name;
    const sibling = join(root, `${upstreamOwner}--${upstreamName}`);
    const defaultBranch = repoData.defaultBranchRef?.name || "main";

    cloneOrVerify(runner, owner, name, primary);
    ensureUpstreamRemote(runner, primary, upstreamOwner, upstreamName);
    runChecked(
      runner,
      ["git", "-C", primary, "fetch", "upstream"],
      "git fetch upstream failed",
    );
    runChecked(
      runner,
      [
        "git",
        "-C",
        primary,
        "branch",
        "--set-upstream-to",
        `upstream/${defaultBranch}`,
        defaultBranch,
      ],
      "git branch --set-upstream-to failed",
    );
    cloneOrVerify(runner, upstreamOwner, upstreamName, sibling);
    return {
      success: true,
      owner,
      name,
      isFork,
      primary_path: primary,
      sibling_path: sibling,
    };
  }

  const dest = join(root, `${owner}--${name}`);
  cloneOrVerify(runner, owner, name, dest);
  return {
    success: true,
    owner,
    name,
    isFork,
    primary_path: dest,
    sibling_path: null,
  };
}

export interface ForkRepoOptions {
  input: string;
  destinationRoot: string;
  runner?: CommandRunner;
}

export interface ForkRepoResult extends CloneRepoResult {
  forked: boolean;
}

export function forkRepo(options: ForkRepoOptions): ForkRepoResult {
  const runner = options.runner ?? defaultCommandRunner;
  const { owner, name } = parseRepoInput(options.input);
  const specialOwner = resolveSpecialOwner(runner);
  if (owner === specialOwner) {
    throw new RepoOpsError(
      `already owned by ${specialOwner}; use clone instead`,
    );
  }

  const check = runner.run(["gh", "api", `repos/${specialOwner}/${name}`]);
  const forked = check.code !== 0;
  if (forked) {
    runChecked(
      runner,
      ["gh", "repo", "fork", `${owner}/${name}`, "--clone=false"],
      "gh repo fork failed",
    );
  }

  const cloned = cloneRepo({
    input: `${specialOwner}/${name}`,
    destinationRoot: options.destinationRoot,
    runner,
  });
  return { ...cloned, forked };
}

export interface CreateRepoOptions {
  name: string;
  destinationRoot: string;
  runner?: CommandRunner;
}

export interface CreateRepoResult {
  success: true;
  owner: string;
  name: string;
  path: string;
}

export function createRepo(options: CreateRepoOptions): CreateRepoResult {
  const runner = options.runner ?? defaultCommandRunner;
  const name = options.name.trim();
  if (name === "") {
    throw new RepoOpsError("repository name is required");
  }
  const owner = resolveSpecialOwner(runner);
  const dest = join(options.destinationRoot, name);
  if (existsSync(dest)) {
    throw new RepoOpsError(`destination already exists: ${dest}`);
  }
  mkdirSync(dest, { recursive: true });
  runChecked(runner, ["git", "init", "-b", "main"], "git init failed", dest);
  runChecked(
    runner,
    ["git", "commit", "--allow-empty", "-m", "New repo"],
    "git commit failed",
    dest,
  );
  runChecked(
    runner,
    [
      "gh",
      "repo",
      "create",
      `${owner}/${name}`,
      "--private",
      "--source=.",
      "--push",
      "--remote=origin",
    ],
    "gh repo create failed",
    dest,
  );
  return { success: true, owner, name, path: dest };
}

function ghRepoView(
  runner: CommandRunner,
  owner: string,
  name: string,
): GhRepoView {
  const result = runner.run([
    "gh",
    "repo",
    "view",
    `${owner}/${name}`,
    "--json",
    "owner,name,isFork,parent,defaultBranchRef",
  ]);
  if (result.code !== 0) {
    throw new RepoOpsError(
      `gh repo view failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as GhRepoView;
  } catch (err) {
    throw new RepoOpsError(
      `gh repo view returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function cloneOrVerify(
  runner: CommandRunner,
  owner: string,
  name: string,
  dest: string,
): void {
  const expected = canonicalizeRemoteUrl(`${owner}/${name}`);
  if (existsSync(dest)) {
    const remote = runner.run([
      "git",
      "-C",
      dest,
      "remote",
      "get-url",
      "origin",
    ]);
    if (remote.code !== 0) {
      throw new RepoOpsError(
        `${dest} exists but has no origin remote: ${remote.stderr.trim() || remote.stdout.trim()}`,
      );
    }
    const actual = canonicalizeRemoteUrl(remote.stdout.trim());
    if (actual !== expected) {
      throw new RepoOpsError(
        `${dest} exists with mismatched origin: got ${actual}, expected ${expected}`,
      );
    }
    return;
  }

  mkdirSync(dirname(dest), { recursive: true });
  runChecked(
    runner,
    ["gh", "repo", "clone", `${owner}/${name}`, dest],
    "gh repo clone failed",
  );
}

function ensureUpstreamRemote(
  runner: CommandRunner,
  primary: string,
  upstreamOwner: string,
  upstreamName: string,
): void {
  const existing = runner.run([
    "git",
    "-C",
    primary,
    "remote",
    "get-url",
    "upstream",
  ]);
  if (existing.code === 0) {
    return;
  }
  runChecked(
    runner,
    [
      "git",
      "-C",
      primary,
      "remote",
      "add",
      "upstream",
      `https://github.com/${upstreamOwner}/${upstreamName}.git`,
    ],
    "git remote add upstream failed",
  );
}

function runChecked(
  runner: CommandRunner,
  argv: readonly string[],
  label: string,
  cwd?: string,
): void {
  const result = runner.run(argv, cwd === undefined ? undefined : { cwd });
  if (result.code !== 0) {
    throw new RepoOpsError(
      `${label}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}
