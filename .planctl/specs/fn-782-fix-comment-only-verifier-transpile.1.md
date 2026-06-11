## Description

From audit finding F1 (Should Fix) with F2 (Consider) merged in.
Evidence path: scripts/assert-comment-only.ts:172-177 — both
`ts.transpileModule` calls pass `{ compilerOptions: TRANSPILE_OPTIONS }`
with no `fileName`, so the TS compiler's default extensionless filename
makes it parse a module-scope generic arrow (`asArray = <T>() => ...`,
as in cli/autopilot.ts) as JSX, producing a spurious transpile-output
divergence. Token-equality (check #1) is authoritative and caught nothing,
so the scrub was genuinely comment-only; only the second witness is broken.

Fix: pass `fileName` into both `transpileModule` calls, keyed on whether
the path is JSX (e.g. `f.tsx` for JSX paths, `f.ts` otherwise) so the
parser picks the correct language variant.

F2 (merged): the existing fixtures in test/assert-comment-only.test.ts
drive `checkCommentOnly` with literal strings and never hit the
generic-arrow transpile path. Add a fixture with a module-scope `<T>()`
generic arrow so the previously-broken path is covered. F1 (the fileName
fix) and F2 (the covering fixture) share one root cause and one file-touch
set and land as one commit.

## Acceptance

- [ ] Both `transpileModule` calls receive a `fileName` chosen by JSX-ness.
- [ ] A new fixture with a module-scope generic arrow passes the transpile
      witness (and would have false-positived before the fix).
- [ ] biome + typecheck + the assert-comment-only test green.

## Done summary

## Evidence
