---
name: rename
description: >-
  Rename the current Keeper-managed Claude Session. Bare `/rename` derives a
  canonical title from bounded conversation context; `/rename <slug>` accepts
  one already-canonical lowercase slug. Human invocation only.
allowed-tools: ""
argument-hint: "[canonical-slug]"
disable-model-invocation: true
---

# rename

A Keeper `UserPromptSubmit` hook performs the rename before this command turn.
It either commits through Claude's native Session title output or leaves the
existing title unchanged with a fixed status message.

A bare invocation requests bounded inference:

```text
/rename
```

An explicit invocation accepts exactly one canonical slug: lowercase ASCII
letters, digits, and single hyphens, with no leading or trailing hyphen and no
more than 64 characters.

```text
/rename project-search-ranking
```

An argument is never normalized on the user's behalf. Paths and file
references such as `/rename @src/search.ts`, extra arguments, and noncanonical
text are invalid and leave the title unchanged.

Acknowledge the hook's `/rename:` status in one short sentence, then stop. Do
not infer a title yourself, use tools, read or modify files, perform source
work, or invoke `/rename` recursively. This acknowledgment and its command
scaffolding are not future naming input.
