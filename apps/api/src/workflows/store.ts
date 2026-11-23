import type { WorkflowConnection } from './connections.js';
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
export interface DefinitionRow { id: string; tenant: string; name: string; description: string; graph: WfGraph; trigger: WfTrigger | null; /** false = paused: event triggers skip it (a manual Run still works). */ active: boolean; /** Free-form lowercase labels used to filter the list (max 8, 1-24 chars each). */ tags: string[]; created_by: string; created_at: string; updated_at: string }
export type RunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'canceled';
/** waiting = parked on a durable human task (approval, certification...): the task service kicks it back. */
export interface RunRow { id: string; tenant: string; definition_id: string; name: string; graph: WfGraph; branch: string | null; base_branch: string | null; status: RunStatus; error: string | null; started_by: string; started_at: string; finished_at: string | null; test: boolean }
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export interface StepRow { run_id: string; node_id: string; status: StepStatus; simulated: boolean; attempts: number; error: string | null; log: string[]; input: Record<string, unknown> | null; output: Record<string, unknown> | null; started_at: string | null; finished_at: string | null }
/** A template a user saved from a workflow ("Save as template"). Versioned like definitions, and GLOBAL
 * (no tenant column): in this demo every account shares the same gallery. Official/community templates
 * are the static API catalog, not rows. */
export interface TemplateRow { id: string; name: string; description: string; category: string; graph: WfGraph; trigger: WfTrigger | null; created_by: string; created_at: string }

/** A durable human task (approval, certification, publication review...). Operational durable state in the
 *  meta store: it survives restarts, is never versioned and never rolled back with a branch. A task belongs
 *  to the run step that created it (run_id + node_id); its decision kicks the run back. */
export interface TaskRow { id: string; tenant: string; kind: string; title: string; detail: Record<string, unknown>; assignee: string; delegated_to: string | null; status: 'open' | 'decided' | 'canceled'; decision: string | null; justification: string | null; decided_by: string | null; run_id: string | null; node_id: string | null; prevent_self: boolean; created_at: string; due_at: string | null; reminded_at: string | null; decided_at: string | null }

