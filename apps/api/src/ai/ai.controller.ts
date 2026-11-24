import { BadRequestException, Body, ConflictException, Controller, Delete, Get, GoneException, NotFoundException, Param, Post, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { McpSessionService } from '../mcp/session.service.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { workspaceMode } from '../workspace/context.js';
import { AiStoreService, Conversation, StoredMessage, providers } from './ai-store.service.js';

interface ChatModule {
  openMcp: (a: { url: string; token: string }) => Promise<{ client: { close: () => Promise<void> }; tools: Record<string, unknown> }>;
  startTurn: (a: { languageModel: unknown; opened: unknown; messages: StoredMessage[]; maxTokens: number; abortSignal?: AbortSignal }) => Promise<unknown>;
  pipeTurn: (a: { result: unknown; response: Response; tools: unknown; originalMessages: StoredMessage[]; onFinish: (e: { messages: StoredMessage[] }) => void | Promise<void> }) => Promise<void>;
  ping: (a: { languageModel: unknown; abortSignal?: AbortSignal }) => Promise<string>;
}
const chat = loadPluginModule('ai-assistant', 'chat.mjs') as ChatModule;
const PLUGIN = 'ai-assistant';
const SESSION_TTL_SECONDS = 8 * 3600;
const MAX_USER_CHARS = 8000;
// The per-turn step limit (8) resets with every user message: this caps a whole conversation.
const MAX_CONVERSATION_TOOL_CALLS = 80;
const MAX_CONVERSATION_MESSAGES = 400;

type Part = Record<string, unknown>;
const isTool = (p: Part) => typeof p.type === 'string' && (p.type === 'dynamic-tool' || p.type.startsWith('tool-'));
const toolCount = (ms: StoredMessage[]) => ms.reduce((n, m) => n + m.parts.filter(isTool).length, 0);

/** The MCP endpoint the assistant calls is OUR OWN, addressed from configuration, never from a request header. */
const mcpUrl = (tenant: string) => `${(process.env.IAM_API_INTERNAL_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`).replace(/\/+$/, '')}/tenants/${encodeURIComponent(tenant)}/mcp`;

/**
 * AI assistant: the AI SDK chat on top of the EXISTING MCP server. Each conversation owns an ordinary MCP session (its own
 * Dolt branch, Cedar per call, activity trace) and the SDK talks to the normal MCP endpoint with that session's token.
 * No second rights, validation or approval layer: the only gate here is the plugin screen right; the MCP gateway decides, refuses and validates.
 */
@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant/ai')
export class AiController {
  private busy = new Set<string>();
  constructor(private readonly store: AiStoreService, private readonly sessions: McpSessionService, private readonly v: VersioningService, private readonly branches: BranchRegistries) {}

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
      const text = await chat.ping({ languageModel: providers.createLanguageModel({ model, apiKey }), abortSignal: AbortSignal.timeout(30_000) });
      const status = `reachable (${(text ?? '').slice(0, 40).replace(/\s+/g, ' ') || 'empty reply'})`;
      await this.store.recordCheck(tenant, id, status);
      return { ok: true, status };
    } catch (e) {
      const status = `failed: ${providers.redactMessage(e, apiKey)}`.slice(0, 120);
      await this.store.recordCheck(tenant, id, status);
      return { ok: false, status };
    }
  }

  @Get('conversations') async conversations(@Param('tenant') tenant: string, @Req() req: { user: { sub: string } }) {
    await this.requireEnabled(tenant);
    return { conversations: await this.store.listConversations(tenant, req.user.sub) };
  }

  @Post('conversations') async create(@Param('tenant') tenant: string, @Body() b: { modelId?: string; title?: string }, @Req() req: { user: { sub: string } }) {
    await this.requireEnabled(tenant);
    if (typeof b?.modelId !== 'string') throw new BadRequestException('modelId required');
    const { model } = await this.store.resolveModel(tenant, b.modelId);
    if (!model.enabled) throw new ConflictException('this model is disabled');
    const title = (typeof b.title === 'string' && b.title.trim() ? b.title.trim() : 'New conversation').replace(/[\r\n]+/g, ' ').slice(0, 100);
    // The conversation's identity: an ordinary MCP session of the signed-in administrator, with its own branch cut from main.
    const { secret, session } = await this.sessions.create(tenant, req.user.sub, `AI chat: ${title}`, SESSION_TTL_SECONDS);
    const conv = await this.store.createConversation(tenant, req.user.sub, model.id, session.id, secret, title);
    return { conversation: conv, branch: session.branch, expiresAt: session.expiresAt };
  }

  @Get('conversations/:id') async one(@Param('tenant') tenant: string, @Param('id') id: string, @Req() req: { user: { sub: string } }) {
    await this.requireEnabled(tenant);
    const conv = await this.mine(tenant, id, req);
    const messages = await this.store.messages(id);
    const session = (await this.sessions.list(tenant)).find((s) => s.id === conv.sessionId);
    return { conversation: conv, branch: session?.branch ?? null, sessionActive: !!session && !session.revoked && session.expiresMs > Date.now(), messages };
  }

  @Delete('conversations/:id') async remove(@Param('tenant') tenant: string, @Param('id') id: string, @Req() req: { user: { sub: string } }) {
    await this.requireEnabled(tenant);
    const conv = await this.mine(tenant, id, req);
    try { await this.sessions.revoke(tenant, conv.sessionId); } catch { /* already gone */ }
    await this.store.deleteConversation(id);
    return { deleted: true };
  }

  private async mine(tenant: string, id: string, req: { user: { sub: string } }): Promise<Conversation> {
    const conv = await this.store.getConversation(tenant, req.user.sub, id);
    if (!conv) throw new NotFoundException(`conversation ${id} not found`);
    return conv;
  }

  /**
   * One chat turn, streamed in the AI SDK UI message format. The client sends ONLY its last message, a user message (text
   * only). The history is the server's own stored copy: a client-sent assistant or tool message is refused.
   */
  @Post('conversations/:id/chat') async chatTurn(@Param('tenant') tenant: string, @Param('id') id: string, @Body() b: { message?: { role?: string; parts?: Part[] } }, @Req() req: { user: { sub: string } }, @Res() res: Response) {
    await this.requireEnabled(tenant);
    const conv = await this.mine(tenant, id, req);
    const msg = b?.message;
    if (!msg || msg.role !== 'user' || !Array.isArray(msg.parts)) throw new BadRequestException('message required');
    if (this.busy.has(conv.id)) throw new ConflictException('this conversation is already working on a message');
    this.busy.add(conv.id);
    let opened: Awaited<ReturnType<ChatModule['openMcp']>> | undefined;
    try {
      const { model, apiKey } = await this.store.resolveModel(tenant, conv.modelId);
      if (!model.enabled) throw new ConflictException('this model is disabled');
      const session = (await this.sessions.list(tenant)).find((s) => s.id === conv.sessionId);
      if (!session || session.revoked || session.expiresMs <= Date.now()) throw new GoneException('the conversation session ended (it lasts 8 hours): start a new conversation');
      if (session.owner !== conv.owner) throw new NotFoundException('conversation not found');
      const history = await this.store.messages(conv.id);
      if (history.length >= MAX_CONVERSATION_MESSAGES || toolCount(history) >= MAX_CONVERSATION_TOOL_CALLS) throw new ConflictException('this conversation reached its size limit: start a new conversation');
      const text = msg.parts.filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => String(p.text)).join('\n').trim();
      if (!text) throw new BadRequestException('text required');
      if (text.length > MAX_USER_CHARS) throw new BadRequestException(`content too long (max ${MAX_USER_CHARS} characters)`);
      const messages: StoredMessage[] = [...history, { id: `m-${randomBytes(6).toString('hex')}`, role: 'user', parts: [{ type: 'text', text }] }];
      // The new user message is stored before the model runs: a dropped connection never loses what the person wrote.
      await this.store.replaceMessages(conv.id, messages);
      opened = await chat.openMcp({ url: mcpUrl(tenant), token: await this.store.mcpSecret(conv.id) });
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); });
      const result = await chat.startTurn({ languageModel: providers.createLanguageModel({ model, apiKey }), opened, messages, maxTokens: model.maxTokens, abortSignal: ac.signal });
      // pipeTurn resolves when the whole stream has been written (SDK contract: writeToServerResponse returns its read loop), and
      // the busy lock + MCP client are released in `finally` only after that AND after the turn was stored.
      let saving: Promise<void> | undefined;
      await chat.pipeTurn({ result, response: res, tools: opened.tools, originalMessages: messages, onFinish: (e) => { saving = this.store.replaceMessages(conv.id, e.messages); return saving; } });
      await saving;
    } finally {
      this.busy.delete(conv.id);
      try { await opened?.client.close(); } catch { /* closed */ }
    }
  }
}
