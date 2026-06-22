## Description

**Size:** S
**Files:** plugins/plan/skills/hack/SKILL.md, then runs /Users/mike/code/arthack/scripts/install.sh

### Approach

Finalize the advice + deploy + verify the whole system. Re-bake the updated snippet (task `.3`) VERBATIM into `plugins/plan/skills/hack/SKILL.md` under the existing `<!-- Canonical source: keeper prompt render source-dirs/docs-dir-and-gist-open -->` cite — the baked region after the cite must equal `keeper prompt render source-dirs/docs-dir-and-gist-open` byte-for-byte. Then run `bash /Users/mike/code/arthack/scripts/install.sh` (renders plugin templates, rebuilds the snippet index, distributes skills + stows hooks to all harnesses). Then verify end-to-end.

### Investigation targets

**Required:**
- plugins/plan/skills/hack/SKILL.md — the existing canonical-source cite + baked block to replace
- /Users/mike/code/arthack/scripts/install.sh — install_shared_agent_skills (symlinks /hack) + render-plugin-templates

### Risks

- Runs after `.1` (hook), `.2` (arthack removal), `.3` (snippet) so install deploys the final state. The `/hack` baked text must match the `.3` snippet exactly or the canonical-source cite lies.

### Test notes

End-to-end smoke after install: (a) the harness `/hack` copies show the new gist command; (b) a Write to a temp `$KEEPER_DOCS_DIR/x.md` writes a sidecar, not an md block; (c) arthack post_tool_use no longer stamps. 

## Acceptance

- [ ] `/hack` SKILL.md baked block == `keeper prompt render source-dirs/docs-dir-and-gist-open` (byte-for-byte)
- [ ] `bash scripts/install.sh` completes; harness `/hack` copies (codex, pi) reflect the new advice
- [ ] end-to-end: keeper hook writes sidecar (not md); arthack no longer stamps
- [ ] working trees committed per-repo

## Done summary
Re-baked the docs-dir-and-gist-open snippet into /hack SKILL.md byte-for-byte, ran install.sh to deploy final state (codex/pi /hack reflect new gist command), and verified end-to-end: keeper hook writes the .yaml sidecar (not an md block) and arthack post_tool_use no longer stamps docs.
## Evidence
