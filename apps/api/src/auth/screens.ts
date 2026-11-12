/**
 * Screen access: which admin screen a request belongs to. One table, no per-controller decoration, so the menu (GET me/access) and the
 * API guard read the same map. A request that belongs to no known screen is `unmapped`: only the super admin rule (any resource) opens it.
 * Each entry lists the screens that may reach the route (any one is enough): the Dolt explorer shares a few read routes between its screens.
 */
export const SCREENS = ['dashboard', 'users', 'profile-fields', 'roles', 'profile-reviews', 'my-profile', 'authentication', 'assignments', 'activation', 'organizations', 'applications', 'policies', 'workflows', 'plugins', 'customisation', 'templates', 'event-bus', 'mcp', 'dolt-home', 'dolt-pulls', 'dolt-compare', 'dolt-history', 'dolt-branches', 'dolt-data', 'dolt-edit', 'dolt-sql', 'branch-manage', 'authority-edit'] as const;
export type Screen = (typeof SCREENS)[number];

const DOLT_READ: Screen[] = ['dolt-branches', 'dolt-pulls', 'dolt-compare', 'dolt-history', 'dolt-home'];

/** Dolt explorer routes below `versioning/`. */
export function doltScreens(method: string, sub: string): Screen[] {
  const m = method.toUpperCase(); const p = sub.replace(/^\/+/, '').split('?')[0];
  const seg = p.split('/');
  switch (seg[0]) {
    case 'branches': return m === 'GET' ? [...DOLT_READ, 'assignments'] : ['dolt-branches'];
    case 'protection': return DOLT_READ;
    case 'tags': return m === 'GET' ? DOLT_READ : ['dolt-branches'];
    case 'log': return ['dolt-history', 'dolt-pulls', 'dolt-compare', 'dolt-home'];
    case 'commits': return seg[2] === 'revert' ? ['dolt-edit'] : ['dolt-history', 'dolt-pulls', 'dolt-compare', 'dolt-home'];
    // The assignments screen reads the role catalogue and the diff of the assignments table only (its staged changes).
    case 'diff': return seg.length === 1 || seg[1] === 'assignments' ? ['dolt-compare', 'dolt-pulls', 'dolt-history', 'assignments'] : ['dolt-compare', 'dolt-pulls', 'dolt-history'];
    case 'tables': return m === 'POST' ? ['dolt-edit'] : seg.length > 1 ? ['dolt-data'] : ['dolt-data', 'dolt-compare', 'dolt-pulls'];
    case 'sql': return ['dolt-sql'];
    case 'pulls': return ['dolt-pulls', 'dolt-home'];
    default: return [];
  }
}

/** The screens that may reach `method path` (the part of the URL after `tenants/<tenant>/`). Empty = unmapped (super admin only). */
export function screensFor(method: string, path: string): Screen[] {
  const m = method.toUpperCase();
  const p = path.replace(/^\/+/, '').split('?')[0]; const seg = p.split('/'); const first = seg[0];
  switch (first) {
    case 'versioning': return doltScreens(method, seg.slice(1).join('/'));
    case 'users': return ['users'];
    case 'profile-reviews': return ['profile-reviews'];
    case 'profile-fields': case 'profile-components-inventory': return ['profile-fields'];
    case 'profile-components': case 'profile-schema': return ['users', 'profile-fields', 'profile-reviews', 'my-profile'];
    case 'roles': return m === 'GET' ? ['roles', 'assignments'] : ['roles'];
    case 'organizations': return m === 'GET' ? ['organizations', 'assignments'] : ['organizations'];
    case 'assignments': case 'changes': case 'connectors': return ['assignments'];
    // The personal working branch (opened at sign-in) and Apply: people editing assignments and the branch screens use them; the merge itself is decided by branch:merge.
    // Choosing, renaming, releasing or test-signing-in a branch is the branch selector and Manage branches: reserved to the roles a screen:open rule gives branch-manage (the super admin).
    case 'workspace': return seg[1] === 'branch-test' || seg[1] === 'personal' && (seg[2] === 'rename' || seg[2] === 'release') ? ['branch-manage'] : ['assignments', 'dolt-branches', 'dolt-pulls'];
    case 'activation': case 'activations': case 'audit': return ['activation'];
    case 'policies': case 'policy-studio': return ['policies'];
    case 'plugins': return ['plugins'];
    case 'mcp': case 'mcp-grants': case 'mcp-sessions': case 'mcp-upstreams': return ['mcp'];
    case 'bus': case 'event-bus': return ['event-bus'];
    case 'workflow-connections': case 'workflows': case 'temporal': case 'activation-workflows': return ['workflows'];
    case 'branding': return ['customisation'];
    case 'mail-templates': case 'templates': return ['templates'];
    case 'signup': return seg[1] === 'delivery-status' ? ['profile-fields'] : ['users'];
    case 'auth': case 'authn': case 'session': case 'sessions': case 'enrollments': return ['authentication'];
    case 'app-connectors': case 'applications': return ['applications'];
    default: return [];
  }
}
