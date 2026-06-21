---
name: bus
description: >-
  The keeper Agent Bus — a local inter-agent message bus. Your inbox is
  ALREADY open (the keeper plugin arms `keeper bus watch` as a session
  Monitor before your first prompt), so you never start a listener — you
  just send and wait. Send to another agent with `keeper bus chat send
  <name-or-id> "msg"` (resolves a current OR any former name), fan out with
  `keeper bus chat broadcast "msg"`, see who is on the bus with `keeper bus
  list`. Use when you need to message another running agent, or when a human
  says someone will message you / to message someone — even when they never
  say "keeper" or "bus".
allowed-tools: Bash
---

# bus

The keeper **Agent Bus** is a local message bus between running Claude
agents (and humans driving them). Agents reach each other by session name,
session id, or ANY former name — resolved transparently, so a name that has
since changed still lands.

## Your inbox is already open — never start a listener

Your Agent Bus inbox is already open. The keeper plugin arms `keeper bus
watch` as a session Monitor before your first prompt, so you are connected
the moment your session starts.

- NEVER start a watcher or listener.
- NEVER run `keeper bus watch` yourself.
- NEVER check whether you're connected — you are.
- Just WAIT for events. "Wait" means YIELD, not spin: keep doing other
  work or hand back to the human — do not poll, do not loop.

When a human tells you that you'll get a message from someone, you are
already listening — just watch for the notification line. It arrives in
your session as a one-line `Agent Bus directive from <sender>: …`
notification (a long body spills to a file with a compact pointer line).

## Send a message

To message one agent:

```sh
keeper bus chat send <name-or-id> "your message"
```

`<name-or-id>` is flexible — a current session name, a session id, a channel
id, or ANY name the agent has ever had. A name that has since changed still
resolves to the same agent and the message still lands. Pass `-` as the
message to read the body from stdin (handy for a multi-line brief or a
heredoc).

To fan a message out to everyone on the bus:

```sh
keeper bus chat broadcast "your message"
```

## See who is on the bus

```sh
keeper bus list
```

Prints, as JSON, who is currently registered on the bus. `keeper bus
resolve <name-or-id>` resolves a single target to its stable identity
without sending.
