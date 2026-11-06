import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Query, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { PullRequestService } from '../versioning/pull-requests.service.js';
import { UsersService } from '../users/users.service.js';
import { AuditService } from '../access/audit.service.js';
import { McpSessionService } from './session.service.js';
import { McpUpstreamService } from './upstream.service.js';
import { McpGrantsService } from './grants.service.js';
import { registerTools } from './tools.js';
import { registerProxyTools } from './proxy.js';
import { ProfileService } from '../profile/profile.service.js';
import { OrgService } from '../profile/orgs.js';
import { RolesService } from '../profile/roles.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { AuthnService } from '../authn/flow.service.js';
import { workspaceMode } from '../workspace/context.js';

/**
 * MCP endpoint (Model Context Protocol, streamable HTTP transport, spec revision 2025-11-25).
 * AUTH MODEL - stated honestly: this is NOT a full OAuth authorization server. Sessions are pre-registered
 * bearer credentials created by an administrator in the console (the "pre-registered client credentials"
 * approach allowed by the MCP authorization spec). The endpoint answers 401 with a WWW-Authenticate header
 * pointing at RFC 9728 protected-resource metadata for discovery. MCP secrets are opaque random strings,
 * not IdP tokens: they open ONLY this route, and every other route of the platform keeps requiring the IdP.
 */
@Controller()
export class McpController {
  constructor(
    private readonly sessions: McpSessionService, private readonly v: VersioningService,
    private readonly prs: PullRequestService, private readonly users: UsersService, private readonly audit: AuditService,
    private readonly profile: ProfileService, private readonly orgs: OrgService, private readonly roles: RolesService,
    private readonly wf: WorkflowsService, private readonly branches: BranchRegistries, private readonly authn: AuthnService,
    private readonly upstreams: McpUpstreamService, private readonly grants: McpGrantsService,
  ) {}
  private get core() { return process.env.IAM_CORE_URL ?? 'http://127.0.0.1:8081'; }

  private resourceUrl(req: Request, tenant: string) {
    const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol ?? 'http';
    return `${proto}://${req.headers.host}/tenants/${tenant}/mcp`;
  }
  private metadataUrl(req: Request, tenant: string) {
    const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol ?? 'http';
    return `${proto}://${req.headers.host}/.well-known/oauth-protected-resource/tenants/${tenant}/mcp`;
  }
  private challenge(res: Response, req: Request, tenant: string) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${this.metadataUrl(req, tenant)}"`);
    res.status(401).json({ error: 'unauthorized', hint: 'an MCP session bearer token is required; administrators create sessions in the console' });
  }

  /** RFC 9728 protected resource metadata (path-inserted form for the tenant-scoped MCP endpoint). */
  @Get('.well-known/oauth-protected-resource/tenants/:tenant/mcp')
  metadata(@Param('tenant') tenant: string, @Req() req: Request) {
    return { resource: this.resourceUrl(req, tenant), authorization_servers: [process.env.IAM_ISSUER ?? this.core], bearer_methods_supported: ['header'], resource_name: 'IAM POC MCP server (branch-confined AI access)' };
  }

  @Post('tenants/:tenant/mcp')
  async handle(@Param('tenant') tenant: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    // Spec: refuse cross-origin browser posts (403). Non-browser MCP clients send no Origin header.
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* invalid origin */ }
      const own = String(req.headers.host ?? '');
      if (!host || (host !== own && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))) { res.status(403).json({ error: 'invalid origin' }); return; }
    }
    if (!workspaceMode()) { res.status(503).json({ error: 'workspace mode is disabled: MCP branch confinement is not available' }); return; }
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) { this.challenge(res, req, tenant); return; }
    const session = await this.sessions.authenticate(tenant, h.slice(7).trim());
    if (!session) { this.challenge(res, req, tenant); return; }

    // Stateless streamable HTTP: one server + transport per request, JSON responses, no SSE session state.
    const server = new McpServer({ name: 'iam-platform-poc', version: '0.1.0' });
    registerTools(server, { session, tenant, v: this.v, prs: this.prs, users: this.users, sessions: this.sessions, audit: this.audit, core: this.core, profile: this.profile, orgs: this.orgs, roles: this.roles, wf: this.wf, branches: this.branches, authn: this.authn });
    await registerProxyTools(server, { session, tenant, v: this.v, prs: this.prs, users: this.users, sessions: this.sessions, audit: this.audit, core: this.core, profile: this.profile, orgs: this.orgs, roles: this.roles, wf: this.wf, branches: this.branches, authn: this.authn }, this.upstreams, this.grants);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
}

