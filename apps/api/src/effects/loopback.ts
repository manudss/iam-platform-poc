/** Local-only guard: demo targets (notification sink, provisioning target) must be loopback URLs. Nothing leaves this machine. */
export function assertLoopback(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== 'http:') throw new Error('demo targets must use http on loopback');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error(`refused: ${u.hostname} is not a loopback host (demo targets are local only)`);
  return u;
}
