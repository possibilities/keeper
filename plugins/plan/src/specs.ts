// Markdown section patching — the byte-exact port of planctl/specs.py.
//
// done is the only verb in this wave that rewrites a tracked spec file, and the
// four-H2 template shape (## Description / ## Acceptance / ## Done summary /
// ## Evidence) is the contract. patchTaskSection is whitespace-sensitive: the
// section heading line is kept verbatim, the new body is rstripped and inserted
// right after it, and every other line passes through untouched — matching
// Python line-for-line so the on-disk bytes are identical across engines.

const TASK_SPEC_HEADINGS = [
  "## Description",
  "## Acceptance",
  "## Done summary",
  "## Evidence",
] as const;

/** Escape a string for literal use inside a RegExp (re.escape equivalent). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract the body of a `## section` from spec markdown, .strip()'d. Collects
 * every line after the heading until the next `## ` heading; returns "" when the
 * section is absent. Mirrors specs.get_task_section. */
export function getTaskSection(content: string, section: string): string {
  const lines = content.split("\n");
  let inTarget = false;
  const collected: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (line.trim() === section) {
        inTarget = true;
        continue;
      }
      if (inTarget) {
        break;
      }
    }
    if (inTarget) {
      collected.push(line);
    }
  }
  return collected.join("\n").trim();
}

/** Count `^<section>\s*$` matches under MULTILINE — Python
 * len(re.findall(pattern, content, re.MULTILINE)). */
function countHeadingMatches(content: string, section: string): number {
  const re = new RegExp(`^${escapeRegExp(section)}\\s*$`, "gm");
  const matches = content.match(re);
  return matches === null ? 0 : matches.length;
}

/** Replace the body of a `## section`, keeping every other section intact.
 * Mirrors patch_task_section exactly:
 *  - >1 occurrence of the heading is a hard error (ambiguous patch target);
 *  - a leading heading line in new_content is stripped before insertion;
 *  - the heading line is re-emitted verbatim, then new_content.rstrip();
 *  - lines until the next `## ` heading are dropped, the rest pass through;
 *  - a missing section throws.
 * Throws Error (Python raises ValueError) with the same messages. */
export function patchTaskSection(
  content: string,
  section: string,
  newContent: string,
): string {
  const matches = countHeadingMatches(content, section);
  if (matches > 1) {
    throw new Error(
      `Cannot patch: duplicate heading '${section}' found (${matches} times)`,
    );
  }

  // Strip a leading section heading from newContent if present (Python:
  // new_content.lstrip().split("\n"), drop line[0] when it equals the section,
  // then lstrip the remainder).
  let body = newContent;
  const newLines = body.replace(/^\s+/, "").split("\n");
  if (newLines.length > 0 && (newLines[0] as string).trim() === section) {
    body = newLines.slice(1).join("\n").replace(/^\s+/, "");
  }

  const lines = content.split("\n");
  const result: string[] = [];
  let inTargetSection = false;
  let sectionFound = false;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (line.trim() === section) {
        inTargetSection = true;
        sectionFound = true;
        result.push(line);
        result.push(rstrip(body));
        continue;
      }
      inTargetSection = false;
    }

    if (!inTargetSection) {
      result.push(line);
    }
  }

  if (!sectionFound) {
    throw new Error(`Section '${section}' not found in task spec`);
  }

  return result.join("\n");
}

/** Trailing-whitespace strip matching Python str.rstrip() (drops every
 * Unicode-whitespace char from the end). The ASCII set covers the whitespace
 * planctl specs carry; \s in JS matches Python's str.strip whitespace closely
 * enough for these specs (spaces, tabs, newlines, CR, form feed, vertical tab). */
function rstrip(value: string): string {
  return value.replace(/\s+$/, "");
}

/** Validate the spec carries each required heading exactly once. Returns the
 * error strings (empty when valid). Mirrors validate_task_spec_headings. */
export function validateTaskSpecHeadings(content: string): string[] {
  const errors: string[] = [];
  for (const heading of TASK_SPEC_HEADINGS) {
    const count = countHeadingMatches(content, heading);
    if (count === 0) {
      errors.push(`Missing required heading: ${heading}`);
    } else if (count > 1) {
      errors.push(`Duplicate heading: ${heading} (found ${count} times)`);
    }
  }
  return errors;
}

/** Throw when the task spec headings are invalid (Python raises ValueError;
 * here a plain Error carrying the same "; "-joined message). Mirrors
 * ensure_valid_task_spec. */
export function ensureValidTaskSpec(content: string): void {
  const errors = validateTaskSpecHeadings(content);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}
