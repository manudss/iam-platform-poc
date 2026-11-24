import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, GoneException, HttpException, NotFoundException, Param, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { PullRequestService } from '../versioning/pull-requests.service.js';
import { UsersService } from '../users/users.service.js';
import { AuditService } from '../access/audit.service.js';
import { McpSessionService, McpSession } from '../mcp/session.service.js';
import { McpUpstreamService } from '../mcp/upstream.service.js';
import { McpGrantsService } from '../mcp/grants.service.js';
import { bindGateway, McpToolsModule, TOOL_KINDS } from '../mcp/tools.js';
import { registerProxyTools } from '../mcp/proxy.js';
import { PluginError } from '../plugins/v1/registry.js';
import { resolveEngine } from '../plugins/v1/engines.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { ProfileService } from '../profile/profile.service.js';
import { OrgService } from '../profile/orgs.js';
import { RolesService } from '../profile/roles.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { AuthnService } from '../authn/flow.service.js';
import { workspaceMode } from '../workspace/context.js';
import { AiStoreService, ChatMessage, Conversation, providers } from './ai-store.service.js';

interface AgentModule {
  SYSTEM_PROMPT: string;
  runAgent: (a: { messages: ChatMessage[]; decisions?: Record<string, string>; host: AgentHost }) => Promise<{ status: 'done' | 'needs_confirmation' | 'limit'; added: ChatMessage[]; pending: NonNullable<ChatMessage['toolCalls']>; trace: { tool: string; id: string; ms: number; outcome: string; kind?: string }[] }>;
  pendingCalls: (m: ChatMessage[]) => NonNullable<ChatMessage['toolCalls']>;
}
interface AgentHost {
  tools: { name: string; description?: string; inputSchema?: unknown }[];
  kindOf: (name: string) => 'read' | 'write' | 'lifecycle' | 'proxy';
  autoApproveWrites: boolean;
  callModel: (m: ChatMessage[]) => Promise<{ text: string; toolCalls?: ChatMessage['toolCalls']; usage?: unknown }>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}
const agent = loadPluginModule('ai-assistant', 'agent.mjs') as AgentModule;
const PLUGIN = 'ai-assistant';
const SESSION_TTL_SECONDS = 8 * 3600;
const MAX_USER_CHARS = 8000;

/** What the console shows of a stored message: tool output is cut, the usage block is dropped. */
export function view(m: ChatMessage) {
  return { role: m.role, content: m.role === 'tool' ? m.content.slice(0, 4000) : m.content, ...(m.toolCalls ? { toolCalls: m.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })) } : {}), ...(m.name ? { toolName: m.name } : {}), ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}) };
}

/**
 * AI assistant: chat with a model that can use the MCP tool surface. The assistant is NOT a new kind of access:
 * each conversation owns an ordinary MCP session (one Dolt branch cut from main, tools decided by the Cedar
 * policy engine, every call traced) and the tools run in-process through the same MCP server the external
 * clients use. Changes need the administrator's confirmation, and publishing stays human (no tool can merge).
 */
@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant/ai')
export class AiController {
  private busy = new Set<string>();
  constructor(
    private readonly store: AiStoreService, private readonly sessions: McpSessionService,
    private readonly v: VersioningService, private readonly prs: PullRequestService, private readonly users: UsersService, private readonly audit: AuditService,
    private readonly profile: ProfileService, private readonly orgs: OrgService, private readonly roles: RolesService,
    private readonly wf: WorkflowsService, private readonly branches: BranchRegistries, private readonly authn: AuthnService,
    private readonly upstreams: McpUpstreamService, private readonly grants: McpGrantsService,
  ) {}
  private get core() { return process.env.IAM_CORE_URL ?? 'http://127.0.0.1:8081'; }

  private async requireEnabled(tenant: string) {
    if (!workspaceMode()) throw new ServiceUnavailableException('workspace mode is disabled: branch confinement is not available');
    const reg = await this.branches.get(this.v.defaultBranch);
    if (!reg.isActive(tenant, PLUGIN)) throw new ServiceUnavailableException('the AI assistant plugin is not enabled: an administrator enables it in Plugins');
  }

  @Get('models') async models(@Param('tenant') tenant: string) {
    await this.requireEnabled(tenant);
    return { models: await this.store.listModels(tenant) };
  }

  @Post('models') async addModel(@Param('tenant') tenant: string, @Body() b: unknown, @Req() req: { user: { sub: string } }) {
    await this.requireEnabled(tenant);
    const model = await this.store.createModel(tenant, req.user.sub, b);
    return { ...model, note: 'The API key is stored encrypted and is never shown again.' };
  }

  @Post('models/:id/enabled') async enable(@Param('tenant') tenant: string, @Param('id') id: string, @Body() b: { enabled?: boolean }) {
    await this.requireEnabled(tenant);
    return this.store.setModelEnabled(tenant, id, b?.enabled === true);
  }

