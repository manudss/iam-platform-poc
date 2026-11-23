export interface AccountBlockSummary { kind: string; until?: number; hold?: boolean }
export interface DirectoryAccountStatus { published: boolean; loginEnabled: boolean; hasCredential: boolean; blocks: AccountBlockSummary[] }
export interface DirectoryAccountStatuses { asOf: number; accounts: Record<string, DirectoryAccountStatus> }
export const BLOCK_LABELS: Record<string, string> = {
  suspended: 'Suspended', disabled: 'Deactivated', locked: 'Failed sign-in lock', pending_approval: 'Awaiting approval', pending_verification: 'Awaiting e-mail verification',
};
export const activeBlocks = <T extends AccountBlockSummary>(blocks: T[], now: number): T[] => blocks.filter(b => b.hold || b.until === undefined || b.until > now);
export function accountState(s: DirectoryAccountStatus | undefined, now: number): string {
  if (!s) return 'State unavailable';
  if (!s.published) return 'Not published';
  if (activeBlocks(s.blocks, now).length) return 'Blocked';
  if (!s.loginEnabled) return 'Sign-in disabled';
  if (!s.hasCredential) return 'No credential';
  return 'Not blocked';
}
export function matchesAccount(s: DirectoryAccountStatus | undefined, blocked: string, kind: string, now: number): boolean {
  if (!blocked && !kind) return true;
  if (!s?.published) return false; // unknown/unpublished must never count as an unblocked account
  const active = activeBlocks(s.blocks, now);
  if (blocked === 'blocked' && !active.length) return false;
  if (blocked === 'clear' && active.length) return false;
  return !kind || active.some(b => b.kind === kind);
}
