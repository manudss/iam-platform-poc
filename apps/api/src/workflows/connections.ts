import { assertAutomationAllowed } from '../automation/hold.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { SecretsService } from '../integrations/secrets.service.js';
import { currentBranch } from '../workspace/context.js';
import { WorkflowStore } from './store.js';

export type ConnectionProvider = 'google-sheets' | 'jira' | 'http';
export interface WorkflowConnection { id: string; tenant: string; name: string; provider: ConnectionProvider; config: Record<string, string>; secretRef: string | null; revision: string; }
/** Closed set of failure classes shown to the admin. Upstream text, status bodies, identifiers and secrets never reach the result or the logs. */
export type ProbeFailure = 'configuration' | 'secret-store' | 'credential-format' | 'credential-rejected' | 'forbidden' | 'not-found' | 'api-disabled' | 'network' | 'upstream-status' | 'unknown';
const PROBE_FAILURE_MESSAGE: Record<ProbeFailure, string> = {
  configuration: 'Read-only check failed: the connection settings are incomplete or invalid.',
  'secret-store': 'Read-only check failed: the stored credential could not be read.',
  'credential-format': 'Read-only check failed: the credential does not have the expected format.',
  'credential-rejected': 'Read-only check failed: the service rejected the credential (401 or invalid grant).',
  forbidden: 'Read-only check failed: the credential is valid but not allowed to read this resource (403, scopes or sharing).',
  'not-found': 'Read-only check failed: the service did not find the site, project or document (404).',
  'api-disabled': 'Read-only check failed: the service API is not enabled for this account.',
  network: 'Read-only check failed: the service could not be reached from this server.',
  'upstream-status': 'Read-only check failed: the service answered with an unexpected status.',
  unknown: 'Read-only check failed. Check connection configuration and service access.',
};
/** Reads only status numbers, error codes and fixed keywords. Returns a class, never the upstream text. */
export function classifyProbeError(e: unknown): ProbeFailure {
  const err = e as {code?: unknown; status?: unknown; response?: {status?: unknown}; message?: unknown; name?: unknown} | null;
  const status = Number(err?.response?.status ?? err?.status ?? (typeof err?.code === 'number' ? err.code : NaN));
  const code = typeof err?.code === 'string' ? err.code : '';
  const msg = typeof err?.message === 'string' ? err.message.toLowerCase() : '';
  // An HTTP status from the service comes first: a parse error elsewhere must not hide it.
  if (Number.isFinite(status) && status > 0) {
    if (status === 401) return 'credential-rejected';
    if (status === 403) return msg.includes('has not been used in project') && msg.includes('before or it is disabled') ? 'api-disabled' : 'forbidden';
    if (status === 404) return 'not-found';
    return 'upstream-status';
  }
  if (msg.includes('invalid_grant') || msg.includes('invalid_client') || msg.includes('unauthorized_client')) return 'credential-rejected';
  if (err?.name === 'SyntaxError' || msg.includes('private key') || msg.includes('client_email') || msg.includes('pem routines') || msg.includes('asn1')) return 'credential-format';
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(code) || msg.includes('external request failed') || msg.includes('external request timed out') || msg.includes('destination lookup') || msg.includes('non-public destination') || msg.includes('response interrupted')) return 'network';
  if (msg.includes('missing spreadsheet') || msg.includes('https url')) return 'configuration';
  return 'unknown';
}
const tenantId = (t: string) => { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(t)) throw new BadRequestException('invalid connection tenant'); return t; };
const ID = /^[a-z0-9][a-z0-9-]{0,38}$/;
export function connectionId(value: unknown): string { if (typeof value !== 'string' || !ID.test(value)) throw new BadRequestException('invalid connection id'); return value; }
/** https://api.atlassian.com/ex/jira/<cloudId>: the gateway of one Jira site (tokens with scopes only work there). */
const jiraGateway = (url: URL) => url.hostname === 'api.atlassian.com' && /^\/ex\/jira\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\/?$/i.test(url.pathname);
/** Read-only check: a site origin reads the current account; a gateway reads one project page (a scoped token may lack read:me). */
const jiraProbeUrl = (instanceUrl: string) => { const u = new URL(instanceUrl); return jiraGateway(u) ? `${u.origin}${u.pathname.replace(/\/$/, '')}/rest/api/3/project/search?maxResults=1` : new URL('/rest/api/3/myself', u).toString(); };
export const connectionProvider = (type: string): ConnectionProvider | null => type.startsWith('google-sheets-') ? 'google-sheets' : type.startsWith('jira-') ? 'jira' : type === 'http-request' ? 'http' : null;
/** Config fields that decide WHERE the stored credential is sent or as WHOM it acts: changing one needs the credential typed again, so a stored secret never follows a new destination. */
const BOUND = ['instanceUrl', 'baseUrl', 'siteUrl', 'email', 'userEmail', 'spreadsheetId', 'sheetId'];
/** The seal kept WITH the secret in the secret store (outside Dolt): provider and every bound field. resolve() recomputes it from the stored configuration, so a row edited in Dolt by any other path never receives the credential. */
export const bindOf = (provider: string, config: Record<string, string>) => createHash('sha256').update(JSON.stringify([provider, ...BOUND.map(k => config[k] ?? '')])).digest('hex');
/** Real external connections are OFF unless the server is explicitly started for them (a private space). Never inferred from data, never settable from a workflow or a connection. */
export const realConnectionsEnabled = () => process.env.IAM_WORKFLOW_REAL_CONNECTIONS === '1';
const requireRealEnabled = () => { if (!realConnectionsEnabled()) throw new ServiceUnavailableException('real external connections are disabled on this server (IAM_WORKFLOW_REAL_CONNECTIONS is not 1): nothing was saved, read or called'); };
export const destinationChanged = (before: Record<string, string>, after: Record<string, string>) => BOUND.some(k => (before[k] ?? '') !== (after[k] ?? ''));
export function validateConnection(body: Record<string, unknown>) {
  if (Object.keys(body).some(k => !['name', 'provider', 'config', 'secret'].includes(k))) throw new BadRequestException('unknown connection field');
  const provider = body.provider as ConnectionProvider;
  if (!['google-sheets', 'jira', 'http'].includes(provider)) throw new BadRequestException('invalid connection provider');
  const name = String(body.name ?? '').trim(); if (!name || name.length > 80) throw new BadRequestException('connection name required (max 80)');
  const raw = body.config; if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('connection config must be an object');
  const allowed = provider === 'jira' ? ['instanceUrl', 'email', 'siteUrl'] : provider === 'google-sheets' ? ['userEmail', 'spreadsheetId', 'sheetId'] : ['baseUrl'];
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) { if (!allowed.includes(k) || typeof v !== 'string' || v.length > 300) throw new BadRequestException('invalid connection config'); config[k] = v; }
  if (provider === 'jira' || provider === 'http') {
    let url: URL; try { url = new URL(config[provider === 'jira' ? 'instanceUrl' : 'baseUrl']); } catch { throw new BadRequestException('HTTPS URL required'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) throw new BadRequestException('invalid connection HTTPS URL');
    if (provider === 'jira') {
      // A site origin (classic token) or the Atlassian gateway of one site (the only form a token with scopes accepts).
      if (!jiraGateway(url) && !/^[a-z0-9-]+\.atlassian\.net$/i.test(url.hostname)) throw new BadRequestException('invalid connection HTTPS URL');
      if (!jiraGateway(url) && url.pathname !== '/') throw new BadRequestException('Jira URL must be its site origin');
    }
    config[provider === 'jira' ? 'instanceUrl' : 'baseUrl'] = url.toString();
  }
  if (provider === 'jira' && config.siteUrl !== undefined) {
    // Optional: the browsable site, used only to build ticket links when instanceUrl is a gateway.
    let site: URL; try { site = new URL(config.siteUrl); } catch { throw new BadRequestException('invalid Jira site URL'); }
    if (site.protocol !== 'https:' || site.username || site.password || site.search || site.hash || site.port || site.pathname !== '/' || !/^[a-z0-9-]+\.atlassian\.net$/i.test(site.hostname)) throw new BadRequestException('invalid Jira site URL');
    config.siteUrl = site.toString();
  }
  if (provider === 'jira' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email ?? '')) throw new BadRequestException('Jira account email required');
  if (provider === 'google-sheets' && config.sheetId && !/^\d{1,12}$/.test(config.sheetId)) throw new BadRequestException('sheet ID must be numeric');
  if (body.secret !== undefined && (typeof body.secret !== 'string' || !body.secret || body.secret.length > 20000)) throw new BadRequestException('invalid write-only secret');
  if (provider === 'google-sheets' && body.secret) {
    let key: Record<string, unknown>; try { key = JSON.parse(String(body.secret)); } catch { throw new BadRequestException('service account must be JSON'); }
    if ((key.universe_domain !== undefined && key.universe_domain !== 'googleapis.com') || key.type !== 'service_account' || typeof key.client_email !== 'string' || !key.client_email.endsWith('.gserviceaccount.com') || typeof key.private_key !== 'string' || !key.private_key.includes('PRIVATE KEY') || !['https://oauth2.googleapis.com/token', 'https://accounts.google.com/o/oauth2/token'].includes(String(key.token_uri))) throw new BadRequestException('invalid Google service-account fields');
  }
  return { name, provider, config, secret: body.secret as string | undefined };
}

