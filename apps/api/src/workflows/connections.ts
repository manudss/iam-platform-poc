import { loadPluginModule } from '../plugins/v1/loader.js';
import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SecretsService } from '../integrations/secrets.service.js';
import { currentBranch } from '../workspace/context.js';
import { WorkflowStore } from './store.js';

export type ConnectionProvider = 'google-sheets' | 'jira' | 'http';
export interface WorkflowConnection { id: string; tenant: string; name: string; provider: ConnectionProvider; config: Record<string, string>; secretRef: string | null; revision: string; }
const tenantId = (t: string) => { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(t)) throw new BadRequestException('invalid connection tenant'); return t; };
const ID = /^[a-z0-9][a-z0-9-]{0,38}$/;
export function connectionId(value: unknown): string { if (typeof value !== 'string' || !ID.test(value)) throw new BadRequestException('invalid connection id'); return value; }
export const connectionProvider = (type: string): ConnectionProvider | null => type.startsWith('google-sheets-') ? 'google-sheets' : type.startsWith('jira-') ? 'jira' : type === 'http-request' ? 'http' : null;
export function validateConnection(body: Record<string, unknown>) {
  if (Object.keys(body).some(k => !['name', 'provider', 'config', 'secret'].includes(k))) throw new BadRequestException('unknown connection field');
  const provider = body.provider as ConnectionProvider;
  if (!['google-sheets', 'jira', 'http'].includes(provider)) throw new BadRequestException('invalid connection provider');
  const name = String(body.name ?? '').trim(); if (!name || name.length > 80) throw new BadRequestException('connection name required (max 80)');
  const raw = body.config; if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('connection config must be an object');
  const allowed = provider === 'jira' ? ['instanceUrl', 'email'] : provider === 'google-sheets' ? ['userEmail', 'spreadsheetId', 'sheetId'] : ['baseUrl'];
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) { if (!allowed.includes(k) || typeof v !== 'string' || v.length > 300) throw new BadRequestException('invalid connection config'); config[k] = v; }
  if (provider === 'jira' || provider === 'http') {
    let url: URL; try { url = new URL(config[provider === 'jira' ? 'instanceUrl' : 'baseUrl']); } catch { throw new BadRequestException('HTTPS URL required'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || (provider === 'jira' && !/^[a-z0-9-]+\.atlassian\.net$/i.test(url.hostname))) throw new BadRequestException('invalid connection HTTPS URL');
    if (provider === 'jira' && url.pathname !== '/') throw new BadRequestException('Jira URL must be its site origin');
    config[provider === 'jira' ? 'instanceUrl' : 'baseUrl'] = url.toString();
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
    const ref = currentBranch(true), clean = validateConnection(body);
    const cid = id ? connectionId(id) : `conn-${randomUUID().slice(0, 18)}`;
    const previous = id ? await this.store.getConnection(tenant, cid, ref) : null;
    if (id && !previous) throw new NotFoundException('unknown connection');
    if (previous && previous.provider !== clean.provider) throw new BadRequestException('connection provider cannot change');
    const revision = randomUUID(); let secretRef = previous?.secretRef ?? null;
    if (clean.secret) {
      if (!this.secrets.enabled) throw new ServiceUnavailableException('OpenBao is not configured; no plaintext credential fallback');
      secretRef = `iam/workflow-connections/${tenantId(tenant)}/${cid}/${revision}`;
      await this.secrets.put(secretRef, { value: clean.secret });
    }
    const connection: WorkflowConnection = { id: cid, tenant, name: clean.name, provider: clean.provider, config: clean.config, secretRef, revision };
    await this.store.putConnection(connection, ref);
    return { connection: this.public(connection) };
  }
  async remove(tenant: string, id: string) { const cid = connectionId(id); if (!await this.store.deleteConnection(tenant, cid, currentBranch(true))) throw new NotFoundException('unknown connection'); return { deleted: cid }; }
  /** Explicit operator action: read-only probe, no remote response data or secret in the response. */
  async test(tenant: string, id: string) {
    const ref = currentBranch(), c = await this.store.getConnection(tenant, connectionId(id), ref);
    if (!c) throw new NotFoundException('unknown connection');
    try { const {settings} = await this.resolve(tenant, ref, id, c.provider); return {...await this.probe(c.provider, c.config, settings), id: c.id, revision: c.revision}; }
    catch { return {...this.probeFailed(), id: c.id, revision: c.revision}; }
  }
  /** Tests unsaved form values in memory only. An optional existing id supplies its unchanged secret. */
  async testDraft(tenant: string, body: Record<string, unknown>) {
    const {existingId, ...input} = body;
    const clean = validateConnection(input);
    let secret = clean.secret ?? '';
    if (existingId !== undefined) {
      const id = connectionId(existingId);
      const c = await this.store.getConnection(tenant, id, currentBranch());
      if (!c || c.provider !== clean.provider) throw new NotFoundException('connection missing or wrong provider');
      if (!secret) { try { secret = (await this.resolve(tenant, currentBranch(), id, clean.provider)).secret; } catch { return this.probeFailed(); } }
    }
    if (clean.provider !== 'http' && !secret) return this.probeFailed();
    // Raw form secrets never enter Dolt, OpenBao, response bodies or error strings.
    const settings = this.settings(clean.provider, clean.config, secret);
    return this.probe(clean.provider, clean.config, settings);
  }
  private settings(provider: ConnectionProvider, config: Record<string,string>, secret: string): Record<string, unknown> {
    return provider === 'jira' ? {jiraInstanceUrl: config.instanceUrl, jiraEmail: config.email, jiraApiToken: secret} : provider === 'google-sheets' ? {googleServiceAccount: secret, googleUserEmail: config.userEmail} : {httpAllowlist: new URL(config.baseUrl).hostname, httpConnectionBase: config.baseUrl, httpConnectionToken: secret};
  }
  private probeFailed() { return {status: 'Failed', checkedAt: new Date().toISOString(), readOnly: true, message: 'Read-only check failed. Check connection configuration and service access.'}; }
  protected async httpProbe(url: string, options: unknown) {
    const transport = loadPluginModule('workflow-connectors', 'http-transport.mjs') as {safeHttp: (url: string, opts: unknown) => Promise<{status:number}>};
    return transport.safeHttp(url, options);
  }
  private async probe(provider: ConnectionProvider, config: Record<string,string>, settings: Record<string,unknown>) {
    try {
      if (provider === 'google-sheets') {
        if (!config.spreadsheetId || !/^[A-Za-z0-9_-]{10,200}$/.test(config.spreadsheetId)) throw new Error('missing spreadsheet');
        const adapter = loadPluginModule('workflow-connectors', 'adapter.mjs') as {runPieceAction: (pkg: string, action: string, values: unknown) => Promise<unknown>};
        await adapter.runPieceAction('@activepieces/piece-google-sheets', 'get-many-rows', {auth: {props: {serviceAccount: settings.googleServiceAccount, userEmail: settings.googleUserEmail || undefined}}, propsValue: {spreadsheetId: config.spreadsheetId, sheetId: Number(config.sheetId || 0), includeTeamDrives: false, first_row_headers: true}});
      } else {
        const headers: Record<string,string> = provider === 'jira' ? {Authorization: 'Basic ' + Buffer.from(`${settings.jiraEmail}:${settings.jiraApiToken}`).toString('base64')} : settings.httpConnectionToken ? {Authorization: `Bearer ${settings.httpConnectionToken}`} : {};
        const result = await this.httpProbe(provider === 'jira' ? new URL('/rest/api/3/myself', config.instanceUrl).toString() : config.baseUrl, {method: provider === 'jira' ? 'GET' : 'HEAD', headers});
        if (result.status < 200 || result.status >= 300) throw new Error('probe unsuccessful');
      }
      return {status: 'Verified', checkedAt: new Date().toISOString(), readOnly: true};
    } catch { return this.probeFailed(); }
  }
  async resolve(tenant: string, ref: string, id: string, provider: ConnectionProvider) {
    const c = await this.store.getConnection(tenant, connectionId(id), ref);
    if (!c || c.tenant !== tenant || c.id !== id || c.provider !== provider) throw new NotFoundException('connection missing or wrong provider');
    let secret = '';
    if (c.secretRef) {
      if (!new RegExp(`^iam/workflow-connections/${tenantId(tenant)}/${connectionId(c.id)}/[a-f0-9-]{36}$`).test(c.secretRef)) throw new ConflictException('invalid scoped secret reference');
      try { secret = (await this.secrets.get(c.secretRef))?.value ?? ''; } catch { throw new ServiceUnavailableException('connection secret unavailable'); }
    }
    if (provider !== 'http' && !secret) throw new ServiceUnavailableException('connection secret not configured');
    // Revalidate persisted config and credentials too: versioned metadata is not trusted input.
    validateConnection({name: c.name, provider, config: c.config, ...(secret ? {secret} : {})});
    const settings = this.settings(provider, c.config, secret);
    return { settings, secret, connection: c };
  }
}
