import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { createConnection, Connection } from 'mysql2/promise';
import { VersioningService } from '../versioning/versioning.service.js';
import { loadPluginModule } from '../plugins/v1/loader.js';

export type ModelKind = 'openai-compatible' | 'anthropic';
export interface AiModel {
  id: string; name: string; kind: ModelKind; model: string; baseUrl: string; local: boolean; builtin: boolean; enabled: boolean;
  maxTokens: number; hasKey: boolean; createdAt: string; lastStatus: string; lastCheck: string | null;
}
export interface Conversation { id: string; tenant: string; owner: string; modelId: string; sessionId: string; title: string; autoApproveWrites: boolean; createdAt: string; updatedAt: string }
/** The internal message shape of the ai-assistant plugin (see providers.mjs). */
export interface ChatMessage { role: 'user' | 'assistant' | 'tool'; content: string; toolCalls?: { id: string; name: string; args: Record<string, unknown>; badArgs?: boolean }[]; toolCallId?: string; name?: string; usage?: unknown }

interface ProvidersModule {
  validateModelInput: (b: unknown) => { name: string; kind: ModelKind; model: string; baseUrl: string; local: boolean; apiKey: string | null; maxTokens: number; enabled: boolean };
  validateModelUrl: (raw: unknown) => { url: string; local: boolean };
  sealKey: (k: string) => string; openKey: (s: string) => string;
  MODEL_ID: RegExp; LOCAL_MODEL_ID: string;
}
export const providers = loadPluginModule('ai-assistant', 'providers.mjs') as ProvidersModule & {
  callModel: (a: { model: { kind: ModelKind; baseUrl: string; model: string; maxTokens: number }; apiKey: string | null; system: string; messages: ChatMessage[]; tools: { name: string; description?: string; inputSchema?: unknown }[]; fetchImpl?: typeof fetch; timeoutMs?: number }) => Promise<{ text: string; toolCalls: ChatMessage['toolCalls']; usage: unknown }>;
  ModelCallError: new (m: string, s?: number) => Error;
};

type Row = Record<string, unknown>;
const CONV_ID = /^cv-[0-9a-f]{12}$/;

/** The built-in local model: configured by the deployment (IAM_AI_LOCAL_URL + IAM_AI_LOCAL_MODEL), never stored. */
export function localModel(): (AiModel & { apiKey: null }) | null {
  const url = process.env.IAM_AI_LOCAL_URL, model = process.env.IAM_AI_LOCAL_MODEL;
  if (!url || !model) return null;
  const v = providers.validateModelUrl(url);
  if (!v.local) return null; // the built-in entry is local by definition: a remote URL here is a misconfiguration
  return { id: providers.LOCAL_MODEL_ID, name: `Local model (${model})`, kind: 'openai-compatible', model, baseUrl: v.url, local: true, builtin: true, enabled: true, maxTokens: Number(process.env.IAM_AI_LOCAL_MAX_TOKENS ?? 2048), hasKey: false, createdAt: '', lastStatus: 'never-checked', lastCheck: null, apiKey: null };
}

/**
 * Storage of the AI assistant in the UNVERSIONED meta database (like MCP sessions and upstreams): the registered
 * models (keys sealed), the conversations and their messages. Conversations belong to the administrator who
 * opened them: nobody else reads them through the API.
 */
