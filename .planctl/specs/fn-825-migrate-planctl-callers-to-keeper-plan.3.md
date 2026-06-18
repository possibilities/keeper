## Description

**Size:** S
**Files:** ~/code/arthack/scripts/** (the 17 `planctl <verb>` callers), excluding the binary-build/buildbot bits (final epic)

### Approach

Replace `planctl <verb>` command invocations in arthack scripts with `keeper plan <verb>`. Do NOT touch the `install.sh` §6d binary build, the buildbot builder, or the codex skill source here — those are the final-epic cord-cut. Only command callers.

### Investigation targets

**Required**:
- `rg -n '\bplanctl ' ~/code/arthack/scripts` — the 17 callers; separate command-invocations from build/promote references

### Risks

- Some `planctl` mentions in scripts are the binary build (`install_bun_cli`), not callers — leave those for the final epic.

### Test notes

Scripts run clean; `rg -n '\bplanctl ' ~/code/arthack/scripts` leaves only the build/promote references (handled in the final epic).

## Acceptance

- [ ] arthack script command-callers use `keeper plan <verb>`; build/promote/buildbot references untouched (final epic)

## Done summary

## Evidence
