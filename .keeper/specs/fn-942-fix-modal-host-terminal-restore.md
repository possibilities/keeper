## Overview

The `--agentwrap-modal` host leaves the real terminal's input-reporting DEC
modes enabled when control returns to the shell, flooding the prompt with
mouse-motion (`CSI <35;…M`) and focus (`^[[I`/`^[[O`) escape sequences as
literal text. Passthrough pipes the child's (claude's) own mode-enables
(`?1003h` any-motion mouse, `?1006h` SGR, `?1004h` focus) verbatim to the real
terminal, but on teardown the host only un-raws + reverses OpenTUI's OWN modes
(`overlay?.destroy()`) — nothing disables what the CHILD turned on. Fix: the host
(the terminal owner) must emit the input-mode reset on every exit path, and
reconcile mouse/focus modes across the open↔close transition. Sibling epic
fn-935 shipped the host; fn-939 ("cover modal-host resilience invariants") is the
closely-related hardening epic.

## Quick commands

- `keeper agent claude --agentwrap-modal` → open the modal (Ctrl-]) → dismiss → exit the agent → move the mouse at the shell prompt: NO escape-sequence spillage
- `bun run test:opentui` — the modal overlay/host test chain

## Acceptance

- [ ] After the modal host exits (any path), the shell receives no mouse-motion / focus spillage — the child-left input-reporting modes are disabled
- [ ] A regression test asserts the input-mode reset fires on every exit path