@Injectable()
export class AiStoreService {
  private ready?: Promise<void>;
  constructor(private readonly v: VersioningService) {}
  private get metaDb() { return `${this.v.dbName}_meta`.replace(/[^A-Za-z0-9_]/g, ''); }
  private open(): Promise<Connection> {
    return createConnection({ host: process.env.DOLT_HOST ?? '127.0.0.1', port: Number(process.env.DOLT_PORT ?? 3307), user: process.env.DOLT_USER ?? 'root', password: process.env.DOLT_PASSWORD ?? '', database: this.metaDb, connectTimeout: 5000, dateStrings: true });
  }
  private async meta(): Promise<Connection> {
    if (!this.ready) {
      this.ready = (async () => {
        const c = await this.v.connect();
        try { await c.query(`CREATE DATABASE IF NOT EXISTS \`${this.metaDb}\``); } finally { await c.end(); }
        const m = await this.open();
        try {
          await m.query(`CREATE TABLE IF NOT EXISTS ai_models (
            id VARCHAR(40) PRIMARY KEY, tenant VARCHAR(32) NOT NULL, name VARCHAR(40) NOT NULL, kind VARCHAR(24) NOT NULL, model VARCHAR(100) NOT NULL,
            base_url VARCHAR(300) NOT NULL, key_enc TEXT NULL, local_model BOOLEAN NOT NULL DEFAULT FALSE, max_tokens INT NOT NULL DEFAULT 2048,
            enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at DATETIME(3) NOT NULL, created_by VARCHAR(64) NOT NULL,
            last_status VARCHAR(120) NOT NULL DEFAULT 'never-checked', last_check DATETIME(3) NULL, UNIQUE KEY uq_ai_model_name (tenant, name))`);
          await m.query(`CREATE TABLE IF NOT EXISTS ai_conversations (
            id VARCHAR(40) PRIMARY KEY, tenant VARCHAR(32) NOT NULL, owner_sub VARCHAR(64) NOT NULL, model_id VARCHAR(40) NOT NULL, session_id VARCHAR(40) NOT NULL,
            title VARCHAR(120) NOT NULL, auto_approve_writes BOOLEAN NOT NULL DEFAULT FALSE, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL)`);
          await m.query(`CREATE TABLE IF NOT EXISTS ai_messages (
            id BIGINT AUTO_INCREMENT PRIMARY KEY, conversation_id VARCHAR(40) NOT NULL, at DATETIME(3) NOT NULL DEFAULT NOW(3), payload LONGTEXT NOT NULL, KEY ix_ai_msg_conv (conversation_id, id))`);
        } finally { await m.end(); }
      })().catch((e) => { this.ready = undefined; throw new HttpException(`ai store unavailable: ${(e as Error).message}`, 503); });
    }
    await this.ready;
    return this.open();
  }

  private shapeModel(r: Row): AiModel {
    return { id: String(r.id), name: String(r.name), kind: String(r.kind) as ModelKind, model: String(r.model), baseUrl: String(r.base_url), local: !!r.local_model, builtin: false, enabled: !!r.enabled, maxTokens: Number(r.max_tokens), hasKey: !!r.key_enc, createdAt: String(r.created_at), lastStatus: String(r.last_status), lastCheck: r.last_check == null ? null : String(r.last_check) };
  }

  async listModels(tenant: string): Promise<AiModel[]> {
    const m = await this.meta();
    try {
      const [r] = await m.query('SELECT * FROM ai_models WHERE tenant = ? ORDER BY created_at DESC LIMIT 100', [tenant]);
      const lm = localModel();
      const { apiKey: _k, ...pub } = lm ?? ({} as never);
      void _k;
      return [...(lm ? [pub as AiModel] : []), ...(r as Row[]).map((x) => this.shapeModel(x))];
    } finally { await m.end(); }
  }

  /** The model plus its opened key, for a call. Never returned by a route. */
  async resolveModel(tenant: string, id: string): Promise<{ model: AiModel; apiKey: string | null }> {
    if (id === providers.LOCAL_MODEL_ID) { const l = localModel(); if (!l) throw new NotFoundException('no local model is configured on this server (IAM_AI_LOCAL_URL, IAM_AI_LOCAL_MODEL)'); return { model: l, apiKey: null }; }
    if (!providers.MODEL_ID.test(id)) throw new BadRequestException('invalid model id');
    const m = await this.meta();
    try {
      const [r] = await m.query('SELECT * FROM ai_models WHERE tenant = ? AND id = ?', [tenant, id]);
      const row = (r as Row[])[0];
      if (!row) throw new NotFoundException(`model ${id} not found`);
      return { model: this.shapeModel(row), apiKey: row.key_enc ? providers.openKey(String(row.key_enc)) : null };
    } finally { await m.end(); }
  }

