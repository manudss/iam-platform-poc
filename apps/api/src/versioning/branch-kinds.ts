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
/** `custom` = a folder of your own (team/x); `other` = no folder at all. */
export type BranchKind = (typeof BRANCH_KINDS)[number] | 'custom' | 'other';

export function branchKind(name: string): BranchKind {
  const folder = name.includes('/') ? name.slice(0, name.indexOf('/')) : '';
  if ((BRANCH_KINDS as readonly string[]).includes(folder)) return folder as BranchKind;
  if (folder) return 'custom';
  if (/^profile-/.test(name)) return 'profile';
  if (/^mcp-[0-9a-f]{12}/.test(name)) return 'ai';
  if (/^wf-[0-9a-f]/.test(name)) return 'workflow';
  return 'other';
}

/** The folder of a branch name (`team` for team/x), empty when there is none. */
export const branchFolder = (name: string) => (name.includes('/') ? name.slice(0, name.indexOf('/')) : '');

/** One entry of a protection's allowed source list: a kind, `custom` (every custom folder) or `custom:<folder>` (one of them). */
export const SOURCE_ENTRY = /^(?:personal|profile|ai|workflow|feature|other|custom|custom:[a-z][a-z0-9-]{0,15})$/;
export function sourceAllowed(entries: readonly string[], name: string): boolean {
  if (entries.length === 0) return true;
  const kind = branchKind(name);
  return entries.includes(kind) || (kind === 'custom' && entries.includes(`custom:${branchFolder(name)}`));
}
export const describeEntry = (e: string) => (e === 'custom' ? 'custom-folder' : e === 'other' ? 'no-folder' : e.startsWith('custom:') ? e.slice(7) : e) + (e === 'other' || e === 'custom' ? ' branches' : '/ branches');

/** `kind/slug`, cut to the 63 characters a branch name may have. */
export function autoBranchName(kind: Exclude<BranchKind, 'other'>, slug: string): string {
  const s = String(slug).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/\.\.+/g, '.').replace(/\.lock$/, '');
  return `${kind}/${s || 'x'}`.slice(0, 63);
}
