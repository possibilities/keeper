## Overview

Follow-up to the shipped `fn-858-keeper-dispatch-manual-launch-cli`. Add a
config-driven global prompt prefix for `keeper dispatch` FREE-FORM dispatches:
a new `~/.config/keeper/config.yaml` key (`dispatch_prompt_prefix`, value e.g.
`/hack`) that, when set, is prepended with a single space to a free-form prompt
so the worker launches with `<prefix> <prompt>`. Lets the human wrap every
ad-hoc dispatch in a skill like `/hack`. Plan-form (`<verb>::<id>`) dispatches
and the no-prompt case are unaffected.

## Quick commands

```bash
# with `dispatch_prompt_prefix: /hack` in ~/.config/keeper/config.yaml
keeper dispatch --name scratch --prompt 'look at the flaky test' --dry-run
#   -> free-form prompt launches as: /hack look at the flaky test
keeper dispatch work::fn-1-foo.2 --dry-run   # plan form: UNCHANGED (no prefix)
```

## Acceptance

- [ ] A `dispatch_prompt_prefix` config key is parsed into `KeeperConfig`; absent/empty -> no prefix (behavior unchanged).
- [ ] Free-form (`--prompt`/`--prompt-file`) dispatches launch with `<prefix> <prompt>` when set; plan-form and no-prompt dispatches are never prefixed.
- [ ] The NUL/96 KB guard runs on the final prefixed prompt; `--dry-run` shows the prefixed prompt.
- [ ] `bun run test:full` passes.
