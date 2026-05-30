/**
 * Stub `main(argv)` for `keeper git`. The real renderer relocates here in
 * task .2 (early proof point) — for now we forward to the still-extant
 * `scripts/git.ts` so the dispatcher (`cli/keeper.ts`) is verifiable end-
 * to-end without waiting on the cutover. When .2 lands, replace the body
 * with the moved renderer's `main(argv)` (no longer reading
 * `Bun.argv.slice(2)` directly).
 */

export async function main(argv: string[]): Promise<void> {
  const url = new URL("../scripts/git.ts", import.meta.url);
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", url.pathname, ...argv],
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(proc.exitCode ?? 1);
}
