## Overview

The native-fold epic removed the child-process spawn from `keeper plan`,
which now runs planctl's verb dispatcher in-process. The `keeper --help`
usage line for the `plan` subcommand still says it "execs planctl", which
now actively misdescribes the shipped behavior to anyone reading the help.
This is a one-line docs/help-text correction to restore parity between the
help surface and the runtime.

## Acceptance

- [ ] `keeper --help` describes `keeper plan` as running planctl in-process, not as exec'ing it
- [ ] No other "execs planctl" / spawn-implying wording remains in keeper's user-facing help

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | cli/keeper.ts:63 help says "execs planctl" but cli/keeper.ts:166 dispatches in-process; help contradicts the shipped diff |
| F2 | culled | — | lazy-import boundary holds by construction at cli/keeper.ts:166; advisory-only test nicety with no concrete user impact |

## Out of scope

- A test asserting the lazy js-yaml/yaml import boundary (F2, culled — guaranteed structurally by the handler-scoped `await import`)
- Any change to the in-process dispatch behavior itself
