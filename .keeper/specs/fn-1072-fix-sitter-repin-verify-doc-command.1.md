## Description

Finding F1 (evidence: /Users/mike/code/sitter/README.md:366-367). The
"Verifying the pin tracks keeper" section's cross-check command is
`sqlite3 'file:$KEEPER_DB?mode=ro' "..."`. The single quotes prevent
`$KEEPER_DB` from expanding, so a copy-paste reader gets a literal
`$KEEPER_DB` path and an "unable to open database" error, and the
documented default (`~/.local/state/keeper/keeper.db`) is never resolved.
Fix the quoting so the URI expands the env var with the documented default
as fallback (e.g. `"file:${KEEPER_DB:-$HOME/.local/state/keeper/keeper.db}?mode=ro"`).

## Acceptance

- [ ] The command, copy-pasted as-is, opens the keeper DB read-only and prints the schema_version both with `KEEPER_DB` set and unset.

## Done summary
Fixed the repin-verify README cross-check command: replaced the single-quoted URI (which blocked $KEEPER_DB expansion) with a double-quoted URI using the documented default fallback, verified working with KEEPER_DB set and unset.
## Evidence
