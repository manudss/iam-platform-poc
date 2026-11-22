/** Server-owned freeze. There is deliberately no environment, graph or request override.
 * Generic set-temporary-password/badge operations are outside the incomplete approval-bound reset path.
 */
export const RESET_FROZEN = 'RESET_FROZEN: approved password reset is NOT READY; real execution is refused before the first step. Existing effects are not undone and require manual reconciliation.';
export function isFrozenApprovedReset(graph: unknown): boolean {
  const nodes = (graph as { nodes?: unknown[] } | null)?.nodes;
  if (!Array.isArray(nodes)) return false;
  return nodes.some(raw => {
    const n = raw as { type?: string; config?: Record<string, unknown> };
    if (['lyam-propose-password-reset', 'lyam-apply-password-reset'].includes(n?.type ?? '')) return true;
    if (!['lyam-publish-workspace', 'lyam-send-secret-mail'].includes(n?.type ?? '')) return false;
    return ['resetApprovalTaskId', 'resetSubject', 'resetHours', 'resetRevision'].some(k => String(n?.config?.[k] ?? '').trim() !== '');
  });
}
