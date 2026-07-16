import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INSTALL = readFileSync(
  join(import.meta.dir, "..", "scripts", "install.sh"),
  "utf8",
);
const PLIST = readFileSync(
  join(import.meta.dir, "..", "plist", "arthack.keeperd.plist"),
  "utf8",
);

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`missing source boundary: ${start}`);
  return source.slice(from, to);
}

const SECTION = between(
  INSTALL,
  "# 3c. CodexBar CLI:",
  "# 4. LaunchAgent reload",
);
const GIT_WRAPPER = between(
  SECTION,
  "codexbar_git() {",
  "codexbar_provenance_value() {",
);
const CLEANUP_STAGING = between(
  SECTION,
  "codexbar_cleanup_staging() {",
  "codexbar_prepare_stable_link() {",
);
const STABLE_LINK = between(
  SECTION,
  "codexbar_prepare_stable_link() {",
  "codexbar_prepare_legacy_fallback() {",
);
const LEGACY_FALLBACK = between(
  SECTION,
  "codexbar_prepare_legacy_fallback() {",
  "codexbar_prepare_startup_link() {",
);
const STARTUP_LINK = between(
  SECTION,
  "codexbar_prepare_startup_link() {",
  "codexbar_provenance_value() {",
);
const SIGNED_GENERATION = between(
  SECTION,
  "codexbar_signed_generation_valid() {",
  "codexbar_provenance_matches() {",
);
const PROVENANCE_MATCH = between(
  SECTION,
  "codexbar_provenance_matches() {",
  "codexbar_discard_worktree() {",
);
const DISCARD = between(
  SECTION,
  "codexbar_discard_worktree() {",
  "codexbar_add_fork_worktree() {",
);
const SWIFT_ENV = between(
  SECTION,
  "codexbar_swift_env() {",
  "codexbar_build_cli() {",
);
const BUILD = between(
  SECTION,
  "codexbar_build_cli() {",
  "codexbar_prune_generations() {",
);
const PRUNE = between(
  SECTION,
  "codexbar_prune_generations() {",
  "codexbar_atomic_install() (",
);
const ATOMIC_INSTALL = between(
  SECTION,
  "codexbar_atomic_install() (",
  "codexbar_remove_cask() {",
);
const PUBLISH = between(
  SECTION,
  "codexbar_publish_build() {",
  "codexbar_cli_install() (",
);
const ORCHESTRATION = between(
  SECTION,
  "codexbar_cli_install() (",
  "if ! codexbar_cli_install; then",
);

function indexAfter(source: string, needle: string, after: number): number {
  const index = source.indexOf(needle, after);
  expect(index).toBeGreaterThan(after);
  return index;
}

function expectNoAmbientCredentialOrProxyEnv(source: string): void {
  for (const banned of [
    "SSH_AUTH_SOCK",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GIT_CREDENTIAL",
    "GIT_SSH",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
  ]) {
    expect(source).not.toContain(banned);
  }
}

