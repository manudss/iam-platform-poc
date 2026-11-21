/**
 * Jira reads for the "ticket reached Done" watcher. Read-only: one JQL search, no write.
 *
 * Base URL: either the site origin (https://<site>.atlassian.net, classic tokens) or the Atlassian gateway of
 * the site (https://api.atlassian.com/ex/jira/<cloudId>, the only form a token with scopes accepts).
 * Nothing else is called. Redirects are never followed. The token only goes in the Authorization header.
 */
const SITE = /^https:\/\/[a-z0-9-]+\.atlassian\.net\/?$/i;
const GATEWAY = /^https:\/\/api\.atlassian\.com\/ex\/jira\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;
export const isJiraBase = (u) => typeof u === 'string' && (SITE.test(u) || GATEWAY.test(u));
const jqlText = (s) => `"${String(s).replace(/["\\]/g, '')}"`;

/** The JQL for the watcher: project, optional label, done category, recent updates only. Pure. */
export function doneJql(config) {
  const project = String(config.project ?? '');
  if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(project)) throw new Error('jira project key required (for example KAN)');
  const parts = [`project = ${project}`];
  const label = String(config.label ?? '');
  if (label) { if (!/^[A-Za-z0-9_.-]{1,60}$/.test(label)) throw new Error('jira label: letters, digits, dot, dash, underscore'); parts.push(`labels = ${jqlText(label)}`); }
  parts.push(`status = ${jqlText(config.doneStatus || 'Done')}`);
  const days = Math.min(30, Math.max(1, Number(config.lookbackDays ?? 7) || 7));
  parts.push(`updated >= -${days}d`);
  return `${parts.join(' AND ')} ORDER BY updated ASC`;
}

/**
 * Tickets currently in the done status. Returns [{ key, id, values }] where values holds only
 * non-secret scalar fields (summary, status, updated). Throws a message with no credential in it.
 */
export async function readDoneIssues(settings, config, doFetch = fetch) {
  const base = String(settings?.jiraInstanceUrl ?? '').replace(/\/$/, '');
  const email = String(settings?.jiraEmail ?? '');
  const token = String(settings?.jiraApiToken ?? '');
  if (!isJiraBase(base + '/') || !email || !token) throw new Error('jira connection incomplete');
  const res = await doFetch(`${base}/rest/api/3/search/jql`, {
    method: 'POST', redirect: 'manual',
    headers: { Authorization: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64'), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql: doneJql(config), fields: ['summary', 'status', 'updated'], maxResults: 25 }),
  });
  if (res.status !== 200) throw new Error(`jira search refused (HTTP ${res.status})`);
  const data = await res.json();
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  return issues.filter((i) => /^[A-Z][A-Z0-9_]+-\d+$/.test(String(i?.key))).map((i) => ({
    key: String(i.key), id: String(i.id ?? ''),
    values: { key: String(i.key), summary: String(i.fields?.summary ?? '').slice(0, 200), status: String(i.fields?.status?.name ?? ''), updated: String(i.fields?.updated ?? '') },
  }));
}
