## Description

**Size:** M
**Files:** claude/matt/.claude-plugin/plugin.json, claude/matt/README.md, claude/matt/LICENSE, claude/matt/skills/teach/SKILL.md, claude/matt/skills/teach/MISSION-FORMAT.md, claude/matt/skills/teach/RESOURCES-FORMAT.md, claude/matt/skills/teach/LEARNING-RECORD-FORMAT.md, claude/matt/skills/teach/GLOSSARY-FORMAT.md, claude/matt/skills/grill-me/SKILL.md, claude/matt/skills/prototype/SKILL.md, claude/matt/skills/prototype/LOGIC.md, claude/matt/skills/prototype/UI.md, NOTICES, claude/CLAUDE.md

### Approach

Establish the plugin and land the three mechanical vendors. Manifest matches the sibling shape (name matt, one-line verb-phrase description, version 1.0.0, author ArtHack); skills are auto-discovered so the manifest lists none. The plugin README is the fork's contract: MIT attribution summary, the pinned source (mattpocock/skills@1445797d, local checkout /Users/mike/src/mattpocock--skills), the four-step transform every fork applies (copy verbatim at pin; frontmatter — ensure disable-model-invocation: true, add upstream + upstream-path provenance keys, re-tune the description as a trigger condition for this ecosystem, add argument-hint; address swap "the user" to "the human", body prose otherwise untouched; repoint refs, each documented), and a sync-log section (one line per sync). LICENSE carries the verbatim MIT text + Matt Pocock copyright; the repo-root NOTICES gains a matching entry in its existing delimiter style. Vendor teach (SKILL.md + its four FORMAT siblings — workspace-internal refs are safe), grill-me (fork: the one-line body is replaced by the inlined grilling primitive from the pinned source's productivity/grilling/SKILL.md — interview relentlessly, walk each branch of the decision tree resolving dependencies one at a time, attach a recommended answer to every question, one question at a time, self-serve from the codebase instead of asking), and prototype (add disable-model-invocation: true — it is model-invoked upstream — keep LOGIC/UI branch structure; the closing move notes a captured answer can feed /plan:plan or /plan:defer). Add the matt bullet to claude/CLAUDE.md "Plugins by domain" in the existing one-line style.

### Investigation targets

*Verify before relying — these refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- ~/code/arthack/claude/lsp/.claude-plugin/plugin.json and claude/arthack/.claude-plugin/plugin.json — the manifest shape to match
- ~/code/arthack/claude/arthack/skills/mrtasty/SKILL.md — the user-invoked frontmatter precedent (disable-model-invocation + argument-hint)
- /Users/mike/src/mattpocock--skills/skills/productivity/teach/, skills/productivity/grill-me/SKILL.md, skills/productivity/grilling/SKILL.md, skills/engineering/prototype/ — the pinned sources
- ~/code/arthack/NOTICES — the third-party entry style to extend
- ~/code/arthack/claude/CLAUDE.md — the Plugins by domain bullet style

### Risks

- No lint gate covers claude markdown or plugin.json — frontmatter mistakes surface only at a live launch; the mechanical acceptance greps below are the guard.
- The local checkout is behind the live upstream by design; do not fetch — vendor exactly what sits at the pin.

### Test notes

python3 -m json.tool over the manifest; grep every SKILL.md for disable-model-invocation: true and the provenance keys; confirm zero occurrences of "the user" in vendored prose.

## Acceptance

- [ ] The plugin manifest parses and matches the sibling field set; teach, grill-me, and prototype are discoverable skills, each user-invoked with provenance frontmatter and a re-tuned trigger description
- [ ] grill-me contains the full inlined interview primitive and references no /grilling
- [ ] The README records the pin, the four-step transform, and a sync-log section; LICENSE and NOTICES carry the MIT text and copyright
- [ ] Vendored prose says "the human" throughout; claude/CLAUDE.md inventories the plugin

## Done summary

## Evidence