describe("scripts/install.sh managed CodexBar fork", () => {
  test("pins authoritative fork and upstream main refs", () => {
    expect(SECTION).toContain(
      'codexbar_fork_url="https://github.com/possibilities/CodexBar.git"',
    );
    expect(SECTION).toContain(
      'codexbar_upstream_url="https://github.com/steipete/CodexBar.git"',
    );
    expect(SECTION).toContain('codexbar_fork_ref="main"');
    expect(SECTION).toContain('codexbar_upstream_ref="main"');
    expect(ORCHESTRATION).toContain(
      `"+refs/heads/\${codexbar_fork_ref}:refs/keeper/codexbar-fork"`,
    );
    expect(ORCHESTRATION).toContain(
      `"+refs/heads/\${codexbar_upstream_ref}:refs/keeper/codexbar-upstream"`,
    );
  });

  test("uses only disposable exact-SHA source state", () => {
    expect(ORCHESTRATION).toContain(
      `mktemp -d "\${TMPDIR:-/tmp}/keeper-codexbar-source.XXXXXX"`,
    );
    expect(ORCHESTRATION).toContain(
      `trap '[ -z "\${source_state}" ] || rm -rf "\${source_state}"' EXIT`,
    );
    expect(ORCHESTRATION).toContain(`codexbar_source_state="\${source_state}"`);
    expect(ORCHESTRATION).toContain(
      `codexbar_prepare_source_env "\${source_state}"`,
    );
    expect(ORCHESTRATION).toContain(`repository="\${source_state}/repository"`);
    expect(
      ORCHESTRATION.indexOf(`codexbar_source_state="\${source_state}"`),
    ).toBeLessThan(
      ORCHESTRATION.indexOf(`codexbar_git init --quiet "\${repository}"`),
    );
    expect(SECTION).toContain("worktree add --quiet --detach");
    expect(SECTION).toContain(`reset --hard "\${fork_sha}"`);
    expect(SECTION).not.toContain("possibilities--CodexBar");
    expect(SECTION).not.toContain("/Users/mike/src/");
    expect(SECTION).not.toContain("/Volumes/Scratch/src/");
  });

  test("seals Git with env allowlisting and preserves merge topology", () => {
    for (const contract of [
      "env -i",
      `PATH="\${PATH}"`,
      `HOME="\${codexbar_source_state}/home"`,
      `TMPDIR="\${TMPDIR:-/tmp}"`,
      "LC_ALL=C",
      "LANG=C",
      `XDG_CACHE_HOME="\${codexbar_source_state}/cache"`,
      `XDG_CONFIG_HOME="\${codexbar_source_state}/config"`,
      "GIT_CONFIG_NOSYSTEM=1",
      "GIT_CONFIG_GLOBAL=/dev/null",
      "GIT_TERMINAL_PROMPT=0",
      "GIT_ASKPASS=/usr/bin/false",
      "SSH_ASKPASS=/usr/bin/false",
      "GIT_EDITOR=:",
      "GIT_SEQUENCE_EDITOR=:",
      "EDITOR=:",
      "VISUAL=:",
      "-c core.hooksPath=/dev/null",
      "-c commit.gpgSign=false",
      "-c tag.gpgSign=false",
      "-c rebase.autoStash=false",
    ]) {
      expect(GIT_WRAPPER).toContain(contract);
    }
    expectNoAmbientCredentialOrProxyEnv(GIT_WRAPPER);
    expect(ORCHESTRATION).toContain(
      `codexbar_git -C "\${build_source}" rebase --rebase-merges`,
    );
    expect(ORCHESTRATION).toContain(`"\${upstream_sha}" >/dev/null 2>&1`);
  });

  test("seals SwiftPM Git under env allowlisting and disposable state", () => {
    for (const contract of [
      "env -i",
      `PATH="\${PATH}"`,
      `HOME="\${source_state}/home"`,
      `TMPDIR="\${TMPDIR:-/tmp}"`,
      "LC_ALL=C",
      "LANG=C",
      `XDG_CACHE_HOME="\${source_state}/cache"`,
      `XDG_CONFIG_HOME="\${source_state}/config"`,
      `CLANG_MODULE_CACHE_PATH="\${source_state}/cache/clang-module-cache"`,
      `SWIFTPM_MODULECACHE_OVERRIDE="\${source_state}/cache/swiftpm-module-cache"`,
      "GIT_CONFIG_NOSYSTEM=1",
      "GIT_CONFIG_GLOBAL=/dev/null",
      "GIT_CONFIG_COUNT=6",
      "GIT_CONFIG_KEY_1=core.hooksPath",
      "GIT_CONFIG_VALUE_1=/dev/null",
      "GIT_CONFIG_KEY_3=commit.gpgSign",
      "GIT_CONFIG_VALUE_3=false",
      "GIT_CONFIG_KEY_4=tag.gpgSign",
      "GIT_CONFIG_VALUE_4=false",
      "GIT_TERMINAL_PROMPT=0",
      "GIT_ASKPASS=/usr/bin/false",
      "SSH_ASKPASS=/usr/bin/false",
    ]) {
      expect(SWIFT_ENV).toContain(contract);
    }
    expectNoAmbientCredentialOrProxyEnv(SWIFT_ENV);
    expect(BUILD).toContain(
      `codexbar_swift_env "\${source_state}" swift build`,
    );
    expect(BUILD).toContain(`--cache-path "\${source_state}/swiftpm-cache"`);
    expect(BUILD).toContain("tr '\\r\\n\\t' '   '");
  });

  test("aborts and discards failed source before a clean unrebased fallback", () => {
    expect(DISCARD).toContain("rebase --abort");
    expect(DISCARD).toContain("worktree remove --force");
    expect(DISCARD).toContain("worktree prune --expire now");

    const rebase = ORCHESTRATION.indexOf("rebase --rebase-merges");
    const discard = indexAfter(
      ORCHESTRATION,
      `codexbar_discard_worktree "\${repository}" "\${build_source}"`,
      rebase,
    );
    const fallback = indexAfter(
      ORCHESTRATION,
      `fallback_source="\${source_state}/unrebased"`,
      discard,
    );
    indexAfter(
      ORCHESTRATION,
      `codexbar_add_fork_worktree "\${repository}" "\${fallback_source}" "\${fork_sha}"`,
      fallback,
    );
  });

  test("falls back after a rebased build failure and reports fallback outcomes", () => {
    const rebasedBuild = ORCHESTRATION.indexOf(
      `codexbar_build_cli "\${build_source}"`,
    );
    const reason = indexAfter(
      ORCHESTRATION,
      'fallback_reason="the rebased CodexBar CLI build failed"',
      rebasedBuild,
    );
    indexAfter(
      ORCHESTRATION,
      `codexbar_build_cli "\${fallback_source}"`,
      reason,
    );
    expect(ORCHESTRATION).toContain(
      "the unrebased fork build also failed; the previous binary was retained",
    );
    expect(PUBLISH).toContain(
      "the unrebased fallback built, but final staging/install failed; the previous binary was retained",
    );
    expect(PUBLISH).toContain("installed the unrebased fork fallback");
    expect(SECTION).toContain("notifyctl show-message");
  });

  test("builds only the CLI product and has no app or push path", () => {
    expect(SECTION.match(/swift build/g)).toHaveLength(1);
    expect(BUILD).toContain("--product CodexBarCLI");
    expect(SECTION).not.toContain("package_app.sh");
    expect(SECTION).not.toContain("/Applications/CodexBar.app");
    expect(SECTION).not.toMatch(/\bpush\b/);
  });

  test("publishes immutable binary and provenance generations with one current swap", () => {
    expect(SECTION).toContain(
      `codexbar_cli_dir="\${XDG_DATA_HOME:-\${HOME}/.local/share}/keeper/codexbar"`,
    );
    expect(SECTION).toContain(
      `codexbar_cli_bin="\${codexbar_cli_current}/CodexBarCLI"`,
    );
    expect(SECTION).toContain(
      `codexbar_provenance="\${codexbar_cli_current}/PROVENANCE"`,
    );
    expect(ATOMIC_INSTALL).toContain(
      `mktemp -d "\${codexbar_cli_dir}/.staging.XXXXXX"`,
    );
    expect(ATOMIC_INSTALL).toContain(
      `generation_name="generation.\${binary_sha}.\${install_stage##*.staging.}"`,
    );
    const generationMove = ATOMIC_INSTALL.indexOf(
      `mv "\${install_stage}" "\${generation}"`,
    );
    const currentSwap = ATOMIC_INSTALL.indexOf(
      `mv -f -h "\${current_tmp}" "\${codexbar_cli_current}"`,
    );
    expect(generationMove).toBeGreaterThan(0);
    expect(currentSwap).toBeGreaterThan(generationMove);
    expect(
      ATOMIC_INSTALL.match(
        /mv -f -h "\$\{current_tmp\}" "\$\{codexbar_cli_current\}"/g,
      ),
    ).toHaveLength(1);
    expect(ATOMIC_INSTALL).not.toContain(
      `mv -f "\${install_stage}/CodexBarCLI"`,
    );
    expect(ATOMIC_INSTALL).not.toContain(
      `mv -f "\${install_stage}/PROVENANCE"`,
    );
    expect(ATOMIC_INSTALL).toContain(
      `chmod 555 "\${install_stage}/CodexBarCLI"`,
    );
    expect(ATOMIC_INSTALL).toContain(
      `chmod 444 "\${install_stage}/PROVENANCE"`,
    );
  });

  test("signs the staged CLI with a stable certificate identity before hashing and publication", () => {
    expect(SECTION).toContain(
      'codexbar_signing_identity="B1AD266E854C4E845AA7EC456955D881AE9D5F47"',
    );
    expect(SECTION).toContain(
      'codexbar_signing_identifier="com.arthack.keeper.codexbar-cli"',
    );
    expect(SECTION).toContain(
      'certificate leaf = H"b1ad266e854c4e845aa7ec456955d881ae9d5f47"',
    );

    const stagedCopy = ATOMIC_INSTALL.indexOf(
      `install -m 755 "\${built_binary}" "\${install_stage}/CodexBarCLI"`,
    );
    const sign = ATOMIC_INSTALL.indexOf("codesign --force", stagedCopy);
    const embeddedRequirement = ATOMIC_INSTALL.indexOf(
      `--requirements "=designated => \${codexbar_signing_requirement}"`,
      sign,
    );
    const verify = ATOMIC_INSTALL.indexOf("codesign --verify --strict", sign);
    const testedRequirement = ATOMIC_INSTALL.indexOf(
      `--test-requirement "=\${codexbar_signing_requirement}"`,
      verify,
    );
    const hash = ATOMIC_INSTALL.indexOf(
      `binary_sha="$(shasum -a 256`,
      testedRequirement,
    );

    expect(stagedCopy).toBeGreaterThan(0);
    expect(sign).toBeGreaterThan(stagedCopy);
    expect(embeddedRequirement).toBeGreaterThan(sign);
    expect(verify).toBeGreaterThan(embeddedRequirement);
    expect(testedRequirement).toBeGreaterThan(verify);
    expect(hash).toBeGreaterThan(testedRequirement);
    expect(ATOMIC_INSTALL).toContain(`--sign "\${codexbar_signing_identity}"`);
    expect(ATOMIC_INSTALL).toContain(
      `--identifier "\${codexbar_signing_identifier}"`,
    );
    expect(ATOMIC_INSTALL).toContain(
      `"signing_identity=\${codexbar_signing_identity}"`,
    );
    expect(ATOMIC_INSTALL).toContain(
      `"signing_identifier=\${codexbar_signing_identifier}"`,
    );
    expect(ATOMIC_INSTALL).toContain(
      `"signing_requirement=\${codexbar_signing_requirement}"`,
    );

    expect(SIGNED_GENERATION).toContain("codesign --verify --strict");
    expect(SIGNED_GENERATION).toContain(
      `--test-requirement "=\${codexbar_signing_requirement}"`,
    );
    expect(SIGNED_GENERATION).toContain(`"\${codexbar_cli_bin}"`);
  });

  test("cleans crash residue and retains the current and prior generation", () => {
    for (const residue of [
      `"\${codexbar_cli_dir}"/.staging.*`,
      `"\${codexbar_cli_dir}"/.current.*`,
      `"\${HOME}/.local/bin"/.codexbar-link.*`,
    ]) {
      expect(CLEANUP_STAGING).toContain(residue);
    }
    expect(ORCHESTRATION).toContain("codexbar_cleanup_staging");
    expect(PRUNE).toContain(`generation.*`);
    expect(PRUNE).toContain(`"\${current_name}"`);
    expect(PRUNE).toContain(`"\${previous_name}"`);
    expect(ATOMIC_INSTALL).toContain(
      `codexbar_prune_generations "\${generation_name}" "\${previous_name}"`,
    );
  });

  test("repairs the stable current link before network and keeps direct fallback", () => {
    expect(SECTION).toContain(
      `codexbar_cli_link_target="\${codexbar_cli_dir}/current/CodexBarCLI"`,
    );
    expect(STABLE_LINK).toContain(`[ -L "\${codexbar_cli_current}" ]`);
    expect(STABLE_LINK).toContain(`[ -x "\${codexbar_cli_bin}" ]`);
    expect(STABLE_LINK).toContain(
      `echo "install: \${codexbar_cli_link} is not a symlink; refusing replacement"`,
    );
    expect(STABLE_LINK).toContain(
      `mktemp "\${HOME}/.local/bin/.codexbar-link.XXXXXX"`,
    );
    expect(STABLE_LINK).toContain(
      `ln -s "\${codexbar_cli_link_target}" "\${link_tmp}"`,
    );
    expect(STABLE_LINK).toContain(
      `mv -f -h "\${link_tmp}" "\${codexbar_cli_link}"`,
    );
    const repair = ORCHESTRATION.indexOf("codexbar_prepare_startup_link");
    expect(repair).toBeGreaterThan(0);
    expect(repair).toBeLessThan(
      ORCHESTRATION.indexOf(
        `mktemp -d "\${TMPDIR:-/tmp}/keeper-codexbar-source.XXXXXX"`,
      ),
    );
    expect(repair).toBeLessThan(
      ORCHESTRATION.indexOf("fetch --quiet --no-tags"),
    );
    expect(STARTUP_LINK).toContain("codexbar_prepare_stable_link");
    expect(STARTUP_LINK).toContain("2) codexbar_prepare_legacy_fallback");
    expect(ATOMIC_INSTALL).toContain(
      `ln -s "\${codexbar_cli_link_target}" "\${link_tmp}"`,
    );
    expect(ATOMIC_INSTALL).toContain(
      `mv -f -h "\${link_tmp}" "\${codexbar_cli_link}"`,
    );
    expect(SECTION).toContain(
      `codexbar_legacy_cli_bin="\${codexbar_cli_dir}/CodexBarCLI"`,
    );
    expect(LEGACY_FALLBACK).toContain(
      `[ ! -L "\${codexbar_cli_current}" ] || [ ! -x "\${codexbar_cli_bin}" ] || return 0`,
    );
    expect(LEGACY_FALLBACK).toContain(
      `ln -s "\${codexbar_legacy_cli_bin}" "\${codexbar_cli_link}"`,
    );
    expect(ATOMIC_INSTALL).not.toContain(`rm -f "\${codexbar_legacy_cli_bin}"`);
    const replacement = PUBLISH.indexOf("codexbar_atomic_install");
    const cask = PUBLISH.indexOf("codexbar_remove_cask");
    expect(replacement).toBeGreaterThan(0);
    expect(cask).toBeGreaterThan(replacement);
  });

  test("records and verifies complete build provenance before skipping", () => {
    for (const field of [
      "fork_ref",
      "fork_sha",
      "upstream_sha",
      "mode",
      "built_sha",
      "built_tree_sha",
      "binary_sha256",
      "architecture",
      "swift_toolchain_version",
      "signing_identity",
      "signing_identifier",
      "signing_requirement",
    ]) {
      expect(ATOMIC_INSTALL).toMatch(new RegExp(`"${field}=\\$\\{`));
    }
    expect(SIGNED_GENERATION).toContain(
      `expected_binary_sha="$(codexbar_provenance_value binary_sha256`,
    );
    expect(SIGNED_GENERATION).toContain(`shasum -a 256 "\${codexbar_cli_bin}"`);
    expect(SIGNED_GENERATION).toContain(
      `[ "\${actual_binary_sha}" = "\${expected_binary_sha}" ]`,
    );
    expect(PROVENANCE_MATCH).toContain("codexbar_signed_generation_valid");
    expect(ORCHESTRATION.indexOf("codexbar_provenance_matches")).toBeLessThan(
      ORCHESTRATION.indexOf("CodexBar CLI inputs unchanged; no rebuild"),
    );
  });

  test("pins a valid signed generation unless an update is explicitly requested", () => {
    const repair = ORCHESTRATION.indexOf("codexbar_prepare_startup_link");
    const pin = ORCHESTRATION.indexOf(
      `[ "\${KEEPER_CODEXBAR_UPDATE:-0}" != "1" ]`,
    );
    const sourceState = ORCHESTRATION.indexOf(
      `mktemp -d "\${TMPDIR:-/tmp}/keeper-codexbar-source.XXXXXX"`,
    );
    const fetch = ORCHESTRATION.indexOf("fetch --quiet --no-tags");

    expect(pin).toBeGreaterThan(repair);
    expect(pin).toBeLessThan(sourceState);
    expect(pin).toBeLessThan(fetch);
    expect(ORCHESTRATION).toContain("codexbar_signed_generation_valid");
    expect(ORCHESTRATION).toContain(
      "CodexBar CLI signed generation pinned; set KEEPER_CODEXBAR_UPDATE=1 to check for updates",
    );
  });

  test("uses provenance for stable resolved inputs but retries unavailable upstream", () => {
    expect(ORCHESTRATION).toContain(
      `if [ "\${upstream_sha}" != "unavailable" ]; then`,
    );
    expect(ORCHESTRATION).toContain(
      `codexbar_provenance_matches "\${fork_sha}" "\${upstream_sha}" rebased`,
    );
    expect(ORCHESTRATION).toContain(
      `codexbar_provenance_matches "\${fork_sha}" "\${upstream_sha}" unrebased`,
    );
    expect(ORCHESTRATION).toContain(
      "CodexBar CLI inputs unchanged; no rebuild",
    );
    expect(ORCHESTRATION.indexOf("fetch --quiet --no-tags")).toBeLessThan(
      ORCHESTRATION.indexOf("CodexBar CLI inputs unchanged; no rebuild"),
    );
  });

  test("keeps every CodexBar outcome nonfatal to the outer installer", () => {
    expect(SECTION).toContain("if ! codexbar_cli_install; then");
    expect(SECTION).toContain(
      "CodexBar CLI step failed (non-fatal); continuing",
    );
    expect(SECTION).toContain("could not resolve possibilities/CodexBar");
    expect(SECTION).toContain("the previous binary was retained");
  });

  test("pins keeperd to the stable home path with headless Keychain access disabled", () => {
    expect(PLIST).toContain("<key>KEEPER_CODEXBAR_BIN</key>");
    expect(PLIST).toContain("<string>/Users/mike/.local/bin/codexbar</string>");
    expect(PLIST).toContain("<key>CODEXBAR_DISABLE_KEYCHAIN_ACCESS</key>");
    expect(PLIST).toMatch(
      /<key>CODEXBAR_DISABLE_KEYCHAIN_ACCESS<\/key>\s*<string>1<\/string>/,
    );
    expect(PLIST).not.toContain(
      "<string>/Users/mike/.local/share/keeper/codexbar/CodexBarCLI</string>",
    );
  });
});