/** Metadata is reviewed/versioned in Dolt. Credentials only live in OpenBao under immutable tenant-scoped revisions. */
@Injectable()
export class WorkflowConnections {
  constructor(private readonly store: WorkflowStore, private readonly secrets: SecretsService) {}
  async list(tenant: string) { return { connections: (await this.store.listConnections(tenant, currentBranch())).map(c => this.public(c)), secretStoreConfigured: this.secrets.enabled }; }
  private public(c: WorkflowConnection) { const { secretRef, tenant, ...rest } = c; return { ...rest, secretConfigured: !!secretRef, status: secretRef || c.provider === 'http' ? 'Needs test' : 'Not configured' }; }
  async save(tenant: string, id: string | undefined, body: Record<string, unknown>) {
    assertAutomationAllowed();
    const ref = currentBranch(true), clean = validateConnection(body);
    const cid = id ? connectionId(id) : `conn-${randomUUID().slice(0, 18)}`;
    const previous = id ? await this.store.getConnection(tenant, cid, ref) : null;
    if (id && !previous) throw new NotFoundException('unknown connection');
    if (previous && previous.provider !== clean.provider) throw new BadRequestException('connection provider cannot change');
    if (previous?.secretRef && !clean.secret && destinationChanged(previous.config, clean.config)) throw new BadRequestException('changing the destination or the account needs the credential entered again');
    const revision = randomUUID(); let secretRef = previous?.secretRef ?? null;
    if (clean.secret) {
      requireRealEnabled();
      if (!this.secrets.enabled) throw new ServiceUnavailableException('OpenBao is not configured; no plaintext credential fallback');
      secretRef = `iam/workflow-connections/${tenantId(tenant)}/${cid}/${revision}`;
      await this.secrets.put(secretRef, { value: clean.secret, bind: bindOf(clean.provider, clean.config) });
    }
    const connection: WorkflowConnection = { id: cid, tenant, name: clean.name, provider: clean.provider, config: clean.config, secretRef, revision };
    await this.store.putConnection(connection, ref);
    return { connection: this.public(connection) };
  }
  async remove(tenant: string, id: string) { assertAutomationAllowed(); const cid = connectionId(id); if (!await this.store.deleteConnection(tenant, cid, currentBranch(true))) throw new NotFoundException('unknown connection'); return { deleted: cid }; }
  /** Explicit operator action: read-only probe, no remote response data or secret in the response. */
  async test(tenant: string, id: string) {
    assertAutomationAllowed();
    requireRealEnabled();
    const ref = currentBranch(), c = await this.store.getConnection(tenant, connectionId(id), ref);
    if (!c) throw new NotFoundException('unknown connection');
    try { const {settings} = await this.resolve(tenant, ref, id, c.provider); return {...await this.probe(c.provider, c.config, settings), id: c.id, revision: c.revision}; }
    catch { return {...this.probeFailed(), id: c.id, revision: c.revision}; }
  }
  /** Tests unsaved form values in memory only. An optional existing id supplies its unchanged secret. */
  async testDraft(tenant: string, body: Record<string, unknown>) {
    assertAutomationAllowed();
    const {existingId, ...input} = body;
    const clean = validateConnection(input);
    requireRealEnabled();
    let secret = clean.secret ?? '';
    if (existingId !== undefined) {
      const id = connectionId(existingId);
      const c = await this.store.getConnection(tenant, id, currentBranch());
      if (!c || c.provider !== clean.provider) throw new NotFoundException('connection missing or wrong provider');
      if (!secret && destinationChanged(c.config, clean.config)) throw new BadRequestException('changing the destination or the account needs the credential entered again');
      if (!secret) { try { secret = (await this.resolve(tenant, currentBranch(), id, clean.provider)).secret; } catch { return this.probeFailed('secret-store'); } }
    }
    if (clean.provider !== 'http' && !secret) return this.probeFailed('configuration');
    // Raw form secrets never enter Dolt, OpenBao, response bodies or error strings.
    const settings = this.settings(clean.provider, clean.config, secret);
    return this.probe(clean.provider, clean.config, settings);
  }
  private settings(provider: ConnectionProvider, config: Record<string,string>, secret: string): Record<string, unknown> {
    return provider === 'jira' ? {jiraInstanceUrl: config.instanceUrl, jiraSiteUrl: config.siteUrl, jiraEmail: config.email, jiraApiToken: secret} : provider === 'google-sheets' ? {googleServiceAccount: secret, googleUserEmail: config.userEmail} : {httpAllowlist: new URL(config.baseUrl).hostname, httpConnectionBase: config.baseUrl, httpConnectionToken: secret};
  }
  private probeFailed(reason: ProbeFailure = 'unknown') { return {status: 'Failed', checkedAt: new Date().toISOString(), readOnly: true, reason, message: PROBE_FAILURE_MESSAGE[reason]}; }
  protected async httpProbe(url: string, options: unknown) {
    const transport = loadPluginModule('workflow-connectors', 'http-transport.mjs') as {safeHttp: (url: string, opts: unknown) => Promise<{status:number}>};
    return transport.safeHttp(url, options);
  }
  private async probe(provider: ConnectionProvider, config: Record<string,string>, settings: Record<string,unknown>) {
    try {
      if (provider === 'google-sheets') {
        if (!config.spreadsheetId || !/^[A-Za-z0-9_-]{10,200}$/.test(config.spreadsheetId)) throw new Error('missing spreadsheet');
        const adapter = loadPluginModule('workflow-connectors', 'adapter.mjs') as {runPieceAction: (pkg: string, action: string, values: unknown) => Promise<unknown>};
        await adapter.runPieceAction('@activepieces/piece-google-sheets', 'get-many-rows', {auth: {type: 'CUSTOM_AUTH', props: {serviceAccount: settings.googleServiceAccount, userEmail: settings.googleUserEmail || undefined}}, propsValue: {spreadsheetId: config.spreadsheetId, sheetId: Number(config.sheetId || 0), includeTeamDrives: false, first_row_headers: true}});
      } else {
        const headers: Record<string,string> = provider === 'jira' ? {Authorization: 'Basic ' + Buffer.from(`${settings.jiraEmail}:${settings.jiraApiToken}`).toString('base64')} : settings.httpConnectionToken ? {Authorization: `Bearer ${settings.httpConnectionToken}`} : {};
        const result = await this.httpProbe(provider === 'jira' ? jiraProbeUrl(config.instanceUrl) : config.baseUrl, {method: provider === 'jira' ? 'GET' : 'HEAD', headers});
        if (result.status < 200 || result.status >= 300) throw Object.assign(new Error('probe unsuccessful'), {status: result.status});
      }
      return {status: 'Verified', checkedAt: new Date().toISOString(), readOnly: true};
    } catch (e) { return this.probeFailed(classifyProbeError(e)); }
  }
  async resolve(tenant: string, ref: string, id: string, provider: ConnectionProvider) {
    assertAutomationAllowed();
    requireRealEnabled();
    const c = await this.store.getConnection(tenant, connectionId(id), ref);
    if (!c || c.tenant !== tenant || c.id !== id || c.provider !== provider) throw new NotFoundException('connection missing or wrong provider');
    let secret = '';
    if (c.secretRef) {
      if (!new RegExp(`^iam/workflow-connections/${tenantId(tenant)}/${connectionId(c.id)}/[a-f0-9-]{36}$`).test(c.secretRef)) throw new ConflictException('invalid scoped secret reference');
      let rec: { value?: string; bind?: string } | undefined;
      try { rec = await this.secrets.get(c.secretRef) as { value?: string; bind?: string } | undefined; } catch { throw new ServiceUnavailableException('connection secret unavailable'); }
      secret = rec?.value ?? '';
      // The credential was sealed to one provider, destination, account and target when it was entered: any other configuration (a row edited in Dolt, a merge, a future endpoint) never receives it. A record without the seal is refused.
      if (secret && rec?.bind !== bindOf(provider, c.config)) throw new ConflictException('the stored credential is not bound to this connection destination: enter it again');
    }
    if (provider !== 'http' && !secret) throw new ServiceUnavailableException('connection secret not configured');
    // Revalidate persisted config and credentials too: versioned metadata is not trusted input.
    validateConnection({name: c.name, provider, config: c.config, ...(secret ? {secret} : {})});
    const settings = this.settings(provider, c.config, secret);
    return { settings, secret, connection: c };
  }
}
