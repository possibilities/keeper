## Description

**Size:** S
**Files:** package.json, tsconfig.json, biome.json, .gitignore

### Approach

Mirror arthack's canonical Bun TS app shape (see `dashctl/package.json`). Create `package.json` with name `keeper`, a one-line verb-phrase `description` (required for `choosectl list-project-descriptions` routing per `~/code/CLAUDE.md`), scripts `start` / `dev` (with `bun --watch`) / `lint` / `typecheck` / `test --isolate`, and devDeps for `@biomejs/biome`, `@types/bun`, `bun-types`, `typescript`. `tsconfig.json` strict-mode. `biome.json` minimal. `.gitignore` covers `node_modules/`, `*.log`, `dist/`.

### Investigation targets

**Required** (read before coding):
- `/Users/mike/code/arthack/apps/dashctl/package.json:9-30` — canonical Bun TS package.json shape
- `/Users/mike/code/CLAUDE.md` — project conventions (compound-word name + verb-phrase description)

**Optional** (reference as needed):
- `/Users/mike/code/arthack/apps/dashctl/tsconfig.json` — strict TS config baseline
- `/Users/mike/code/arthack/apps/dashctl/biome.json` — lint config baseline

### Risks

- Omitting the `description` field will break `choosectl list-project-descriptions` routing. Make it a hard requirement of this first commit.

### Test notes

- `bun install` succeeds.
- `bun run typecheck` (≡ `tsc --noEmit`) passes against an empty src/ (or once `src/types.ts` exists, against it).
- `bun test --isolate` runs (no tests yet — pass is the empty-suite pass).

## Acceptance

- [ ] `package.json` has a one-line verb-phrase `description`
- [ ] `bun install` succeeds and produces `bun.lockb` (committed)
- [ ] `bun run typecheck` exits 0
- [ ] `bun test --isolate` runs (empty suite)
- [ ] `.gitignore` excludes `node_modules/` and local state

## Done summary
Bootstrapped keeper Bun TypeScript project: package.json with verb-phrase description, strict tsconfig (daemon-only — no DOM/JSX), biome.json, .gitignore. bun install, bun run typecheck, and bun test --isolate all green.
## Evidence
