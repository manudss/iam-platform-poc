import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { McpUpstreamService, McpUpstream } from './upstream.service.js';
import { McpGrantsService } from './grants.service.js';
import './tools.js'; // side effect: binds the core security primitives the plugin tools build on
import { ToolCtx } from './tools.js';
import { loadPluginModule } from '../plugins/v1/loader.js';

/**
 * MCP proxy relay: the naming and schema rules live in the `mcp-gateway` plugin folder
 * (`plugins/mcp-gateway/proxy.mjs`); this core adapter re-exports them for the controller and the specs.
 */
interface McpProxyModule {
  relayedName: (upstream: string, tool: string, taken: Set<string>) => string | null;
  jsonSchemaToZodShape: (schema: unknown) => Record<string, z.ZodTypeAny> | undefined;
  registerProxyTools: (server: McpServer, ctx: ToolCtx, upstreams: McpUpstreamService, grants: McpGrantsService) => Promise<void>;
}
const plugin = loadPluginModule('mcp-gateway', 'proxy.mjs') as McpProxyModule;

export const relayedName = plugin.relayedName;
export const jsonSchemaToZodShape = plugin.jsonSchemaToZodShape;
export const registerProxyTools = plugin.registerProxyTools;

// Referenced only for the adapter's types.
export type { McpUpstream };
