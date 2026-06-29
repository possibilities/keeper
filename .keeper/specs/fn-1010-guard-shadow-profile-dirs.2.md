## Description

**Size:** M
**Files:** new db-free module (e.g. src/agent/shadow-profiles.ts), src/agent/dispatch.ts, src/agent/main.ts, README.md (presets block), test (new + dispatch)

### Approach

Add a pure, db-free `findShadowProfileDirs(listProfilesFn, homeDir)` returning per stray
`{ name, hasAuth, isReservedShadow, tracked }`: live `readdir` of `~/.claude-profiles`
(and `~/.pi-profiles`), per-entry `hasAuth` = `.credentials.json` presence OR
`.claude.json` with an `oauthAccount` (reuse the read shape at usage-scraper-worker.ts:280);
`tracked` = `listProfiles()` (usage-picker.ts:126) ∪ the `default` silo (defined as
`~/.claude`, matching the producer fix so any `~/.claude-profiles/default` is ALWAYS a
reserved shadow); `isReservedShadow` = name ∈ reserved set (reuse task .1's constant).
Robustness: a mid-scan ENOENT or an unparseable `.claude.json` is a FINDING, not a crash —
continue scanning; never read/log token contents. The module MUST stay db-free (no
transitive src/db.ts import) so cli/usage.ts (task .3) can import it too — verify the
listProfiles import chain stays db-free. Wire a `keeper agent profiles check [--json]`
subcommand: add a `profiles` branch to `splitSubcommand` (dispatch.ts, mirror the
`presets` branch ~:169-181; `--json` via `argv.includes` like :178), a Dispatch union
variant (dispatch.ts:25-27), and a `runProfilesCheck` handler in main.ts (near :844-872,
mirror runPresetsList ~:744 with its JSON branch ~:799). Output: human mode → a finding
list + summary line (data to stdout, prose to stderr) each with a stable `id` +
`remediation`; `--json` → the findings array/envelope. Exit 0 = clean, 9 = findings, 1 =
tool error. NEVER mutate the filesystem. Add help text: a "Profile diagnostics" block in
AGENTWRAP_HELP (mirror "Preset resolution" ~:102-108) + `profiles check` in USAGE_HELP
(:44-62); add one line to the README presets block (~:1402-1420).

### Investigation targets

**Required** (read before coding):
- src/agent/dispatch.ts:25-27 (Dispatch union), :161 (splitSubcommand), :169-181 (presets branch template), :178 (--json), USAGE_HELP :44-62, AGENTWRAP_HELP :73-144
- src/agent/main.ts:844-872 (subcommand handler dispatch), ~:744/:799 (runPresetsList + its JSON branch — the template)
- src/usage-scraper-worker.ts:280-287 — the oauthAccount read shape for hasAuth
- src/usage-picker.ts:126 (listProfiles), :46 (DEFAULT_PROFILE) — and verify this import chain is db-free
- cli/agent.ts:25-28 — the db-free constraint on the launcher path

**Optional** (reference as needed):
- README.md:~1402-1420 — the presets doc block to extend

### Risks

- db pull-in: findShadowProfileDirs (and its listProfiles import) must not transitively load src/db.ts — it's imported by both the agent subcommand and cli/usage.ts.
- Symlinked auth files: a managed tracked profile's `.credentials.json`/`.claude.json` may be symlinks into the shared silo — ensure `tracked` exclusion is applied so managed profiles aren't mis-flagged as shadows-with-auth.
- NFC: compare readdir entries to the tracked set on a normalized form to avoid a false "untracked" on an NFD-on-disk name.

### Test notes

Sandbox a tmp home with a mix: a tracked profile, an auth-bearing `default/` shadow, a
signed-out stray, an unparseable `.claude.json`, and a dir that vanishes mid-scan
(ENOENT). Assert findings + exit codes (0/9/1) and that nothing on disk is moved/deleted.
Assert `--json` shape (id + remediation per finding). Cover pi (`~/.pi-profiles`) too.

## Acceptance

- [ ] `findShadowProfileDirs` returns `{name,hasAuth,isReservedShadow,tracked}` per stray, db-free, covering claude + pi.
- [ ] Parse/IO failures and mid-scan ENOENT are findings, not crashes; no token contents logged.
- [ ] `keeper agent profiles check [--json]` reports read-only (zero fs mutation), with id + remediation per finding and a summary line.
- [ ] Exit 0 clean / 9 findings / 1 tool-error; data→stdout, prose→stderr.
- [ ] AGENTWRAP_HELP + USAGE_HELP + README presets block document the subcommand.

## Done summary

## Evidence