  @Delete('models/:id') async removeModel(@Param('tenant') tenant: string, @Param('id') id: string) {
    await this.requireEnabled(tenant);
    return this.store.removeModel(tenant, id);
  }

  /** One minimal call, no tool: proves the endpoint, the key and the model name. The result is a short status, never the key. */
  @Post('models/:id/test') async test(@Param('tenant') tenant: string, @Param('id') id: string) {
    await this.requireEnabled(tenant);
    const { model, apiKey } = await this.store.resolveModel(tenant, id);
    try {
      const out = await providers.callModel({ model, apiKey, system: 'Answer with the single word: ok', messages: [{ role: 'user', content: 'ping' }], tools: [], timeoutMs: 30_000 });
      const status = `reachable (${(out.text ?? '').slice(0, 40).replace(/\s+/g, ' ') || 'empty reply'})`;
      await this.store.recordCheck(tenant, id, status);
      return { ok: true, status };
    } catch (e) {
      const status = `failed: ${(e as Error).message}`.slice(0, 120);
      await this.store.recordCheck(tenant, id, status);
      return { ok: false, status };
    }
  }

  @Get('conversations') async conversations(@Param('tenant') tenant: string, @Req() req: { user: { sub: string } }) {
    await this.requireEnabled(tenant);
    return { conversations: await this.store.listConversations(tenant, req.user.sub) };
  }

  @Post('conversations') async create(@Param('tenant') tenant: string, @Body() b: { modelId?: string; title?: string; autoApproveWrites?: boolean }, @Req() req: { user: { sub: string } }) {
    await this.requireEnabled(tenant);
    if (typeof b?.modelId !== 'string') throw new BadRequestException('modelId required');
    const { model } = await this.store.resolveModel(tenant, b.modelId);
    if (!model.enabled) throw new ConflictException('this model is disabled');
    const title = (typeof b.title === 'string' && b.title.trim() ? b.title.trim() : 'New conversation').replace(/[\r\n]+/g, ' ').slice(0, 100);
    // The conversation's identity: an ordinary MCP session of the signed-in administrator, with its own branch cut from main.
    const { session } = await this.sessions.create(tenant, req.user.sub, `AI chat: ${title}`, SESSION_TTL_SECONDS);
    const conv = await this.store.createConversation(tenant, req.user.sub, model.id, session.id, title, b.autoApproveWrites === true);
    return { conversation: conv, branch: session.branch, expiresAt: session.expiresAt };
  }

  @Get('conversations/:id') async one(@Param('tenant') tenant: string, @Param('id') id: string, @Req() req: { user: { sub: string } }) {
    await this.requireEnabled(tenant);
    const conv = await this.mine(tenant, id, req);
    const messages = await this.store.messages(id);
    const session = (await this.sessions.list(tenant)).find((s) => s.id === conv.sessionId);
    return { conversation: conv, branch: session?.branch ?? null, sessionActive: !!session && !session.revoked && session.expiresMs > Date.now(), messages: messages.map(view), pending: agent.pendingCalls(messages).map((c) => ({ id: c.id, name: c.name, args: c.args, kind: this.kindOf(c.name) })) };
  }

  @Delete('conversations/:id') async remove(@Param('tenant') tenant: string, @Param('id') id: string, @Req() req: { user: { sub: string } }) {
    await this.requireEnabled(tenant);
    const conv = await this.mine(tenant, id, req);
    try { await this.sessions.revoke(tenant, conv.sessionId); } catch { /* already gone */ }
    await this.store.deleteConversation(id);
    return { deleted: true };
  }

  @Post('conversations/:id/messages') async send(@Param('tenant') tenant: string, @Param('id') id: string, @Body() b: { content?: string }, @Req() req: { user: { sub: string } }) {
    await this.requireEnabled(tenant);
    const conv = await this.mine(tenant, id, req);
    if (typeof b?.content !== 'string' || !b.content.trim()) throw new BadRequestException('content required');
    if (b.content.length > MAX_USER_CHARS) throw new BadRequestException(`content too long (max ${MAX_USER_CHARS} characters)`);
    return this.turn(tenant, conv, { user: { role: 'user', content: b.content.trim() }, decisions: {} });
  }

  /** The administrator's answer to the paused changes: { decisions: { <toolCallId>: 'approve' | 'deny' } }. */
  @Post('conversations/:id/decisions') async decide(@Param('tenant') tenant: string, @Param('id') id: string, @Body() b: { decisions?: Record<string, string> }, @Req() req: { user: { sub: string } }) {
    await this.requireEnabled(tenant);
    const conv = await this.mine(tenant, id, req);
    const pending = agent.pendingCalls(await this.store.messages(id));
    if (!pending.length) throw new ConflictException('nothing is waiting for a decision');
    const d: Record<string, string> = {};
    for (const c of pending) {
      const v = b?.decisions?.[c.id];
      if (v !== 'approve' && v !== 'deny') throw new BadRequestException(`a decision (approve or deny) is required for ${c.id}`);
      d[c.id] = v;
    }
    return this.turn(tenant, conv, { decisions: d });
  }

