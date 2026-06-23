## Overview

Remove pairctl now that `/keeper:pair` (fn-894, DONE) fully replaces it. fn-894 landed the
`keeper pair` CLI + skill, recomposed `/plan:panel` onto it, and flipped every keeper-side
reference — so nothing in keeper or arthack still INVOKES pairctl (verified by a cross-repo
caller audit). This epic deletes the arthack pairctl package + its installed shim, retires the
pairctl→Monitor enforcement hook, and rewrites the residual pairctl provenance comments in
keeper's new pair implementation. End state: pairctl lives only in git history (recoverable via
`git revert` of the deletion commit).

**Parity decision — resolved, no action:** the one open question (does `/keeper:pair` need
multi-turn-resume `--chat-id` parity before pairctl can go?) is moot — the caller audit found
ZERO live callers using pairctl's `--chat-id` resume (the only `--chat-id` hits are botctl /
Telegram, unrelated). Deletion is safe without resume parity.

## Quick commands

- `grep -rn pairctl ~/code/keeper ~/code/arthack --include="*.ts" --include="*.py" | grep -v /.keeper/` → empty after this epic (only git history / historical specs remain)
- `which pairctl` → not found (shim removed)
- arthack + keeper test suites green after removal

## Acceptance

- [ ] arthack `apps/pairctl/` package + `config/` + `prompts/` + the installed shim + any workspace/turbo registration removed
- [ ] the pairctl→Monitor enforcement hook (`claude/arthack/hooks/{pre,post}_tool_use.ts` + test) retired
- [ ] keeper residual pairctl provenance comments (cli/pair.ts, src/pair-command.ts, cli/await.ts) rewritten forward-facing — no "ported from pairctl" tombstones, no dangling refs
- [ ] no live `pairctl` references outside git history / historical `.keeper/` specs; arthack + keeper suites green

## References

- Follow-on to `fn-894-keeper-pair-via-agentwrap` (DONE) — `/keeper:pair` replaces pairctl.
- Caller audit (2026-06-22): live callers were panel + /hack (migrated by fn-894) + the 3 arthack hook files (this epic); NO multi-turn-resume usage anywhere → parity moot.
- arthack footprint: `apps/pairctl/` (`pairctl/` + `config/{claude,codex}.yaml` + `config/prompts/*.txt` + `tests/`); shim `~/.local/bin/pairctl` → `arthack/system/arthack/.local/bin/pairctl`.
- The agentwrap→keeper merge is the NEXT step after this lands + everything clears (tracked separately).
