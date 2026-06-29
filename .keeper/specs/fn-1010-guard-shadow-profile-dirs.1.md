## Description

**Size:** M
**Files:** src/agent/state-sharing.ts, src/agent/config.ts (optional — mirror pattern), CLAUDE.md, test/agent-profile-bootstrap.test.ts

### Approach

Add a shared `assertProfileDirNameAllowed(name)` helper that throws `StateError`
(src/agent/state-sharing.ts:30 — state layer → exit 1, NOT ConfigError) and call it at
ALL FOUR profile-dir mkdir sites: `ensureAgentwrapProfileDir` (state-sharing.ts:378),
`ensureAgentwrapPiProfileDir` (:447), and the two DIRECT mkdirSync loops in
`ensureClaudeStateSharing` (:778) and `ensurePiStateSharing` (:811) that bypass the
ensure*ProfileDir helpers. Validation rules (mirror RESERVED_PRESET_NAMES /
PRESET_NAME_PATTERN at config.ts:307/326/346-356, but keeper-profile-shaped): reject the
reserved set `{"", "default"}` (after `.trim()`); reject path-escape — run atomic checks
for path separators (`/`,`\`), `..`, and NUL on the RAW input BEFORE any normalization
(path.normalize silently collapses `foo/../bar`); apply an allowlist pattern; include
`auto` as cheap hardening; cap byte-length ≤255. Normalize NFC only for
validation/comparison — pass the ORIGINAL string to mkdir (macOS NFD readdir mismatch
otherwise). The error message carries name + reason ONLY, never the resolved absolute
path. Confirm a throw at the loop sites (:778/:811) propagates to a `writeErr+exit(1)`
catch (the documented catches at main.ts:1172-1178/1194-1199 wrap the ensure*ProfileDir
CALL-sites, which the loops bypass — verify the loop callers' catch path and add one if
missing). Add one imperative CLAUDE.md guardrail bullet (`""`/`default` reserved +
path-escape rejected; never hand-create `~/.claude-profiles/default`).

### Investigation targets

**Required** (read before coding):
- src/agent/state-sharing.ts:358-380, :431-450, :769-783, :802-815 — the four mkdir sites + the StateError class (:30)
- src/agent/state-sharing.ts:516 (configuredNonDefaultProfiles) — pre-filter that means the loop sites only ever see auto/./../sep, not ""/"default" (so those catches are defense-in-depth there)
- src/agent/config.ts:307-356 — RESERVED_PRESET_NAMES / PRESET_NAME_PATTERN / validatePresetName (the structure to mirror)
- src/agent/main.ts:1164-1203 — the ensure*ProfileDir call-sites + StateError→writeErr+exit(1) catches; trace the loop-site (ensure*StateSharing) caller's catch path
- test/agent-profile-bootstrap.test.ts:49 — the tmp-home injected seam (agentwrap-bootstrap- prefix); NO Pi coverage exists (greenfield)

### Risks

- Denylist/normalize-order bug: a post-normalize `..` check is bypassable; checks must run on raw input first.
- The two loop sites bypass the ensure*ProfileDir catch blocks — a guard throw there must still convert to exit(1), not an uncaught crash.
- Over-broad guard could reject a legitimate existing profile name on next launch — keep the allowlist aligned with PRESET_NAME_PATTERN.

### Test notes

Sandbox a tmp home. Assert the guard rejects `""`, `"default"`, `" default "` (trim),
`"a/b"`, `"../x"`, NUL, and an over-long name; accepts `multi-claude-1`. Cover BOTH the
claude and pi sites (Pi is greenfield — first-ever coverage). Assert the error message
omits the absolute path.

## Acceptance

- [ ] `assertProfileDirNameAllowed` throws StateError for `{"", "default"}` (trimmed), path-escape (`/`,`\`,`..`,NUL), `auto`, and >255 bytes; accepts normal names.
- [ ] Called at all four mkdir sites (state-sharing.ts:378/:447/:778/:811); a loop-site throw still becomes exit(1).
- [ ] Validation runs on raw input before normalize; mkdir receives the original (non-normalized) string.
- [ ] Error message carries name + reason only (no resolved absolute path).
- [ ] CLAUDE.md gains one guardrail bullet; `bun scripts/lint-claude-md.ts` stays green.
- [ ] Tests cover claude + pi sites (pi greenfield), sandboxed tmp home.

## Done summary
Added assertProfileDirNameAllowed (StateError->exit 1) guarding all four profile-dir mkdir sites (claude+pi, helper+loop) against the reserved set (""/default/auto), path-escape (separator/../NUL on raw input), off-allowlist, and >255-byte names; mkdir keeps the original non-NFC string. Tests cover claude+pi (pi greenfield) in a sandboxed tmp home; CLAUDE.md guardrail added.
## Evidence
