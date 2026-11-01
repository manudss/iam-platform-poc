import { Injectable } from '@nestjs/common';
import { createConnection, Connection } from 'mysql2/promise';
import { WfGraph, WfTrigger } from './model.js';

/**
 * Persistence for workflow definitions and runs, in the UNVERSIONED `<db>_meta` database: the same
 * place as Dolt pull request records and personal branch names. This is platform metadata, never
 * business data, so it is not versioned, never merged, and invisible to the data branches a run creates.
 */
export interface DefinitionRow { id: string; tenant: string; name: string; description: string; graph: WfGraph; trigger: WfTrigger | null; created_by: string; created_at: string; updated_at: string }
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
export interface RunRow { id: string; tenant: string; definition_id: string; name: string; graph: WfGraph; branch: string | null; base_branch: string | null; status: RunStatus; error: string | null; started_by: string; started_at: string; finished_at: string | null }
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export interface StepRow { run_id: string; node_id: string; status: StepStatus; simulated: boolean; attempts: number; error: string | null; log: string[]; started_at: string | null; finished_at: string | null }

@Injectable()
export class WorkflowStore {
  private ready?: Promise<void>;
  private get dbName() { return process.env.DOLT_DATABASE ?? 'iam'; }
  private get metaDb() { return `${this.dbName}_meta`.replace(/[^A-Za-z0-9_]/g, ''); }

  private async open(withDb = true): Promise<Connection> {
    return createConnection({ host: process.env.DOLT_HOST ?? '127.0.0.1', port: Number(process.env.DOLT_PORT ?? 3307), user: process.env.DOLT_USER ?? 'root', password: process.env.DOLT_PASSWORD ?? '', ...(withDb ? { database: this.metaDb } : {}), connectTimeout: 5000, dateStrings: true });
  }
  private async meta(): Promise<Connection> {
    if (!this.ready) {
      this.ready = (async () => {
        const c = await this.open(false);
        try { await c.query(`CREATE DATABASE IF NOT EXISTS \`${this.metaDb}\``); } finally { await c.end(); }
        const m = await this.open();
        try {
          await m.query('CREATE TABLE IF NOT EXISTS workflow_definitions (tenant VARCHAR(32) NOT NULL, id VARCHAR(40) NOT NULL, name VARCHAR(80) NOT NULL, description VARCHAR(500) NOT NULL, graph JSON NOT NULL, trigger_json JSON NULL, created_by VARCHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, PRIMARY KEY (tenant, id))');
          await m.query('CREATE TABLE IF NOT EXISTS workflow_runs (id VARCHAR(40) NOT NULL PRIMARY KEY, tenant VARCHAR(32) NOT NULL, definition_id VARCHAR(40) NOT NULL, name VARCHAR(80) NOT NULL, graph JSON NOT NULL, branch VARCHAR(63) NULL, base_branch VARCHAR(63) NULL, status VARCHAR(16) NOT NULL, error VARCHAR(500) NULL, started_by VARCHAR(64) NOT NULL, started_at DATETIME(3) NOT NULL, finished_at DATETIME(3) NULL, KEY wf_runs_tenant (tenant, started_at))');
          // Existing demo databases: add the columns once (idempotent).
          for (const [table, column, ddl] of [['workflow_definitions', 'trigger_json', 'JSON NULL'], ['workflow_runs', 'base_branch', 'VARCHAR(63) NULL']] as const) {
            const [cols] = await m.query(`show columns from ${table} like ?`, [column]);
            if (!(cols as unknown[]).length) await m.query(`alter table ${table} add column ${column} ${ddl}`);
          }
          await m.query('CREATE TABLE IF NOT EXISTS workflow_steps (run_id VARCHAR(40) NOT NULL, node_id VARCHAR(40) NOT NULL, status VARCHAR(16) NOT NULL, simulated BOOLEAN NOT NULL, attempts INT NOT NULL DEFAULT 0, error VARCHAR(500) NULL, log JSON NULL, started_at DATETIME(3) NULL, finished_at DATETIME(3) NULL, PRIMARY KEY (run_id, node_id))');
        } finally { await m.end(); }
      })().catch((e) => { this.ready = undefined; throw e; });
    }
    await this.ready;
    return this.open();
  }

