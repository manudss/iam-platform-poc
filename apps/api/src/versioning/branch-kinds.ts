/**
 * Branch naming convention. Every branch the platform creates by itself lives in a folder that says what it is for, so merge
 * policies can target a TYPE of branch (for example "managers may merge profile/ branches into main, nothing else").
 *
 *   personal/<user>      the personal admin branch (one per administrator)
 *   profile/<subject>    pending edits of one person's profile
 *   ai/<session>         an AI (MCP) session working branch
 *   workflow/<run>       a workflow run
 *   feature/<name>       a change made by hand (the Explorer proposes it; any other name is still accepted)
 *
 * Branches created before this convention keep their names and keep working: `branchKind` also recognises the old patterns
 * (profile-*, mcp-*, wf-*) so a policy written for "profile" covers them too. No data migration.
 */
export const BRANCH_KINDS = ['personal', 'profile', 'ai', 'workflow', 'feature'] as const;
export type BranchKind = (typeof BRANCH_KINDS)[number] | 'other';

export function branchKind(name: string): BranchKind {
  const folder = name.includes('/') ? name.slice(0, name.indexOf('/')) : '';
  if ((BRANCH_KINDS as readonly string[]).includes(folder)) return folder as BranchKind;
  if (/^profile-/.test(name)) return 'profile';
  if (/^mcp-[0-9a-f]{12}/.test(name)) return 'ai';
  if (/^wf-[0-9a-f]/.test(name)) return 'workflow';
  return 'other';
}

/** `kind/slug`, cut to the 63 characters a branch name may have. */
export function autoBranchName(kind: Exclude<BranchKind, 'other'>, slug: string): string {
  const s = String(slug).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/\.\.+/g, '.').replace(/\.lock$/, '');
  return `${kind}/${s || 'x'}`.slice(0, 63);
}
