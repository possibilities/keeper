# 45. Independent note store and tmux-owned popup policy

## Status

Accepted.

## Context

Keeper needs a personal text inbox: capture a note in an editor, save it for
later, copy it, or send it to a fresh agent, while retaining processed notes as
history. The control-plane `keeper.db` is event-sourced and deliberately admits
only a narrow set of synthetic-event mutations. Putting arbitrary note bodies
there would make every body and revision permanent replay input, couple a
personal-content feature to reducer migrations, and widen the daemon RPC write
surface.

The workflow is interactive but not inherently tied to tmux. It should also work
from an ordinary terminal and remain testable without starting a tmux server.

## Decision

Notes live in a physically separate `notes.db` under Keeper's private state
directory. The store has its own forward-only `PRAGMA user_version` ladder and
never passes through the control-plane database's open, migrate, event, reducer,
or RPC paths. `keeper note` is the sole writer class; short mutations serialize
through an advisory lock and SQLite transactions, while the composer, editor,
fuzzy-picker, clipboard, and agent processes run outside both the lock and any
transaction.
Readers use the same store directly.

A Note is active until one successful clipboard copy or fresh-agent launch gives
it a Disposition and archives it. The external action and the archive update
cannot be atomic: the action runs first, then the note is archived. Failure leaves
the note active; interruption after an action succeeds can leave it active and a
retry can repeat the action. The interface states that boundary rather than
claiming exactly-once processing.

The `keeper note` commands remain ordinary terminal entrypoints. Keeper ships an
opt-in `tmux/keeper-notes.conf` drop-in beside its managed-session guard;
`keeper setup-tmux` symlinks both into the user's `conf.d`. The Note drop-in owns
the default prefix-table chords, popup geometry, caller-cwd placement, and
failure acknowledgement. Its capture chord requests a fresh blank OpenTUI
composer before every action menu. Enter continues, Shift-Enter and Ctrl-J add
newlines, Esc preserves the draft, and Ctrl-G saves it before OpenTUI suspends
and cedes the terminal directly to `$VISUAL`/`$EDITOR`; after the blocking
editor exits, OpenTUI resumes and reloads the draft. Unfinished-draft recovery
remains available through the ordinary CLI. The human's tmux
config still owns the actual prefix and whether `conf.d` is sourced. Agent selection consumes Keeper's public
project-ranking and launch-triple discovery outputs and carries the selected
triple verbatim into the existing detached launcher.

## Consequences

- Notes do not change `keeper.db` schema, event history, re-fold cost, daemon
  readiness, or its constrained mutation surface.
- `notes.db` needs independent migration, locking, backup, restore, permission,
  and test-isolation contracts.
- A failed daemon does not prevent local note reads or writes; sending still
  depends on the selected agent launcher and tmux.
- Sending deliberately crosses the private-at-rest boundary: the body rides the
  existing launcher argument into the selected harness and is then subject to
  process visibility plus that harness's transcript and retention policy.
- Popup bindings remain opt-in through `keeper setup-tmux`; a real destination
  file is never replaced, so an existing user binding policy wins explicitly.
- The honest processing guarantee is at-least-once around a crash boundary, not
  exactly-once.

Rejected: storing note bodies as control-plane events, because personal content
is not control data and immutable revisions would be retained forever; a plain
file tree, because active/archive queries, optimistic revisions, and concurrent
short-lived commands benefit from SQLite's transactions without involving the
daemon.
