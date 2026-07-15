/** Result of one platform clipboard write. */
export type CopyResult = { ok: true } | { ok: false; error: string };

/**
 * Pipe text into macOS `pbcopy`. The caller decides whether failure is fatal;
 * this adapter never throws and never transforms the payload.
 */
export async function copyToClipboard(payload: string): Promise<CopyResult> {
  try {
    const proc = Bun.spawn(["pbcopy"], { stdin: "pipe", stderr: "pipe" });
    const stderrPromise = new Response(proc.stderr).text();
    proc.stdin.write(payload);
    await proc.stdin.end();
    const [code, stderr] = await Promise.all([proc.exited, stderrPromise]);
    if (code !== 0) {
      const detail = stderr.trim().slice(0, 512);
      return {
        ok: false,
        error: `pbcopy exited ${code}${detail === "" ? "" : `: ${detail}`}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