  private static def(r: Record<string, unknown>): DefinitionRow {
    const trig = typeof r.trigger_json === 'string' ? JSON.parse(r.trigger_json) : r.trigger_json;
    return { id: String(r.id), tenant: String(r.tenant), name: String(r.name), description: String(r.description), graph: (typeof r.graph === 'string' ? JSON.parse(r.graph) : r.graph) as WfGraph, trigger: (trig ?? null) as WfTrigger | null, created_by: String(r.created_by), created_at: String(r.created_at), updated_at: String(r.updated_at) };
  }
  private static run(r: Record<string, unknown>): RunRow {
    return { id: String(r.id), tenant: String(r.tenant), definition_id: String(r.definition_id), name: String(r.name), graph: (typeof r.graph === 'string' ? JSON.parse(r.graph) : r.graph) as WfRow_graph, branch: r.branch === null ? null : String(r.branch), base_branch: r.base_branch === null || r.base_branch === undefined ? null : String(r.base_branch), status: r.status as RunStatus, error: r.error === null ? null : String(r.error), started_by: String(r.started_by), started_at: String(r.started_at), finished_at: r.finished_at === null ? null : String(r.finished_at) };
  }
  private static step(r: Record<string, unknown>): StepRow {
    const log = typeof r.log === 'string' ? JSON.parse(r.log) : r.log;
    return { run_id: String(r.run_id), node_id: String(r.node_id), status: r.status as StepStatus, simulated: !!r.simulated, attempts: Number(r.attempts), error: r.error === null ? null : String(r.error), log: Array.isArray(log) ? log.map(String) : [], started_at: r.started_at === null ? null : String(r.started_at), finished_at: r.finished_at === null ? null : String(r.finished_at) };
  }

  async listDefinitions(tenant: string): Promise<DefinitionRow[]> {
    const m = await this.meta();
    try { const [r] = await m.query('select * from workflow_definitions where tenant = ? order by name', [tenant]); return (r as Record<string, unknown>[]).map(WorkflowStore.def); } finally { await m.end(); }
  }
  async getDefinition(tenant: string, id: string): Promise<DefinitionRow | null> {
    const m = await this.meta();
    try { const [r] = await m.query('select * from workflow_definitions where tenant = ? and id = ?', [tenant, id]); const row = (r as Record<string, unknown>[])[0]; return row ? WorkflowStore.def(row) : null; } finally { await m.end(); }
  }
  async putDefinition(d: DefinitionRow): Promise<void> {
    const m = await this.meta();
    try { await m.query('insert into workflow_definitions (tenant, id, name, description, graph, trigger_json, created_by, created_at, updated_at) values (?,?,?,?,?,?,?,?,?) on duplicate key update name=values(name), description=values(description), graph=values(graph), trigger_json=values(trigger_json), updated_at=values(updated_at)', [d.tenant, d.id, d.name, d.description, JSON.stringify(d.graph), d.trigger ? JSON.stringify(d.trigger) : null, d.created_by, d.created_at, d.updated_at]); } finally { await m.end(); }
  }
  async deleteDefinition(tenant: string, id: string): Promise<boolean> {
    const m = await this.meta();
    try { const [r] = await m.query('delete from workflow_definitions where tenant = ? and id = ?', [tenant, id]); return Number((r as { affectedRows: number }).affectedRows) > 0; } finally { await m.end(); }
  }

