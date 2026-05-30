/**
 * Stub `main(argv)` for `keeper board`. The real renderer relocates here in
 * task .4 — for now we forward to the still-extant `scripts/board.ts` so the
 * dispatcher (`cli/keeper.ts`) is verifiable end-to-end without waiting on
 * the cutover. When .4 lands, replace the body with the moved renderer's
 * `main(argv)` (no longer reading `Bun.argv.slice(2)` directly).
 */

export async function main(argv: string[]): Promise<void> {
  // Forward via Bun.spawnSync so the existing script's `import.meta.main`
  // guard fires. This is a temporary shim — task .4 moves the renderer
  // into this file and the spawn vanishes.
  const url = new URL("../scripts/board.ts", import.meta.url);
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", url.pathname, ...argv],
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(proc.exitCode ?? 1);
}
