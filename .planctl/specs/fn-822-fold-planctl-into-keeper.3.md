## Description

**Size:** S
**Files:** ~/code/arthack/system/arthack/.config/arthack/plugins.yaml, ~/code/arthack/scripts/install.sh, ~/code/arthack/scripts/doctor.sh, ~/code/arthack/claude/CLAUDE.md, ~/code/arthack/apps/promptctl/hooks/{pre,post}-hook.py

### Approach

Re-point the claudewrap launcher from two explicit plugin roots to one scan-dir parent, completing the cutover begun in `.2`. In `plugins.yaml`, remove the `plugin_dirs` entries `~/code/keeper` and `~/code/planctl`; add `~/code/keeper/plugins` under `plugin_scan_dirs` (keep it in scan_dirs, NOT plugin_dirs — scan-dir auto-discovers each manifest-bearing child, so adding plugin #3 later is drop-a-dir). Update `install.sh:307` (`render-plugin-templates --project-root` → `~/code/keeper/plugins/plan`) and `:547` (`install_bun_cli` → `~/code/keeper/plugins/plan`); audit `doctor.sh`. Fix the path refs in `arthack/claude/CLAUDE.md:37-38` (keeper/planctl as sibling `plugin_dirs` → co-hosted under keeper's scan-dir) and promptctl's standalone-hook-copy path comments.

### Investigation targets

**Required**:
- ~/code/arthack/system/arthack/.config/arthack/plugins.yaml — the `plugin_dirs` vs `plugin_scan_dirs` blocks (the cutover edit)
- ~/code/claudewrap/test/plugins.test.ts:72 — confirms scan-dir emits `--plugin-dir` per child, sorted, non-manifest skipped
- ~/code/arthack/scripts/install.sh:307,547 — `render-plugin-templates` + `install_bun_cli` paths
- ~/code/arthack/claude/CLAUDE.md:37-38 — keeper/planctl plugin-dir descriptions

### Risks

- Putting `~/code/keeper/plugins` in `plugin_dirs` (not `plugin_scan_dirs`) fail-louds (no manifest at that parent). Must be scan_dirs.
- Transient cutover window: until this lands, the relocated `.2` plugin isn't on the launcher's path — apply `.2`+`.3` together and re-run `install.sh`.

### Test notes

`bun test` in claudewrap (plugins discovery pins). Fresh claudewrap session: both `plugins/keeper` + `plugins/plan` register; `plan:*` + `keeper:await` resolve; both hooks fire independently; `/plan:plan` records `skill_name='plan:plan'`.

## Acceptance

- [ ] `plugins.yaml` has one `plugin_scan_dirs` entry `~/code/keeper/plugins`; the two old `plugin_dirs` entries are gone
- [ ] fresh session auto-discovers both plugins; `plan:*` + `keeper:await` resolve; both hooks fire; no double-registration
- [ ] `install.sh` render + bun-cli paths point at `~/code/keeper/plugins/plan`; `install.sh` runs clean
- [ ] arthack/claude/CLAUDE.md + promptctl hook-copy path refs updated forward-facing
- [ ] adding a hypothetical 3rd plugin dir under `plugins/` would be auto-discovered with zero config change (scan-dir property verified)

## Done summary

## Evidence
