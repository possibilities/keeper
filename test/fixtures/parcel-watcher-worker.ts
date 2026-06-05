/**
 * fn-701 task .3 boot-smoke fixture. A minimal stand-in for keeper's five
 * `@parcel/watcher`-loading workers (transcript / plan / git / usage /
 * dead-letter): it does the SAME `import("@parcel/watcher")`
 * then actually `subscribe()`s (forcing the full native N-API surface to
 * resolve, the path that exposed the `napi_register_module_v1` concurrent-dlopen
 * race), then reports success/failure back to the spawning test.
 *
 * The boot smoke test spawns N of these concurrently after a main-thread
 * pre-warm and asserts every one reaches "subscribed" without exiting — the
 * regression guard for the pre-warm fix. Lives under test/fixtures/ so
 * `@parcel/watcher` resolves from the repo's node_modules exactly as the real
 * workers do.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

void (async () => {
  try {
    const mod = await import("@parcel/watcher");
    const dir = mkdtempSync(join(tmpdir(), "keeper-parcel-smoke-"));
    const sub = await mod.subscribe(dir, () => {});
    await sub.unsubscribe();
    postMessage({ ok: true });
  } catch (err) {
    postMessage({
      ok: false,
      err: err instanceof Error ? err.message : String(err),
    });
  }
})();