export interface TicketKey { tenant: string; connectionId: string; project: string; issueKey: string }
export interface TicketLink extends TicketKey { account: string; source: string; spreadsheetId: string; sheetId: number; keyColumn: string; keyValue: string; runId: string }
export interface TicketLinkRow { tenant: string; connection_id: string; project: string; issue_key: string; account: string; source: string; spreadsheet_id: string; sheet_id: number; key_column: string; key_value: string; phase1_run: string; status: 'open' | 'claimed' | 'done'; claimed_run: string | null }

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
          // Durable ticket > account > sheet-row correlation written by the creation workflow. Operational state (not on a branch, never rolled back with one): the Done workflow resolves it, Jira text is never the authority.
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
              await WorkflowStore.ensureTemplatesTable(c);
              await WorkflowStore.ensureConnectionsTable(c);
              await c.query(`INSERT IGNORE INTO workflow_definitions (tenant, id, name, description, graph, trigger_json, created_by, created_at, updated_at) SELECT tenant, id, name, description, graph, trigger_json, created_by, created_at, updated_at FROM \`${this.metaDb}\`.workflow_definitions`);
              const [d] = await c.query("select table_name from dolt_status where table_name in ('workflow_definitions', 'workflow_templates', 'workflow_connections')");
              if ((d as unknown[]).length) { await c.query("call dolt_add('workflow_definitions', 'workflow_templates', 'workflow_connections')"); await c.query("call dolt_commit('-m', 'workflows: version workflow definitions and templates')"); }
            }));
            const m2 = await this.open();
            try { await m2.query("insert into workflow_store_meta (k, v) values ('defs_migrated', ?)", [new Date().toISOString()]); } finally { await m2.end(); }
          } else {
            // Marker set: still make sure the versioned table exists (fresh main after the marker db was kept).
            await v.lock(() => v.at(v.defaultBranch, async (c) => {
              await WorkflowStore.ensureDefsTable(c);
              await WorkflowStore.ensureTemplatesTable(c);
              await WorkflowStore.ensureConnectionsTable(c);
              const [d] = await c.query("select table_name from dolt_status where table_name in ('workflow_definitions', 'workflow_templates', 'workflow_connections')");
              if ((d as unknown[]).length) { await c.query("call dolt_add('workflow_definitions', 'workflow_templates', 'workflow_connections')"); await c.query("call dolt_commit('-m', 'workflows: version workflow definitions and templates')"); }
            }));
          }
        }
      })().catch((e) => { this.ready = undefined; throw e; });
    }
    await this.ready;
    return this.open();
  }

  /** Connector reads do not migrate an existing deployment at boot. First write prepares storage. */
  private async pieceTable(c:Connection){await c.query('CREATE TABLE IF NOT EXISTS workflow_piece_state (tenant VARCHAR(64) NOT NULL, scope_id VARCHAR(200) NOT NULL, state_key VARCHAR(200) NOT NULL, value_json LONGTEXT NOT NULL, PRIMARY KEY(tenant,scope_id,state_key))');}
  async pieceGet(tenant:string,scope:string,key:string):Promise<unknown>{
    const c=await this.meta();try{const [rows]=await c.query('SELECT value_json FROM workflow_piece_state WHERE tenant=? AND scope_id=? AND state_key=?',[tenant,scope,key]);const r=(rows as {value_json:string}[])[0];return r?JSON.parse(r.value_json):null;}catch(e){if(WorkflowStore.noTable(e))return null;throw e;}finally{await c.end();}
  }
  async piecePut(tenant:string,scope:string,key:string,value:unknown){
    const text=JSON.stringify(value);if(text===undefined||text.length>16_000_000)throw new BadRequestException('connector state too large or undefined');
    const c=await this.meta();try{await this.pieceTable(c);await c.query('REPLACE INTO workflow_piece_state (tenant,scope_id,state_key,value_json) VALUES (?,?,?,?)',[tenant,scope,key,text]);}finally{await c.end();}
  }
  async pieceSubscriptions():Promise<{tenant:string,scope:string,state:unknown}[]>{
    const c=await this.meta();try{const[rows]=await c.query("SELECT tenant,scope_id,value_json FROM workflow_piece_state WHERE state_key='lyam:subscription'");return (rows as any[]).map(r=>({tenant:r.tenant,scope:r.scope_id,state:JSON.parse(r.value_json)}));}catch(e){if(WorkflowStore.noTable(e))return [];throw e;}finally{await c.end();}
  }
  /** Operational status only. Never expose native values, webhook tokens or provider payloads. */
  async pieceStatuses(tenant:string):Promise<{scope:string,subscription:unknown,locked:boolean,pending:number}[]>{
    const c=await this.meta();try{const[rows]=await c.query("SELECT scope_id,state_key,value_json FROM workflow_piece_state WHERE tenant=? AND (scope_id LIKE 'trigger:%' OR scope_id LIKE 'action:%') AND state_key IN ('lyam:subscription','lyam:lock','lyam:pending')",[tenant]);const result=new Map<string,{scope:string,subscription:unknown,locked:boolean,pending:number}>();for(const r of rows as any[]){const v=JSON.parse(r.value_json),entry=result.get(r.scope_id)??{scope:r.scope_id,subscription:null,locked:false,pending:0};if(r.state_key==='lyam:subscription')entry.subscription={key:v.key,status:v.status,lastRenew:v.lastRenew};if(r.state_key==='lyam:lock')entry.locked=true;if(r.state_key==='lyam:pending')entry.pending=Array.isArray(v)?v.length:0;result.set(r.scope_id,entry);}return [...result.values()];}catch(e){if(WorkflowStore.noTable(e))return [];throw e;}finally{await c.end();}
  }
  async pieceDelete(tenant:string,scope:string,key:string){const c=await this.meta();try{await c.query('DELETE FROM workflow_piece_state WHERE tenant=? AND scope_id=? AND state_key=?',[tenant,scope,key]);}catch(e){if(!WorkflowStore.noTable(e))throw e;}finally{await c.end();}}
  /** Durable fail-closed mutex. No expiry: a crashed owner requires operator reconciliation, never an overlapping provider call. */
  async pieceClaim(tenant:string,scope:string,owner:string){const c=await this.meta();try{await this.pieceTable(c);let r:any;try{[r]=await c.query("INSERT IGNORE INTO workflow_piece_state (tenant,scope_id,state_key,value_json) VALUES (?,?,'lyam:lock',?)",[tenant,scope,JSON.stringify({owner,at:Date.now()})]);}catch(e){if(WorkflowStore.writeConflict(e))return false;throw e;}return Number(r.affectedRows)===1;}finally{await c.end();}}
  async pieceRelease(tenant:string,scope:string,owner:string){const c=await this.meta();try{await c.query("DELETE FROM workflow_piece_state WHERE tenant=? AND scope_id=? AND state_key='lyam:lock' AND JSON_UNQUOTE(JSON_EXTRACT(value_json,'$.owner'))=?",[tenant,scope,owner]);}finally{await c.end();}}

  /** Initial migration prepares storage before any workflow runner is allowed to start. */
  async prepareMigrationStorage() { const c = await this.meta(); await c.end(); }

  private static ts(v: unknown): string { return v instanceof Date ? v.toISOString().slice(0, 23).replace('T', ' ') : String(v); }
  private static def(r: Record<string, unknown>): DefinitionRow {
    const trig = typeof r.trigger_json === 'string' ? JSON.parse(r.trigger_json) : r.trigger_json;
    const tags = typeof r.tags === 'string' ? JSON.parse(r.tags) : r.tags;
    return { id: String(r.id), tenant: String(r.tenant), name: String(r.name), description: String(r.description), graph: (typeof r.graph === 'string' ? JSON.parse(r.graph) : r.graph) as WfGraph, trigger: (trig ?? null) as WfTrigger | null, active: r.active === undefined || r.active === null ? true : !!r.active, tags: Array.isArray(tags) ? tags.map(String) : [], created_by: String(r.created_by), created_at: WorkflowStore.ts(r.created_at), updated_at: WorkflowStore.ts(r.updated_at) };
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
    for (const [column, ddl] of [['active', 'BOOLEAN NOT NULL DEFAULT TRUE'], ['tags', 'JSON NULL']] as const) {
      const [cols] = await c.query('show columns from workflow_definitions like ?', [column]);
      if (!(cols as unknown[]).length) await c.query(`alter table workflow_definitions add column ${column} ${ddl}`);
    }
  }
  /** The versioned templates table (user-saved templates, shared across demo accounts). */
  private static async ensureTemplatesTable(c: Connection) {
    await c.query('CREATE TABLE IF NOT EXISTS workflow_templates (id VARCHAR(40) NOT NULL PRIMARY KEY, name VARCHAR(80) NOT NULL, description VARCHAR(500) NOT NULL, category VARCHAR(60) NOT NULL, graph JSON NOT NULL, trigger_json JSON NULL, created_by VARCHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL)');
  }
  private static async commitDefs(c: Connection, msg: string) {
    const [d] = await c.query("select table_name from dolt_status where table_name = 'workflow_definitions'");
    if ((d as unknown[]).length) { await c.query("call dolt_add('workflow_definitions')"); await c.query("call dolt_commit('-m', ?)", [msg]); }
  }
  private static async commitTemplates(c: Connection, msg: string) {
    const [d] = await c.query("select table_name from dolt_status where table_name = 'workflow_templates'");
    if ((d as unknown[]).length) { await c.query("call dolt_add('workflow_templates')"); await c.query("call dolt_commit('-m', ?)", [msg]); }
  }
  private static template(r: Record<string, unknown>): TemplateRow {
    const trig = typeof r.trigger_json === 'string' ? JSON.parse(r.trigger_json) : r.trigger_json;
    return { id: String(r.id), name: String(r.name), description: String(r.description), category: String(r.category), graph: (typeof r.graph === 'string' ? JSON.parse(r.graph) : r.graph) as WfGraph, trigger: (trig ?? null) as WfTrigger | null, created_by: String(r.created_by), created_at: WorkflowStore.ts(r.created_at) };
  }
  async listTemplates(ref: string): Promise<TemplateRow[]> {
    return this.defsRead(ref, async (c) => { const [r] = await c.query('select * from workflow_templates order by created_at desc'); return (r as Record<string, unknown>[]).map(WorkflowStore.template); });
  }
  async putTemplate(t: TemplateRow, ref: string): Promise<void> {
    await this.defsWrite(ref, async (c) => {
      await c.query('insert into workflow_templates (id, name, description, category, graph, trigger_json, created_by, created_at) values (?,?,?,?,?,?,?,?)', [t.id, t.name, t.description, t.category, JSON.stringify(t.graph), t.trigger ? JSON.stringify(t.trigger) : null, t.created_by, t.created_at]);
      await WorkflowStore.commitTemplates(c, `workflows: ${t.created_by} saved template ${t.id}`);
    });
  }
  async deleteTemplate(id: string, ref: string): Promise<boolean> {
    return this.defsWrite(ref, async (c) => {
      const [r] = await c.query('delete from workflow_templates where id = ?', [id]);
      const gone = Number((r as { affectedRows: number }).affectedRows) > 0;
      if (gone) await WorkflowStore.commitTemplates(c, `workflows: deleted template ${id}`);
      return gone;
    });
  }
  private static async ensureConnectionsTable(c: Connection) {
    await c.query('CREATE TABLE IF NOT EXISTS workflow_connections (tenant VARCHAR(64) NOT NULL, id VARCHAR(40) NOT NULL, metadata JSON NOT NULL, PRIMARY KEY (tenant, id))');
  }
  async listConnections(tenant: string, ref: string): Promise<WorkflowConnection[]> {
    const m = await this.meta(); await m.end();
    return this.defsRead(ref, async c => { const [tables] = await c.query("show tables like 'workflow_connections'"); if (!(tables as unknown[]).length) return []; const [rows] = await c.query('select metadata from workflow_connections where tenant = ? order by id limit 200', [tenant]); return (rows as {metadata: string | WorkflowConnection}[]).map(r => typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata); });
  }
  async getConnection(tenant: string, id: string, ref: string): Promise<WorkflowConnection | null> {
    const m = await this.meta(); await m.end();
    return this.defsRead(ref, async c => { const [tables] = await c.query("show tables like 'workflow_connections'"); if (!(tables as unknown[]).length) return null; const [rows] = await c.query('select metadata from workflow_connections where tenant = ? and id = ?', [tenant, id]); const row = (rows as {metadata: string | WorkflowConnection}[])[0]; return row ? typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata : null; });
  }
  async putConnection(connection: WorkflowConnection, ref: string) {
    const m = await this.meta(); await m.end();
    await this.defsWrite(ref, async c => { await WorkflowStore.ensureConnectionsTable(c); await c.query('insert into workflow_connections (tenant, id, metadata) values (?,?,?) on duplicate key update metadata=values(metadata)', [connection.tenant, connection.id, JSON.stringify(connection)]); await c.query("call dolt_add('workflow_connections')"); await c.query("call dolt_commit('-m', 'workflows: save connection metadata')"); });
  }
  async deleteConnection(tenant: string, id: string, ref: string) {
    const m = await this.meta(); await m.end();
    return this.defsWrite(ref, async c => { const [r] = await c.query('delete from workflow_connections where tenant = ? and id = ?', [tenant, id]); if (!(r as {affectedRows: number}).affectedRows) return false; await c.query("call dolt_add('workflow_connections')"); await c.query("call dolt_commit('-m', 'workflows: remove connection metadata')"); return true; });
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
      await c.query('insert into workflow_definitions (tenant, id, name, description, graph, trigger_json, active, tags, created_by, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?) on duplicate key update name=values(name), description=values(description), graph=values(graph), trigger_json=values(trigger_json), active=values(active), tags=values(tags), updated_at=values(updated_at)', [d.tenant, d.id, d.name, d.description, JSON.stringify(d.graph), d.trigger ? JSON.stringify(d.trigger) : null, d.active ? 1 : 0, JSON.stringify(d.tags ?? []), d.created_by, d.created_at, d.updated_at]);
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
  /** Atomic status transition: the write lands only while the run is in one of the `from` statuses,
   * so a terminal state (cancel/completed/failed) recorded by another writer between a caller's read
   * and this write always wins. Returns true when the transition was applied. */
  async transitionRun(id: string, patch: Partial<Pick<RunRow, 'status' | 'error' | 'branch' | 'finished_at'>>, from: string[]): Promise<boolean> {
    // Serialized per process: every call gets its own connection, and Dolt's snapshot model lets two
    // SIMULTANEOUS statements both match the guarded status (last-writer-wins at commit) - observed as a
    // double-won relaunch claim. Chaining them makes the second read the first's committed state. This
    // matches the deployment model: the engine is in-process, so run control is already per-process.
    const p = this.transitionChain.then(() => this.transitionRunExclusive(id, patch, from));
    this.transitionChain = p.catch(() => undefined);
    return p;
  }
  private transitionChain: Promise<unknown> = Promise.resolve();
  private async transitionRunExclusive(id: string, patch: Partial<Pick<RunRow, 'status' | 'error' | 'branch' | 'finished_at'>>, from: string[]): Promise<boolean> {
    const sets: string[] = [], vals: unknown[] = [];
    for (const k of ['status', 'error', 'branch', 'finished_at'] as const) if (k in patch) { sets.push(`${k} = ?`); vals.push(patch[k] ?? null); }
    if (!sets.length || !from.length) return false;
    vals.push(id, ...from);
    const m = await this.meta();
    try { const [r] = await m.query(`update workflow_runs set ${sets.join(', ')} where id = ? and status in (${from.map(() => '?').join(',')})`, vals); return Number((r as { affectedRows: number }).affectedRows) > 0; } finally { await m.end(); }
  }
  /** Boot-resume failure marker: set ONLY while the run is still resumable and carries no more useful error
   * (a run that turned terminal, or failed for its own reason since the scan, keeps its state untouched). */
  async markResumeFailed(id: string, message: string): Promise<void> {
    const m = await this.meta();
    try { await m.query("update workflow_runs set error = ? where id = ? and status in ('queued','running','waiting') and (error is null or error like 'RESUME_FAILED:%')", [message, id]); } finally { await m.end(); }
  }
  /** Clears the boot-resume marker once a resume actually succeeded. Never touches any other error. */
  async clearResumeFailed(id: string): Promise<void> {
    const m = await this.meta();
    try { await m.query("update workflow_runs set error = null where id = ? and error like 'RESUME_FAILED:%'", [id]); } finally { await m.end(); }
  }
  /** Per-definition run statistics for the list cards (test runs excluded; POC-scale aggregation in JS). */
  async runStats(tenant: string): Promise<Map<string, { runs: number; ok: number; last: RunRow | null }>> {
    const out = new Map<string, { runs: number; ok: number; last: RunRow | null }>();
    for (const r of await this.listRuns(tenant, undefined, 1000)) {
      if (r.test) continue;
      const s = out.get(r.definition_id) ?? { runs: 0, ok: 0, last: null };
      s.runs++; if (r.status === 'completed') s.ok++;
      if (!s.last) s.last = r; // listRuns is started_at desc: the first seen is the latest
      out.set(r.definition_id, s);
    }
    return out;
  }
  async deleteRun(id: string): Promise<void> {
    const m = await this.meta();
    try { await m.query('delete from workflow_steps where run_id = ?', [id]); await m.query('delete from workflow_runs where id = ?', [id]); } finally { await m.end(); }
  }
  private ticketLinksReady?: Promise<void>;
  /** The ticket-link table is created on FIRST WRITE, never at boot. The deploy qualification hashes every Dolt database before and after a restart on a new image: a schema change at boot on a database written by the previous release is an unverified transformation that keeps the front closed. A read of a table that does not exist yet answers "no link". */
  private async ensureTicketLinks(m: Connection): Promise<void> {
    if (!this.ticketLinksReady) this.ticketLinksReady = m.query('CREATE TABLE IF NOT EXISTS workflow_ticket_links (tenant VARCHAR(32) NOT NULL, connection_id VARCHAR(40) NOT NULL, project VARCHAR(20) NOT NULL, issue_key VARCHAR(40) NOT NULL, account VARCHAR(64) NOT NULL, source VARCHAR(20) NOT NULL, spreadsheet_id VARCHAR(80) NOT NULL, sheet_id INT NOT NULL, key_column VARCHAR(60) NOT NULL, key_value VARCHAR(200) NOT NULL, phase1_run VARCHAR(40) NOT NULL, status VARCHAR(10) NOT NULL, claimed_run VARCHAR(40) NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, PRIMARY KEY (tenant, connection_id, project, issue_key))').then(() => undefined).catch((e) => { this.ticketLinksReady = undefined; throw e; });
    await this.ticketLinksReady;
  }
  private static noTable(e: unknown): boolean { const x = e as { code?: string; errno?: number }; return x?.code === 'ER_NO_SUCH_TABLE' || x?.errno === 1146; }
  /** Ticket links: insert once; the same content again is an idempotent retry, different content for the same ticket is refused (never overwritten). */
  async putTicketLink(l: TicketLink): Promise<TicketLinkRow> {
    const m = await this.meta();
    try {
      await this.ensureTicketLinks(m);
      await m.query('insert ignore into workflow_ticket_links (tenant, connection_id, project, issue_key, account, source, spreadsheet_id, sheet_id, key_column, key_value, phase1_run, status, claimed_run, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,null,now(3),now(3))',
        [l.tenant, l.connectionId, l.project, l.issueKey, l.account, l.source, l.spreadsheetId, l.sheetId, l.keyColumn, l.keyValue, l.runId, 'open']);
      const row = await this.ticketLinkOn(m, l);
      if (!row) throw new Error('ticket link not recorded');
      const same = row.account === l.account && row.source === l.source && row.spreadsheet_id === l.spreadsheetId && Number(row.sheet_id) === l.sheetId && row.key_column === l.keyColumn && row.key_value === l.keyValue;
      if (!same) throw new Error('ticket link conflict: this ticket is already linked to another account or row');
      return row;
    } finally { await m.end(); }
  }
  private async ticketLinkOn(m: Connection, k: TicketKey): Promise<TicketLinkRow | null> {
    try {
      const [r] = await m.query('select * from workflow_ticket_links where tenant = ? and connection_id = ? and project = ? and issue_key = ?', [k.tenant, k.connectionId, k.project, k.issueKey]);
      return ((r as TicketLinkRow[])[0]) ?? null;
    } catch (e) { if (WorkflowStore.noTable(e)) return null; throw e; }
  }
  async getTicketLink(k: TicketKey): Promise<TicketLinkRow | null> { const m = await this.meta(); try { return await this.ticketLinkOn(m, k); } finally { await m.end(); } }
  /** One atomic UPDATE: only an open link, or one already claimed by THIS run, can be claimed. Anything else (absent, claimed by another run, done) returns null. */
  async claimTicketLink(k: TicketKey, runId: string): Promise<TicketLinkRow | null> {
    const m = await this.meta();
    try {
      // Dolt answers a concurrent writer with a serialization failure instead of waiting: retry, the loser then sees the row already claimed by the other run and gets nothing.
      let res: unknown;
      for (let attempt = 1; ; attempt++) {
        try {
          [res] = await m.query("update workflow_ticket_links set status = 'claimed', claimed_run = ?, updated_at = now(3) where tenant = ? and connection_id = ? and project = ? and issue_key = ? and (status = 'open' or (status = 'claimed' and claimed_run = ?))", [runId, k.tenant, k.connectionId, k.project, k.issueKey, runId]);
          break;
        } catch (e) {
          if (WorkflowStore.noTable(e)) return null;   // no link was ever written
          const x = e as { code?: string; message?: string };
          if (attempt >= 8 || !(x.code === 'ER_LOCK_DEADLOCK' || /serialization failure/i.test(x.message ?? ''))) throw e;
          await new Promise((r) => setTimeout(r, 20 * attempt));
        }
      }
      if (!Number((res as { affectedRows?: number }).affectedRows)) return null;
      return await this.ticketLinkOn(m, k);
    } finally { await m.end(); }
  }
  async completeTicketLink(k: TicketKey, runId: string): Promise<boolean> {
    const m = await this.meta();
    try {
      let res: unknown;
      try { [res] = await m.query("update workflow_ticket_links set status = 'done', updated_at = now(3) where tenant = ? and connection_id = ? and project = ? and issue_key = ? and status = 'claimed' and claimed_run = ?", [k.tenant, k.connectionId, k.project, k.issueKey, runId]); } catch (e) { if (WorkflowStore.noTable(e)) return false; throw e; }
      return Number((res as { affectedRows?: number }).affectedRows) === 1;
    } finally { await m.end(); }
  }
  /** Small durable key/value store in the meta db (cron last-fire markers). */
  async getMeta(k: string): Promise<string | null> {
    const m = await this.meta();
    try { const [r] = await m.query('select v from workflow_store_meta where k = ?', [k]); const row = (r as Record<string, unknown>[])[0]; return row ? String(row.v) : null; } finally { await m.end(); }
  }
  async setMeta(k: string, v: string): Promise<void> {
    const m = await this.meta();
    try { await m.query('insert into workflow_store_meta (k, v) values (?, ?) on duplicate key update v = values(v)', [k, v]); } finally { await m.end(); }
  }

  /** Runs the engine must (re)kick: queued and running ones, plus waiting ones (a waiting run re-checks its
   *  task and re-parks itself, so boot recovery never loses a wait). */
  async runningRuns(): Promise<RunRow[]> {
    const m = await this.meta();
    try { const [r] = await m.query("select * from workflow_runs where status in ('queued','running','waiting')"); return (r as Record<string, unknown>[]).map(WorkflowStore.run); } finally { await m.end(); }
  }

  private tasksReady?: Promise<void>;
  /** The durable-task table is created on FIRST WRITE, never at boot (same deploy-qualification rule as the
   *  ticket links: no unverified schema change on a database written by a previous release). */
  private async ensureTasks(m: Connection): Promise<void> {
    if (!this.tasksReady) this.tasksReady = m.query('CREATE TABLE IF NOT EXISTS workflow_tasks (id VARCHAR(48) NOT NULL PRIMARY KEY, tenant VARCHAR(32) NOT NULL, kind VARCHAR(32) NOT NULL, title VARCHAR(200) NOT NULL, detail JSON NULL, assignee VARCHAR(64) NOT NULL, delegated_to VARCHAR(64) NULL, status VARCHAR(12) NOT NULL, decision VARCHAR(40) NULL, justification VARCHAR(1000) NULL, decided_by VARCHAR(64) NULL, run_id VARCHAR(40) NULL, node_id VARCHAR(40) NULL, prevent_self BOOLEAN NOT NULL DEFAULT FALSE, created_at DATETIME(3) NOT NULL, due_at DATETIME(3) NULL, reminded_at DATETIME(3) NULL, decided_at DATETIME(3) NULL, KEY wf_tasks_inbox (tenant, assignee, status), KEY wf_tasks_run (run_id))').then(() => undefined).catch((e) => { this.tasksReady = undefined; throw e; });
    await this.tasksReady;
  }
  private static task(r: Record<string, unknown>): TaskRow {
    const detail = typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail;
    return { id: String(r.id), tenant: String(r.tenant), kind: String(r.kind), title: String(r.title), detail: (detail ?? {}) as Record<string, unknown>, assignee: String(r.assignee), delegated_to: r.delegated_to === null ? null : String(r.delegated_to), status: r.status as TaskRow['status'], decision: r.decision === null ? null : String(r.decision), justification: r.justification === null ? null : String(r.justification), decided_by: r.decided_by === null ? null : String(r.decided_by), run_id: r.run_id === null ? null : String(r.run_id), node_id: r.node_id === null ? null : String(r.node_id), prevent_self: !!r.prevent_self, created_at: WorkflowStore.ts(r.created_at), due_at: r.due_at === null ? null : WorkflowStore.ts(r.due_at), reminded_at: r.reminded_at === null ? null : WorkflowStore.ts(r.reminded_at), decided_at: r.decided_at === null ? null : WorkflowStore.ts(r.decided_at) };
  }
  /** Idempotent insert: the same task id again returns the stored row (a retried step never duplicates its task). */
  async putTask(t: TaskRow): Promise<TaskRow> {
    const m = await this.meta();
    try {
      await this.ensureTasks(m);
      await m.query('insert ignore into workflow_tasks (id, tenant, kind, title, detail, assignee, delegated_to, status, decision, justification, decided_by, run_id, node_id, prevent_self, created_at, due_at, reminded_at, decided_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [t.id, t.tenant, t.kind, t.title, JSON.stringify(t.detail ?? {}), t.assignee, t.delegated_to, t.status, t.decision, t.justification, t.decided_by, t.run_id, t.node_id, t.prevent_self ? 1 : 0, t.created_at, t.due_at, t.reminded_at, t.decided_at]);
      const got = await this.getTask(t.id);
      if (!got) throw new Error('task not recorded');
      return got;
    } finally { await m.end(); }
  }
  async getTask(id: string): Promise<TaskRow | null> {
    const m = await this.meta();
    try {
      try { const [r] = await m.query('select * from workflow_tasks where id = ?', [id]); const row = (r as Record<string, unknown>[])[0]; return row ? WorkflowStore.task(row) : null; }
      catch (e) { if (WorkflowStore.noTable(e)) return null; throw e; }
    } finally { await m.end(); }
  }
  async listTasks(tenant: string, f: { assignee?: string; status?: string; runId?: string } = {}): Promise<TaskRow[]> {
    const m = await this.meta();
    try {
      try {
        const where = ['tenant = ?'], vals: unknown[] = [tenant];
        if (f.assignee) { where.push('(assignee = ? or delegated_to = ?)'); vals.push(f.assignee, f.assignee); }
        if (f.status) { where.push('status = ?'); vals.push(f.status); }
        if (f.runId) { where.push('run_id = ?'); vals.push(f.runId); }
        const [r] = await m.query(`select * from workflow_tasks where ${where.join(' and ')} order by created_at desc limit 200`, vals);
        return (r as Record<string, unknown>[]).map(WorkflowStore.task);
      } catch (e) { if (WorkflowStore.noTable(e)) return []; throw e; }
    } finally { await m.end(); }
  }
  /** One atomic decide: only an OPEN task whose current decider is the actor can be decided. */
  async decideTask(id: string, actor: string, decision: string, justification: string | null, at: string): Promise<TaskRow | null> {
    const m = await this.meta();
    try {
      let res: unknown;
      try { [res] = await m.query("update workflow_tasks set status = 'decided', decision = ?, justification = ?, decided_by = ?, decided_at = ? where id = ? and status = 'open' and (assignee = ? or delegated_to = ?)", [decision, justification, actor, at, id, actor, actor]); }
      catch (e) { if (WorkflowStore.noTable(e)) return null; throw e; }
      if (!Number((res as { affectedRows?: number }).affectedRows)) return null;
      return this.getTask(id);
    } finally { await m.end(); }
  }
  /** IGA decisions compare the exact assignment that the caller validated. A concurrent reassignment
   * wins or loses as one SQL write, including admin/pool decisions; no stale-authorization override. */
  async decideReviewTask(t: TaskRow, actor: string, decision: string, justification: string | null, at: string, override: boolean): Promise<TaskRow | null> {
    const m = await this.meta();
    try {
      const [res] = await m.query("update workflow_tasks set status = 'decided', decision = ?, justification = ?, decided_by = ?, decided_at = ? where id = ? and tenant = ? and kind = 'iga-review' and status = 'open' and assignee = ? and coalesce(delegated_to, '') = ? and coalesce(JSON_UNQUOTE(JSON_EXTRACT(detail, '$.reviewAssignmentVersion')), '0') = ? and (? = true or coalesce(delegated_to, assignee) = ?)", [decision, justification, actor, at, t.id, t.tenant, t.assignee, t.delegated_to ?? '', String(t.detail?.reviewAssignmentVersion ?? 0), override, actor]);
      if (!Number((res as { affectedRows?: number }).affectedRows)) return null;
      return this.getTask(t.id);
    } catch (e) { if (WorkflowStore.noTable(e) || WorkflowStore.writeConflict(e)) return null; throw e; }
    finally { await m.end(); }
  }

  /** Change review owner and audit detail together, while preserving due_at/reminded_at/run/item.
   * Replaces assignee, not a second OR-authorized delegate: the former owner loses that authority. */
  async reassignReviewTask(t: TaskRow, target: string, detail: Record<string, unknown>): Promise<TaskRow | null> {
    const m = await this.meta();
    try {
      const [res] = await m.query("update workflow_tasks set assignee = ?, delegated_to = null, detail = ? where id = ? and tenant = ? and kind = 'iga-review' and status = 'open' and assignee = ? and coalesce(delegated_to, '') = ? and coalesce(JSON_UNQUOTE(JSON_EXTRACT(detail, '$.reviewAssignmentVersion')), '0') = ?", [target, JSON.stringify(detail), t.id, t.tenant, t.assignee, t.delegated_to ?? '', String(t.detail?.reviewAssignmentVersion ?? 0)]);
      if (!Number((res as { affectedRows?: number }).affectedRows)) return null;
      return this.getTask(t.id);
    } catch (e) { if (WorkflowStore.noTable(e) || WorkflowStore.writeConflict(e)) return null; throw e; }
    finally { await m.end(); }
  }

  /** Error annotation must not overwrite a concurrent assignment/decision or its audit detail. */
  async patchReviewTaskDetail(t: TaskRow, detail: Record<string, unknown>): Promise<boolean> {
    const m = await this.meta();
    try {
      const [res] = await m.query("update workflow_tasks set detail = ? where id = ? and tenant = ? and kind = 'iga-review' and status = 'open' and assignee = ? and coalesce(delegated_to, '') = ? and coalesce(JSON_UNQUOTE(JSON_EXTRACT(detail, '$.reviewAssignmentVersion')), '0') = ?", [JSON.stringify(detail), t.id, t.tenant, t.assignee, t.delegated_to ?? '', String(t.detail?.reviewAssignmentVersion ?? 0)]);
      return Number((res as { affectedRows?: number }).affectedRows) > 0;
    } catch (e) { if (WorkflowStore.noTable(e) || WorkflowStore.writeConflict(e)) return false; throw e; }
    finally { await m.end(); }
  }

  /** Claims a DECIDED task for one consumer (run:node), atomically at the SQL level: the conditional update succeeds for the first consumer only (proved on real Dolt with concurrent connections, see task-consume-dolt.spec). The same consumer asking again BEFORE the effect was recorded is idempotent (crash retry); once markTaskApplied ran, nobody can claim again, the same consumer included. */
  async consumeTask(id: string, consumer: string): Promise<{ ok: boolean; by: string | null; applied: boolean }> {
    const m = await this.meta();
    try {
      let res: unknown;
      try { [res] = await m.query("update workflow_tasks set detail = JSON_SET(COALESCE(detail, JSON_OBJECT()), '$.consumedBy', ?) where id = ? and status = 'decided' and JSON_EXTRACT(COALESCE(detail, JSON_OBJECT()), '$.consumedBy') is null", [consumer, id]); }
      catch (e) { if (WorkflowStore.noTable(e)) return { ok: false, by: null, applied: false }; if (!WorkflowStore.writeConflict(e)) throw e; res = { affectedRows: 0 }; } // a conflicting committed write by another client: this claim did NOT happen, the re-read below decides
      if (Number((res as { affectedRows?: number }).affectedRows)) return { ok: true, by: consumer, applied: false };
    } finally { await m.end(); }
    const t = await this.getTask(id);
    const by = typeof t?.detail?.consumedBy === 'string' ? t.detail.consumedBy : null;
    const applied = typeof t?.detail?.appliedBy === 'string';
    return { ok: by === consumer && !applied, by, applied };
  }
  /** Records that the effect of the consumer was written (with its revision). Only the consumer that claimed the task can, and only once. */
  async markTaskApplied(id: string, consumer: string, revision: string): Promise<boolean> {
    const m = await this.meta();
    try {
      const [res] = await m.query("update workflow_tasks set detail = JSON_SET(detail, '$.appliedBy', ?, '$.appliedRevision', ?) where id = ? and JSON_UNQUOTE(JSON_EXTRACT(detail, '$.consumedBy')) = ? and JSON_EXTRACT(detail, '$.appliedBy') is null", [consumer, revision, id, consumer]);
      return Number((res as { affectedRows?: number }).affectedRows) > 0;
    } catch (e) { if (WorkflowStore.noTable(e) || WorkflowStore.writeConflict(e)) return false; throw e; }
    finally { await m.end(); }
  }
  /** Dolt reports two clients updating the same row as a serialization failure (errno 1213) instead of a 0-row update: the other write won, ours did not happen. */
  private static writeConflict(e: unknown): boolean { const x = e as { code?: string; errno?: number; message?: string }; return x?.code === 'ER_LOCK_DEADLOCK' || x?.errno === 1213 || /serialization failure/i.test(String(x?.message ?? '')); }
  /** Merges keys into a task's detail JSON (null deletes the key). Used by delegation/escalation to carry the decider pool. */
  async patchTaskDetail(id: string, patch: Record<string, unknown>): Promise<void> {
    const t = await this.getTask(id);
    if (!t) return;
    const detail: Record<string, unknown> = { ...(t.detail ?? {}) };
    for (const [k, v] of Object.entries(patch)) { if (v === null) delete detail[k]; else detail[k] = v; }
    const m = await this.meta();
    try { await m.query('update workflow_tasks set detail = ? where id = ?', [JSON.stringify(detail), id]); }
    catch (e) { if (!WorkflowStore.noTable(e)) throw e; }
    finally { await m.end(); }
  }
  /** Direct children of a run (fanout bound for lyam-start-workflow). */
  async countRunsStartedBy(tenant: string, starter: string): Promise<number> {
    const m = await this.meta();
    try { const [r] = await m.query('select count(*) as n from workflow_runs where tenant = ? and started_by = ?', [tenant, starter]); return Number((r as { n: number }[])[0]?.n ?? 0); }
    finally { await m.end(); }
  }
  /** Admin or system override (self-approval guard checked by the caller, or N/A for system decisions). */
  async decideTaskAs(id: string, actor: string, decision: string, justification: string | null, at: string): Promise<TaskRow | null> {
    const m = await this.meta();
    try {
      let res: unknown;
      try { [res] = await m.query("update workflow_tasks set status = 'decided', decision = ?, justification = ?, decided_by = ?, decided_at = ? where id = ? and status = 'open'", [decision, justification, actor, at, id]); }
      catch (e) { if (WorkflowStore.noTable(e)) return null; throw e; }
      if (!Number((res as { affectedRows?: number }).affectedRows)) return null;
      return this.getTask(id);
    } finally { await m.end(); }
  }
  async delegateTask(id: string, to: string, at: string): Promise<TaskRow | null> {
    const m = await this.meta();
    try {
      let res: unknown;
      try { [res] = await m.query("update workflow_tasks set delegated_to = ?, due_at = ? where id = ? and status = 'open'", [to, at, id]); }
      catch (e) { if (WorkflowStore.noTable(e)) return null; throw e; }
      if (!Number((res as { affectedRows?: number }).affectedRows)) return null;
      return this.getTask(id);
    } finally { await m.end(); }
  }
  async markTaskReminded(id: string, at: string): Promise<void> {
    const m = await this.meta();
    try {
      try { await m.query('update workflow_tasks set reminded_at = ? where id = ?', [at, id]); } catch (e) { if (!WorkflowStore.noTable(e)) throw e; }
    } finally { await m.end(); }
  }
  /** Cancels every open task of a run (the run itself was canceled: its waits must not stay decidable). */
  /** Settle ONE open wait (status canceled, who + why recorded): the audit row survives, no history lost. */
  async settleTask(id: string, actor: string, note: string, at: string): Promise<boolean> {
    const m = await this.meta();
    try {
      const [r] = await m.query("update workflow_tasks set status = 'canceled', decided_by = ?, justification = ?, decided_at = ? where id = ? and status = 'open'", [actor, note, at, id]);
      return Number((r as { affectedRows?: number })?.affectedRows ?? 0) > 0;
    } finally { await m.end(); }
  }

  async cancelTasksForRun(runId: string, at: string): Promise<number> {
    const m = await this.meta();
    try {
      let res: unknown;
      try { [res] = await m.query("update workflow_tasks set status = 'canceled', decided_at = ? where run_id = ? and status = 'open'", [at, runId]); }
      catch (e) { if (WorkflowStore.noTable(e)) return 0; throw e; }
      return Number((res as { affectedRows?: number }).affectedRows);
    } finally { await m.end(); }
  }

  /** IGA recertification campaigns (meta store, lazy-created on first write like workflow_tasks). */
  private igaReady?: Promise<void>;
  private async ensureIga(m: Connection): Promise<void> {
    this.igaReady ??= (async () => {
      await m.query('CREATE TABLE IF NOT EXISTS iga_campaigns (id VARCHAR(48) NOT NULL PRIMARY KEY, tenant VARCHAR(32) NOT NULL, kind VARCHAR(32) NOT NULL, name VARCHAR(120) NOT NULL, ref VARCHAR(80) NOT NULL, status VARCHAR(12) NOT NULL, scope JSON NULL, created_by VARCHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL, closed_by VARCHAR(64) NULL, closed_at DATETIME(3) NULL, evidence JSON NULL, KEY iga_campaigns_tenant (tenant, status))');
      await m.query('CREATE TABLE IF NOT EXISTS iga_items (id VARCHAR(48) NOT NULL PRIMARY KEY, tenant VARCHAR(32) NOT NULL, campaign_id VARCHAR(48) NOT NULL, identity VARCHAR(64) NOT NULL, kind VARCHAR(32) NOT NULL, action VARCHAR(32) NOT NULL, payload JSON NULL, state VARCHAR(24) NOT NULL, decided_by VARCHAR(64) NULL, decided_at DATETIME(3) NULL, decision_reason VARCHAR(1000) NULL, run_id VARCHAR(40) NULL, KEY iga_items_campaign (campaign_id, state))');
    })().catch((e) => { this.igaReady = undefined; throw e; });
    await this.igaReady;
  }
  private static igaJson(v: unknown): Record<string, unknown> { const x = typeof v === 'string' ? JSON.parse(v) : v; return (x ?? {}) as Record<string, unknown>; }
  async igaPutCampaign(c: { id: string; tenant: string; kind: string; name: string; ref: string; status: string; scope: Record<string, unknown>; created_by: string; created_at: string }, items: { id: string; identity: string; kind: string; action: string; payload: Record<string, unknown> }[]): Promise<void> {
    const m = await this.meta();
    try {
      await this.ensureIga(m);
      await m.query('insert into iga_campaigns (id, tenant, kind, name, ref, status, scope, created_by, created_at) values (?,?,?,?,?,?,?,?,?)', [c.id, c.tenant, c.kind, c.name, c.ref, c.status, JSON.stringify(c.scope ?? {}), c.created_by, c.created_at]);
      for (const i of items) await m.query('insert into iga_items (id, tenant, campaign_id, identity, kind, action, payload, state) values (?,?,?,?,?,?,?,?)', [i.id, c.tenant, c.id, i.identity, i.kind, i.action, JSON.stringify(i.payload ?? {}), 'pending']);
    } finally { await m.end(); }
  }
  async igaGetCampaign(tenant: string, id: string): Promise<Record<string, unknown> | null> {
    const m = await this.meta();
    try {
      const [r] = await m.query('select * from iga_campaigns where id = ? and tenant = ?', [id, tenant]);
      const row = (r as Record<string, unknown>[])[0];
      if (!row) return null;
      return { ...row, scope: WorkflowStore.igaJson(row.scope), evidence: row.evidence === null ? null : WorkflowStore.igaJson(row.evidence) };
    } catch (e) { if (WorkflowStore.noTable(e)) return null; throw e; } finally { await m.end(); }
  }
  async igaListCampaigns(tenant: string): Promise<Record<string, unknown>[]> {
    const m = await this.meta();
    try {
      const [r] = await m.query('select id, tenant, kind, name, ref, status, created_by, created_at, closed_by, closed_at from iga_campaigns where tenant = ? order by created_at desc limit 100', [tenant]);
      return r as Record<string, unknown>[];
    } catch (e) { if (WorkflowStore.noTable(e)) return []; throw e; } finally { await m.end(); }
  }
  async igaListItems(tenant: string, campaignId: string, state?: string): Promise<Record<string, unknown>[]> {
    const m = await this.meta();
    try {
      const where = ['campaign_id = ?', 'tenant = ?'], vals: unknown[] = [campaignId, tenant];
      if (state) { where.push('state = ?'); vals.push(state); }
      const [r] = await m.query(`select * from iga_items where ${where.join(' and ')} order by identity limit 500`, vals);
      return (r as Record<string, unknown>[]).map((x) => ({ ...x, payload: WorkflowStore.igaJson(x.payload) }));
    } catch (e) { if (WorkflowStore.noTable(e)) return []; throw e; } finally { await m.end(); }
  }
  async igaUpdateItem(id: string, patch: { state?: string; payload?: Record<string, unknown>; decided_by?: string | null; decided_at?: string | null; decision_reason?: string | null; run_id?: string | null }): Promise<void> {
    const m = await this.meta();
    try {
      const sets: string[] = [], vals: unknown[] = [];
      if (patch.state !== undefined) { sets.push('state = ?'); vals.push(patch.state); }
      if (patch.payload !== undefined) { sets.push('payload = ?'); vals.push(JSON.stringify(patch.payload)); }
      for (const k of ['decided_by', 'decided_at', 'decision_reason', 'run_id'] as const) if (k in patch) { sets.push(`${k} = ?`); vals.push(patch[k] ?? null); }
      if (sets.length) await m.query(`update iga_items set ${sets.join(', ')} where id = ?`, [...vals, id]);
    } finally { await m.end(); }
  }
  async igaCloseCampaign(id: string, actor: string, at: string, evidence: Record<string, unknown>): Promise<boolean> {
    const m = await this.meta();
    try {
      const [r] = await m.query("update iga_campaigns set status = 'closed', closed_by = ?, closed_at = ?, evidence = ? where id = ? and status = 'open'", [actor, at, JSON.stringify(evidence), id]);
      return (r as { affectedRows: number }).affectedRows === 1;
    } finally { await m.end(); }
  }

  /** Every open task past its deadline and not yet reminded, across ALL tenants (the cron scan is
   *  platform-wide: a task's tenant is on its row). */
  /** Every task a campaign opened (its id is in the JSON detail), across the 200-row inbox cap. */
  async listTasksByCampaign(tenant: string, campaignId: string): Promise<TaskRow[]> {
    const m = await this.meta();
    try {
      const [r] = await m.query("select * from workflow_tasks where tenant = ? and json_unquote(json_extract(detail, '$.campaignId')) = ? order by created_at limit 1000", [tenant, campaignId]);
      return (r as Record<string, unknown>[]).map(WorkflowStore.task);
    } catch (e) { if (WorkflowStore.noTable(e)) return []; throw e; } finally { await m.end(); }
  }

  async listDueTasks(at: string): Promise<TaskRow[]> {
    const m = await this.meta();
    try {
      const [r] = await m.query("select * from workflow_tasks where status = 'open' and due_at is not null and due_at <= ? and (reminded_at is null or json_extract(detail, '$.rescan') = true) order by due_at limit 500", [at]);
      return (r as Record<string, unknown>[]).map(WorkflowStore.task);
    } catch (e) { if (WorkflowStore.noTable(e)) return []; throw e; } finally { await m.end(); }
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