  private kindOf(name: string): 'read' | 'write' | 'lifecycle' | 'proxy' {
    const k = (TOOL_KINDS as Record<string, string>)[name];
    if (k === 'read' || k === 'write' || k === 'lifecycle' || k === 'proxy') return k;
    return name.includes('__') ? 'proxy' : 'lifecycle'; // unknown tool: the strictest confirmed class
  }

  private async mine(tenant: string, id: string, req: { user: { sub: string } }): Promise<Conversation> {
    const conv = await this.store.getConversation(tenant, req.user.sub, id);
    if (!conv) throw new NotFoundException(`conversation ${id} not found`);
    return conv;
  }

  private async openTools(tenant: string, session: McpSession) {
    let gw: { registerTools: McpToolsModule['registerTools']; registerProxyTools: typeof registerProxyTools };
    try {
      gw = await resolveEngine(() => this.branches.get(session.branch), tenant, 'mcp.gateway', 'tools.mjs', (mod: McpToolsModule, impl) => {
        bindGateway(mod);
        return { registerTools: mod.registerTools, registerProxyTools: (loadPluginModule(impl.manifest.id, 'proxy.mjs') as { registerProxyTools: typeof registerProxyTools }).registerProxyTools };
      });
    } catch (e) {
      if (e instanceof PluginError) throw new HttpException({ error: e.code, message: e.message }, e.code === 'no-provider' ? 503 : 500);
      throw e;
    }
    const server = new McpServer({ name: 'iam-platform-poc', version: '0.1.0' });
    const ctx = { session, tenant, v: this.v, prs: this.prs, users: this.users, sessions: this.sessions, audit: this.audit, core: this.core, profile: this.profile, orgs: this.orgs, roles: this.roles, wf: this.wf, branches: this.branches, authn: this.authn };
    gw.registerTools(server, ctx);
    await gw.registerProxyTools(server, ctx, this.upstreams, this.grants);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'ai-assistant', version: '1.0.0' });
    await server.connect(a);
    await client.connect(b);
    const listed = await client.listTools();
    return { client, tools: listed.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), close: async () => { await client.close(); await server.close(); } };
  }

  private async turn(tenant: string, conv: Conversation, input: { user?: ChatMessage; decisions: Record<string, string> }) {
    if (this.busy.has(conv.id)) throw new ConflictException('this conversation is already working on a message');
    this.busy.add(conv.id);
    try {
      const { model, apiKey } = await this.store.resolveModel(tenant, conv.modelId);
      if (!model.enabled) throw new ConflictException('this model is disabled');
      const session = (await this.sessions.list(tenant)).find((s) => s.id === conv.sessionId);
      if (!session || session.revoked || session.expiresMs <= Date.now()) throw new GoneException('the conversation session ended (it lasts 8 hours): start a new conversation');
      if (session.owner !== conv.owner) throw new ForbiddenException('session owner mismatch');
      const history = await this.store.messages(conv.id);
      // A new user message while changes still wait for a decision is refused: the pending calls must be answered first.
      if (input.user && agent.pendingCalls(history).length) throw new ConflictException('changes are waiting for your decision: approve or decline them first');
      if (input.user) await this.store.append(conv.id, [input.user]);
      const messages = input.user ? [...history, input.user] : history;
      const opened = await this.openTools(tenant, session);
      try {
        const host: AgentHost = {
          tools: opened.tools, kindOf: (n) => this.kindOf(n), autoApproveWrites: conv.autoApproveWrites,
          callModel: (m) => providers.callModel({ model, apiKey, system: agent.SYSTEM_PROMPT, messages: m, tools: opened.tools }),
          callTool: async (name, args) => {
            const r = await opened.client.callTool({ name, arguments: args }) as { isError?: boolean; content?: { type: string; text?: string }[] };
            const text = (r.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`)).join('\n');
            if (r.isError) throw new Error(text || 'the tool refused the call');
            return text;
          },
        };
        let out;
        try { out = await agent.runAgent({ messages, host, decisions: input.decisions }); }
        catch (e) {
          const note: ChatMessage = { role: 'assistant', content: `The model could not answer: ${(e as Error).message}` };
          await this.store.append(conv.id, [note]);
          return { status: 'error', error: (e as Error).message, messages: [view(note)], pending: [], trace: [] };
        }
        await this.store.append(conv.id, out.added);
        const session2 = (await this.sessions.list(tenant)).find((s) => s.id === conv.sessionId);
        return { status: out.status, messages: out.added.map(view), pending: out.pending.map((c) => ({ id: c.id, name: c.name, args: c.args, kind: this.kindOf(c.name) })), trace: out.trace, branch: session2?.branch ?? session.branch };
      } finally { await opened.close(); }
    } finally { this.busy.delete(conv.id); }
  }
}