  async createModel(tenant: string, by: string, input: unknown): Promise<AiModel> {
    const v = providers.validateModelInput(input);
    const id = `md-${randomBytes(6).toString('hex')}`;
    const m = await this.meta();
    try {
      const [dup] = await m.query('SELECT 1 FROM ai_models WHERE tenant = ? AND name = ?', [tenant, v.name]);
      if ((dup as Row[]).length) throw new BadRequestException(`a model named "${v.name}" already exists`);
      await m.query('INSERT INTO ai_models (id, tenant, name, kind, model, base_url, key_enc, local_model, max_tokens, enabled, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [id, tenant, v.name, v.kind, v.model, v.baseUrl, v.apiKey ? providers.sealKey(v.apiKey) : null, v.local ? 1 : 0, v.maxTokens, v.enabled ? 1 : 0, new Date().toISOString().slice(0, 23), by.slice(0, 64)]);
    } finally { await m.end(); }
    return (await this.listModels(tenant)).find((x) => x.id === id)!;
  }

  async setModelEnabled(tenant: string, id: string, enabled: boolean): Promise<AiModel> {
    await this.resolveModel(tenant, id);
    if (id === providers.LOCAL_MODEL_ID) throw new BadRequestException('the built-in local model is configured by the deployment');
    const m = await this.meta();
    try { await m.query('UPDATE ai_models SET enabled = ? WHERE tenant = ? AND id = ?', [enabled ? 1 : 0, tenant, id]); } finally { await m.end(); }
    return (await this.listModels(tenant)).find((x) => x.id === id)!;
  }

  async removeModel(tenant: string, id: string): Promise<{ deleted: boolean }> {
    if (id === providers.LOCAL_MODEL_ID) throw new BadRequestException('the built-in local model is configured by the deployment');
    if (!providers.MODEL_ID.test(id)) throw new BadRequestException('invalid model id');
    const m = await this.meta();
    try { const [r] = await m.query('DELETE FROM ai_models WHERE tenant = ? AND id = ?', [tenant, id]); return { deleted: ((r as { affectedRows?: number }).affectedRows ?? 0) > 0 }; } finally { await m.end(); }
  }

  async recordCheck(tenant: string, id: string, status: string): Promise<void> {
    if (id === providers.LOCAL_MODEL_ID) return;
    const m = await this.meta();
    try { await m.query('UPDATE ai_models SET last_status = ?, last_check = ? WHERE tenant = ? AND id = ?', [status.slice(0, 120), new Date().toISOString().slice(0, 23), tenant, id]); } finally { await m.end(); }
  }

  // ---- conversations ----
  private shapeConv(r: Row): Conversation {
    return { id: String(r.id), tenant: String(r.tenant), owner: String(r.owner_sub), modelId: String(r.model_id), sessionId: String(r.session_id), title: String(r.title), autoApproveWrites: !!r.auto_approve_writes, createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
  }
  async createConversation(tenant: string, owner: string, modelId: string, sessionId: string, title: string, autoApproveWrites: boolean): Promise<Conversation> {
    const id = `cv-${randomBytes(6).toString('hex')}`, now = new Date().toISOString().slice(0, 23);
    const m = await this.meta();
    try { await m.query('INSERT INTO ai_conversations (id, tenant, owner_sub, model_id, session_id, title, auto_approve_writes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)', [id, tenant, owner.slice(0, 64), modelId, sessionId, title.slice(0, 120), autoApproveWrites ? 1 : 0, now, now]); } finally { await m.end(); }
    return (await this.getConversation(tenant, owner, id))!;
  }
  async listConversations(tenant: string, owner: string): Promise<Conversation[]> {
    const m = await this.meta();
    try { const [r] = await m.query('SELECT * FROM ai_conversations WHERE tenant = ? AND owner_sub = ? ORDER BY updated_at DESC LIMIT 100', [tenant, owner]); return (r as Row[]).map((x) => this.shapeConv(x)); } finally { await m.end(); }
  }
  /** Owner-scoped: another administrator's conversation is "not found", not "forbidden". */
  async getConversation(tenant: string, owner: string, id: string): Promise<Conversation | null> {
    if (!CONV_ID.test(id)) throw new BadRequestException('invalid conversation id');
    const m = await this.meta();
    try { const [r] = await m.query('SELECT * FROM ai_conversations WHERE tenant = ? AND owner_sub = ? AND id = ?', [tenant, owner, id]); const row = (r as Row[])[0]; return row ? this.shapeConv(row) : null; } finally { await m.end(); }
  }
  async deleteConversation(id: string): Promise<void> {
    const m = await this.meta();
    try { await m.query('DELETE FROM ai_messages WHERE conversation_id = ?', [id]); await m.query('DELETE FROM ai_conversations WHERE id = ?', [id]); } finally { await m.end(); }
  }
  async messages(id: string): Promise<ChatMessage[]> {
    const m = await this.meta();
    try { const [r] = await m.query('SELECT payload FROM ai_messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 500', [id]); return (r as Row[]).map((x) => JSON.parse(String(x.payload)) as ChatMessage); } finally { await m.end(); }
  }
  async append(id: string, msgs: ChatMessage[]): Promise<void> {
    if (!msgs.length) return;
    const m = await this.meta();
    try {
      for (const x of msgs) await m.query('INSERT INTO ai_messages (conversation_id, payload) VALUES (?,?)', [id, JSON.stringify(x)]);
      await m.query('UPDATE ai_conversations SET updated_at = ? WHERE id = ?', [new Date().toISOString().slice(0, 23), id]);
    } finally { await m.end(); }
  }
}
