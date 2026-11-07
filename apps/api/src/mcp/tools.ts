import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { PullRequestService } from '../versioning/pull-requests.service.js';
import { UsersService } from '../users/users.service.js';
import { AuditService } from '../access/audit.service.js';
import { McpSessionService, McpSession } from './session.service.js';
import { branchContext } from '../workspace/context.js';
import { SOD_SQL } from '../dolt/dolt.service.js';
import { checkSql, scanSql } from '../versioning/guards.js';
import { ProfileService } from '../profile/profile.service.js';
import { OrgService } from '../profile/orgs.js';
import { RolesService } from '../profile/roles.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { scrub } from '../bus/bus.controller.js';
import { AuthnService } from '../authn/flow.service.js';
import { loadPluginModule } from '../plugins/v1/loader.js';

/**
 * MCP tool surface of the IAM POC. The tools and their confinement live in the `mcp-gateway` plugin folder
 * (`plugins/mcp-gateway/tools.mjs`); this file is the core adapter: it keeps the ToolCtx shape (the per-call
 * services the controller injects), binds the core security primitives the plugin builds on (SQL guards,
 * event scrubber, SoD SQL, branch context) and re-exports the plugin's surface for the controller and the specs.
 */
export interface ToolCtx {
  session: McpSession;
  tenant: string;
  v: VersioningService;
  prs: PullRequestService;
  users: UsersService;
  sessions: McpSessionService;
  audit: AuditService;
  core: string;
  profile: ProfileService;
  orgs: OrgService;
  roles: RolesService;
  wf: WorkflowsService;
  branches: BranchRegistries;
  authn: AuthnService;
}

export type Kind = 'read' | 'write' | 'lifecycle' | 'proxy';
type Run = () => Promise<{ result: unknown; detail: string; targets?: string[]; rowCount?: number | null }>;

interface McpToolsModule {
  bindCoreApi: (api: { checkSql: typeof checkSql; scanSql: typeof scanSql; scrub: typeof scrub; SOD_SQL: string; branchRun: <T>(branch: string, fn: () => Promise<T>) => Promise<T> }) => void;
  ConfinementError: new (...args: never[]) => Error;
  checkMcpSql: (sql: string, mode: 'read' | 'write') => { tables: string[] };
  TOOL_KINDS: Record<string, Kind>;
  guardedWithKind: (ctx: ToolCtx, tool: string, kind: Kind, run: Run, resourceOverride?: string) => Promise<unknown>;
  registerTools: (server: McpServer, ctx: ToolCtx) => void;
}
const plugin = loadPluginModule('mcp-gateway', 'tools.mjs') as McpToolsModule;
plugin.bindCoreApi({ checkSql, scanSql, scrub, SOD_SQL, branchRun: (b, fn) => branchContext.run({ branch: b }, fn) });

/** A refusal by the MCP confinement itself (not by the policy engine): traced as a DENIAL. */
export const ConfinementError = plugin.ConfinementError;
export const checkMcpSql = plugin.checkMcpSql;
export const TOOL_KINDS = plugin.TOOL_KINDS;
export const guardedWithKind = plugin.guardedWithKind;
export const registerTools = plugin.registerTools;
