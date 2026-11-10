import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { createConnection, Connection } from 'mysql2/promise';
import { VersioningService } from '../versioning/versioning.service.js';
import { workspaceMode } from '../workspace/context.js';
import { WfGraph, WfTrigger } from './model.js';

/**
 * Persistence for workflow runs and steps, in the UNVERSIONED `<db>_meta` database: execution state,
 * never business data, so it is not versioned, never merged, and invisible to the data branches a run creates.
 * Workflow DEFINITIONS are the opposite: they are configuration, versioned in the main Dolt database
 * (table workflow_definitions), so an edit prepared on a working branch only goes live through a reviewed
 * data pull request - the same circuit as roles, plugin settings and the sign-in configuration.
 */
export interface DefinitionRow { id: string; tenant: string; name: string; description: string; graph: WfGraph; trigger: WfTrigger | null; /** false = paused: event triggers skip it (a manual Run still works). */ active: boolean; created_by: string; created_at: string; updated_at: string }
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
export interface RunRow { id: string; tenant: string; definition_id: string; name: string; graph: WfGraph; branch: string | null; base_branch: string | null; status: RunStatus; error: string | null; started_by: string; started_at: string; finished_at: string | null; test: boolean }
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export interface StepRow { run_id: string; node_id: string; status: StepStatus; simulated: boolean; attempts: number; error: string | null; log: string[]; input: Record<string, unknown> | null; output: Record<string, unknown> | null; started_at: string | null; finished_at: string | null }

