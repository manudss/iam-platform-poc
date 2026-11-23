/** Wait for an observable completion barrier, not just an earlier side effect. Errors propagate. */
export async function waitForCondition(
  ready: () => boolean | Promise<boolean>,
  options: { timeoutMs: number; intervalMs: number; label: string },
): Promise<void> {
  const deadline = performance.now() + options.timeoutMs;
  for (;;) {
    if (await ready()) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${options.label}`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(options.intervalMs, remaining)));
  }
}