  async createRun(run: RunRow, steps: StepRow[]): Promise<void> {
    const m = await this.meta();
    try {
      await m.query('insert into workflow_runs (id, tenant, definition_id, name, graph, branch, base_branch, status, error, started_by, started_at, finished_at) values (?,?,?,?,?,?,?,?,?,?,?,?)', [run.id, run.tenant, run.definition_id, run.name, JSON.stringify(run.graph), run.branch, run.base_branch, run.status, run.error, run.started_by, run.started_at, run.finished_at]);
      for (const s of steps) await m.query('insert into workflow_steps (run_id, node_id, status, simulated, attempts, error, log) values (?,?,?,?,0,null,?)', [s.run_id, s.node_id, s.status, s.simulated, JSON.stringify([])]);
    } finally { await m.end(); }
  }
  async getRunById(id: string): Promise<RunRow | null> {
    const m = await this.meta();
    try { const [r] = await m.query('select * from workflow_runs where id = ?', [id]); const row = (r as Record<string, unknown>[])[0]; return row ? WorkflowStore.run(row) : null; } finally { await m.end(); }
  }
  async getRun(tenant: string, id: string): Promise<RunRow | null> {
    const m = await this.meta();
    try { const [r] = await m.query('select * from workflow_runs where tenant = ? and id = ?', [tenant, id]); const row = (r as Record<string, unknown>[])[0]; return row ? WorkflowStore.run(row) : null; } finally { await m.end(); }
  }
  async listRuns(tenant: string, definitionId?: string, limit = 50): Promise<RunRow[]> {
    const m = await this.meta();
    try {
      const [r] = definitionId
        ? await m.query('select * from workflow_runs where tenant = ? and definition_id = ? order by started_at desc limit ?', [tenant, definitionId, limit])
        : await m.query('select * from workflow_runs where tenant = ? order by started_at desc limit ?', [tenant, limit]);
      return (r as Record<string, unknown>[]).map(WorkflowStore.run);
    } finally { await m.end(); }
  }
  async updateRun(id: string, patch: Partial<Pick<RunRow, 'status' | 'error' | 'branch' | 'finished_at'>>): Promise<void> {
    const sets: string[] = [], vals: unknown[] = [];
    for (const k of ['status', 'error', 'branch', 'finished_at'] as const) if (k in patch) { sets.push(`${k} = ?`); vals.push(patch[k] ?? null); }
    if (!sets.length) return;
    vals.push(id);
    const m = await this.meta();
    try { await m.query(`update workflow_runs set ${sets.join(', ')} where id = ?`, vals); } finally { await m.end(); }
  }
  async runningRuns(): Promise<RunRow[]> {
    const m = await this.meta();
    try { const [r] = await m.query("select * from workflow_runs where status in ('queued','running')"); return (r as Record<string, unknown>[]).map(WorkflowStore.run); } finally { await m.end(); }
  }

  async steps(runId: string): Promise<StepRow[]> {
    const m = await this.meta();
    try { const [r] = await m.query('select * from workflow_steps where run_id = ?', [runId]); return (r as Record<string, unknown>[]).map(WorkflowStore.step); } finally { await m.end(); }
  }
  async step(runId: string, nodeId: string): Promise<StepRow | null> {
    const m = await this.meta();
    try { const [r] = await m.query('select * from workflow_steps where run_id = ? and node_id = ?', [runId, nodeId]); const row = (r as Record<string, unknown>[])[0]; return row ? WorkflowStore.step(row) : null; } finally { await m.end(); }
  }
  async patchStep(runId: string, nodeId: string, patch: Partial<Pick<StepRow, 'status' | 'error' | 'log' | 'started_at' | 'finished_at'>> & { attempts?: number }): Promise<void> {
    const sets: string[] = [], vals: unknown[] = [];
    for (const k of ['status', 'error', 'started_at', 'finished_at', 'attempts'] as const) if (k in patch) { sets.push(`${k} = ?`); vals.push((patch as Record<string, unknown>)[k] ?? null); }
    if ('log' in patch) { sets.push('log = ?'); vals.push(JSON.stringify(patch.log ?? [])); }
    if (!sets.length) return;
    vals.push(runId, nodeId);
    const m = await this.meta();
    try { await m.query(`update workflow_steps set ${sets.join(', ')} where run_id = ? and node_id = ?`, vals); } finally { await m.end(); }
  }
}
// Local alias so the run() mapper stays readable.
type WfRow_graph = WfGraph;
