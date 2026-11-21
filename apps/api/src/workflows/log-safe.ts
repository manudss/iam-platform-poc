/** A log reason that never carries the error text: only the error class name and a bounded upper-case code. */
export function safeReason(e: unknown): string {
  const err = e as { name?: unknown; code?: unknown } | null;
  const name = typeof err?.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'Error';
  const code = typeof err?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code) ? ` ${err.code}` : '';
  return `${name}${code}`;
}