@Injectable()
export class WorkflowStore {
  constructor(@Optional() private readonly v?: VersioningService) {}
  private ready?: Promise<void>;
  /** The live, approved workflow definitions live on Dolt main; edits prepared on a working branch only apply through a reviewed pull request. */
  get liveRef() { return this.v?.defaultBranch ?? 'main'; }
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
          for (const [table, column, ddl] of [['workflow_definitions', 'trigger_json', 'JSON NULL'], ['workflow_runs', 'base_branch', 'VARCHAR(63) NULL'], ['workflow_runs', 'test', 'BOOLEAN NOT NULL DEFAULT FALSE']] as const) {
            const [cols] = await m.query(`show columns from ${table} like ?`, [column]);
            if (!(cols as unknown[]).length) await m.query(`alter table ${table} add column ${column} ${ddl}`);
          }
          await m.query('CREATE TABLE IF NOT EXISTS workflow_steps (run_id VARCHAR(40) NOT NULL, node_id VARCHAR(40) NOT NULL, status VARCHAR(16) NOT NULL, simulated BOOLEAN NOT NULL, attempts INT NOT NULL DEFAULT 0, error VARCHAR(500) NULL, log JSON NULL, output JSON NULL, started_at DATETIME(3) NULL, finished_at DATETIME(3) NULL, PRIMARY KEY (run_id, node_id))');
          // Existing demo databases: add the output/input columns once (idempotent).
          for (const col of ['output', 'input']) { const [cols] = await m.query(`show columns from workflow_steps like '${col}'`); if (!(cols as unknown[]).length) await m.query(`alter table workflow_steps add column ${col} JSON NULL`); }
          // One-time migration marker: without it, a definition deleted on main would be resurrected from a stale meta row at the next restart.
          await m.query('CREATE TABLE IF NOT EXISTS workflow_store_meta (k VARCHAR(40) NOT NULL PRIMARY KEY, v VARCHAR(200) NOT NULL)');
        } finally { await m.end(); }
        // Definitions moved to the versioned database: create the table on main and copy any pre-existing meta rows ONCE (startup-only code, never reachable from a request).
        if (this.v) {
          const v = this.v;
          const m = await this.open();
          let already = true;
          try { const [r] = await m.query("select v from workflow_store_meta where k = 'defs_migrated'"); already = (r as unknown[]).length > 0; } finally { await m.end(); }
          if (!already) {
            await v.lock(() => v.at(v.defaultBranch, async (c) => {
              await WorkflowStore.ensureDefsTable(c);
              await c.query(`INSERT IGNORE INTO workflow_definitions (tenant, id, name, description, graph, trigger_json, created_by, created_at, updated_at) SELECT tenant, id, name, description, graph, trigger_json, created_by, created_at, updated_at FROM \`${this.metaDb}\`.workflow_definitions`);
              const [d] = await c.query("select table_name from dolt_status where table_name = 'workflow_definitions'");
              if ((d as unknown[]).length) { await c.query("call dolt_add('workflow_definitions')"); await c.query("call dolt_commit('-m', 'workflows: version workflow definitions')"); }
            }));
            const m2 = await this.open();
            try { await m2.query("insert into workflow_store_meta (k, v) values ('defs_migrated', ?)", [new Date().toISOString()]); } finally { await m2.end(); }
          } else {
            // Marker set: still make sure the versioned table exists (fresh main after the marker db was kept).
            await v.lock(() => v.at(v.defaultBranch, async (c) => {
              await WorkflowStore.ensureDefsTable(c);
              const [d] = await c.query("select table_name from dolt_status where table_name = 'workflow_definitions'");
              if ((d as unknown[]).length) { await c.query("call dolt_add('workflow_definitions')"); await c.query("call dolt_commit('-m', 'workflows: version workflow definitions')"); }
            }));
          }
        }
      })().catch((e) => { this.ready = undefined; throw e; });
    }
    await this.ready;
    return this.open();
  }

  private static ts(v: unknown): string { return v instanceof Date ? v.toISOString().slice(0, 23).replace('T', ' ') : String(v); }
  private static def(r: Record<string, unknown>): DefinitionRow {
    const trig = typeof r.trigger_json === 'string' ? JSON.parse(r.trigger_json) : r.trigger_json;
    return { id: String(r.id), tenant: String(r.tenant), name: String(r.name), description: String(r.description), graph: (typeof r.graph === 'string' ? JSON.parse(r.graph) : r.graph) as WfGraph, trigger: (trig ?? null) as WfTrigger | null, active: r.active === undefined || r.active === null ? true : !!r.active, created_by: String(r.created_by), created_at: WorkflowStore.ts(r.created_at), updated_at: WorkflowStore.ts(r.updated_at) };
  }
  private static run(r: Record<string, unknown>): RunRow {
    return { id: String(r.id), tenant: String(r.tenant), definition_id: String(r.definition_id), name: String(r.name), graph: (typeof r.graph === 'string' ? JSON.parse(r.graph) : r.graph) as WfRow_graph, branch: r.branch === null ? null : String(r.branch), base_branch: r.base_branch === null || r.base_branch === undefined ? null : String(r.base_branch), status: r.status as RunStatus, error: r.error === null ? null : String(r.error), started_by: String(r.started_by), started_at: String(r.started_at), finished_at: r.finished_at === null ? null : String(r.finished_at), test: !!r.test };
  }
  private static step(r: Record<string, unknown>): StepRow {
    const log = typeof r.log === 'string' ? JSON.parse(r.log) : r.log;
    const output = typeof r.output === 'string' ? JSON.parse(r.output) : r.output;
    const input = typeof r.input === 'string' ? JSON.parse(r.input) : r.input;
    return { run_id: String(r.run_id), node_id: String(r.node_id), status: r.status as StepStatus, simulated: !!r.simulated, attempts: Number(r.attempts), error: r.error === null ? null : String(r.error), log: Array.isArray(log) ? log.map(String) : [], input: (input ?? null) as Record<string, unknown> | null, output: (output ?? null) as Record<string, unknown> | null, started_at: r.started_at === null ? null : String(r.started_at), finished_at: r.finished_at === null ? null : String(r.finished_at) };
  }

  /** Definitions are versioned rows: reads run on the given ref, writes commit on it (working branch in workspace mode, main elsewhere). */
  private defsRead<T>(ref: string, fn: (c: Connection) => Promise<T>): Promise<T> {
    if (!this.v) throw new BadRequestException('no database');
    return this.v.at(ref, fn);
  }
  private defsWrite<T>(ref: string, fn: (c: Connection) => Promise<T>): Promise<T> {
    if (!this.v) throw new BadRequestException('no database');
    return workspaceMode() && ref !== this.v.defaultBranch ? this.v.writeOn(ref, fn) : this.v.lock(() => this.v!.at(ref, fn));
  }
  /** The versioned definitions table, with every column added since (idempotent on existing databases). */
  private static async ensureDefsTable(c: Connection) {
    await c.query('CREATE TABLE IF NOT EXISTS workflow_definitions (tenant VARCHAR(32) NOT NULL, id VARCHAR(40) NOT NULL, name VARCHAR(80) NOT NULL, description VARCHAR(500) NOT NULL, graph JSON NOT NULL, trigger_json JSON NULL, active BOOLEAN NOT NULL DEFAULT TRUE, created_by VARCHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, PRIMARY KEY (tenant, id))');
    const [cols] = await c.query("show columns from workflow_definitions like 'active'");
    if (!(cols as unknown[]).length) await c.query('alter table workflow_definitions add column active BOOLEAN NOT NULL DEFAULT TRUE');
  }
  private static async commitDefs(c: Connection, msg: string) {
    const [d] = await c.query("select table_name from dolt_status where table_name = 'workflow_definitions'");
    if ((d as unknown[]).length) { await c.query("call dolt_add('workflow_definitions')"); await c.query("call dolt_commit('-m', ?)", [msg]); }
  }
  async listDefinitions(tenant: string, ref: string): Promise<DefinitionRow[]> {
    return this.defsRead(ref, async (c) => { const [r] = await c.query('select * from workflow_definitions where tenant = ? order by name', [tenant]); return (r as Record<string, unknown>[]).map(WorkflowStore.def); });
  }
  /** Every tenant's definitions on a ref: used by the sheet row watcher, which polls across tenants. */
  async listAllDefinitions(ref: string): Promise<DefinitionRow[]> {
    return this.defsRead(ref, async (c) => { const [r] = await c.query('select * from workflow_definitions order by tenant, name'); return (r as Record<string, unknown>[]).map(WorkflowStore.def); });
  }
  async getDefinition(tenant: string, id: string, ref: string): Promise<DefinitionRow | null> {
    return this.defsRead(ref, async (c) => { const [r] = await c.query('select * from workflow_definitions where tenant = ? and id = ?', [tenant, id]); const row = (r as Record<string, unknown>[])[0]; return row ? WorkflowStore.def(row) : null; });
  }
  async putDefinition(d: DefinitionRow, ref: string): Promise<void> {
    await this.defsWrite(ref, async (c) => {
      await c.query('insert into workflow_definitions (tenant, id, name, description, graph, trigger_json, active, created_by, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?) on duplicate key update name=values(name), description=values(description), graph=values(graph), trigger_json=values(trigger_json), active=values(active), updated_at=values(updated_at)', [d.tenant, d.id, d.name, d.description, JSON.stringify(d.graph), d.trigger ? JSON.stringify(d.trigger) : null, d.active ? 1 : 0, d.created_by, d.created_at, d.updated_at]);
      await WorkflowStore.commitDefs(c, `workflows: ${d.created_by} saved ${d.id}`);
    });
  }
  async deleteDefinition(tenant: string, id: string, ref: string): Promise<boolean> {
    return this.defsWrite(ref, async (c) => {
      const [r] = await c.query('delete from workflow_definitions where tenant = ? and id = ?', [tenant, id]);
      const gone = Number((r as { affectedRows: number }).affectedRows) > 0;
      if (gone) await WorkflowStore.commitDefs(c, `workflows: deleted ${id}`);
      return gone;
    });
  }

  async createRun(run: RunRow, steps: StepRow[]): Promise<void> {
    const m = await this.meta();
    try {
      await m.beginTransaction();
      await m.query('insert into workflow_runs (id, tenant, definition_id, name, graph, branch, base_branch, status, error, started_by, started_at, finished_at, test) values (?,?,?,?,?,?,?,?,?,?,?,?,?)', [run.id, run.tenant, run.definition_id, run.name, JSON.stringify(run.graph), run.branch, run.base_branch, run.status, run.error, run.started_by, run.started_at, run.finished_at, run.test ? 1 : 0]);
      for (const s of steps) await m.query('insert into workflow_steps (run_id, node_id, status, simulated, attempts, error, log) values (?,?,?,?,0,null,?)', [s.run_id, s.node_id, s.status, s.simulated, JSON.stringify([])]);
      await m.commit();
    } catch (e) { await m.rollback(); throw e; } finally { await m.end(); }
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
  async patchStep(runId: string, nodeId: string, patch: Partial<Pick<StepRow, 'status' | 'error' | 'log' | 'input' | 'output' | 'started_at' | 'finished_at'>> & { attempts?: number }): Promise<void> {
    const sets: string[] = [], vals: unknown[] = [];
    for (const k of ['status', 'error', 'started_at', 'finished_at', 'attempts'] as const) if (k in patch) { sets.push(`${k} = ?`); vals.push((patch as Record<string, unknown>)[k] ?? null); }
    if ('log' in patch) { sets.push('log = ?'); vals.push(JSON.stringify(patch.log ?? [])); }
    if ('input' in patch) { sets.push('input = ?'); vals.push(patch.input === undefined || patch.input === null ? null : JSON.stringify(patch.input).slice(0, 8000)); }
    if ('output' in patch) { sets.push('output = ?'); vals.push(patch.output === undefined || patch.output === null ? null : JSON.stringify(patch.output).slice(0, 8000)); }
    if (!sets.length) return;
    vals.push(runId, nodeId);
    const m = await this.meta();
    try { await m.query(`update workflow_steps set ${sets.join(', ')} where run_id = ? and node_id = ?`, vals); } finally { await m.end(); }
  }
}
// Local alias so the run() mapper stays readable.
type WfRow_graph = WfGraph;