/** Console administration of MCP sessions: create (secret shown once), list, revoke, read the activity trace. */
@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant/mcp-sessions')
export class McpSessionsController {
  constructor(private readonly sessions: McpSessionService) {}

  @Post()
  async create(@Param('tenant') tenant: string, @Body() b: { label?: string; ttl_seconds?: number }, @Req() req: { user: { sub: string } }) {
    if (!workspaceMode()) throw new BadRequestException('workspace mode is disabled');
    const { secret, session } = await this.sessions.create(tenant, req.user.sub, b?.label, b?.ttl_seconds);
    return { ...session, secret, note: 'Store this secret now: it is never stored in clear and never shown again.' };
  }

  @Get() list(@Param('tenant') tenant: string) { return this.sessions.list(tenant).then((sessions) => ({ sessions })); }

  @Delete(':id') revoke(@Param('tenant') tenant: string, @Param('id') id: string) { return this.sessions.revoke(tenant, id); }

  @Get(':id/activity') activity(@Param('tenant') tenant: string, @Param('id') id: string, @Query('limit') limit?: string) {
    return this.sessions.activity(tenant, id, limit ? Number(limit) : 200).then((entries) => ({ entries }));
  }

  @Get(':id') async one(@Param('tenant') tenant: string, @Param('id') id: string) {
    const s = (await this.sessions.list(tenant)).find((x) => x.id === id);
    if (!s) throw new NotFoundException(`session ${id} not found`);
    return s;
  }
}

/**
 * Console administration of external MCP servers relayed by the platform ("MCP gateway", P1).
 * The upstream token is write-only: it is stored encrypted, never returned, never logged. The AI agent
 * authenticates to the platform with its own session secret and never sees this token (no passthrough).
 */
@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant/mcp-upstreams')
export class McpUpstreamsController {
  constructor(private readonly upstreams: McpUpstreamService) {}

  @Post()
  async create(@Param('tenant') tenant: string, @Body() b: { name?: string; url?: string; token?: string; enabled?: boolean; authType?: string; authUser?: string }, @Req() req: { user: { sub: string } }) {
    if (!workspaceMode()) throw new BadRequestException('workspace mode is disabled');
    const up = await this.upstreams.create(tenant, req.user.sub, b ?? {});
    return { ...up, note: 'The upstream token is stored encrypted and is never shown again. Relayed tools appear as <name>__<tool> in MCP sessions.' };
  }

  @Get() list(@Param('tenant') tenant: string) { return this.upstreams.list(tenant).then((upstreams) => ({ upstreams })); }

  @Delete(':id') remove(@Param('tenant') tenant: string, @Param('id') id: string) { return this.upstreams.remove(tenant, id); }

  @Post(':id/test') test(@Param('tenant') tenant: string, @Param('id') id: string) { return this.upstreams.test(tenant, id); }
}

/**
 * Delegation grants (MCP gateway P2), read-only for the console: the EFFECTIVE grants of the active version.
 * Grants are versioned data: creating or revoking one is an ordinary data change on a working branch,
 * merged by a human and activated - there is intentionally no direct-write admin route here.
 */
@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant/mcp-grants')
export class McpGrantsController {
  constructor(private readonly grants: McpGrantsService) {}

  @Get() async list(@Param('tenant') tenant: string) {
    const { commit, grants } = await this.grants.atActiveCommit(tenant);
    return { activeCommit: commit, grants };
  }
}
