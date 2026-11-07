import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { z } = require('zod');
import { createHash } from 'node:crypto';
import { guardedWithKind } from './tools.mjs';
/**
 * MCP gateway relay (P1): tools of admin-registered external MCP servers are exposed to the agent as
 * `<upstream>__<tool>`, next to the local tools. Enforced server-side:
 *  - the agent never chooses the target URL: upstreams come from the registry only (SSRF protection);
 *  - no token passthrough (MCP spec): the relay authenticates upstream with the registry token, the agent's
 *    session secret never leaves the platform and the upstream token never reaches the agent;
 *  - every call is authorized by the same Cedar engine (Action::"mcp:proxy", role mcp-operator on the ACTIVE
 *    version) and traced in mcp_activity with the arguments HASHED (sha256 prefix), never in clear;
 *  - upstream descriptions are served prefixed with `[relay -> <name>]`: they are UNTRUSTED content (tool
 *    description injection is the top MCP risk; pinning/rewriting is a later increment);
 *  - P2 (delegation grants): tools/list only shows tools the session owner's ACTIVE grants cover, and every
 *    call is re-authorized against `UpstreamTool::"<name>__<tool>"` - Cedar requires the mcp-operator role AND
 *    an unexpired versioned grant for that exact tool. A grant written on an unmerged branch changes nothing.
 */
/** MCP tool names: [a-zA-Z0-9_-]{1,64}. Upstream names are slugs; the upstream tool part is sanitized. */
export function relayedName(upstream, tool, taken) {
    const clean = tool.replace(/[^a-zA-Z0-9_-]/g, '_');
    const base = `${upstream}__${clean}`.slice(0, 64);
    for (const candidate of [base, `${base.slice(0, 61)}-2`, `${base.slice(0, 61)}-3`]) {
        if (!taken.has(candidate)) {
            taken.add(candidate);
            return candidate;
        }
    }
    return null;
}
/** Best-effort JSON Schema -> zod shape for tools/list fidelity. Complex constructs degrade to z.unknown(). */
export function jsonSchemaToZodShape(schema) {
    const s = schema;
    if (!s || typeof s !== 'object' || !s.properties || typeof s.properties !== 'object')
        return undefined;
    const required = new Set(Array.isArray(s.required) ? s.required : []);
    const shape = {};
    for (const [key, raw] of Object.entries(s.properties).slice(0, 40)) {
        const p = raw ?? {};
        let t;
        if (Array.isArray(p.enum) && p.enum.length && p.enum.every((v) => typeof v === 'string') && p.enum.length <= 20)
            t = z.enum(p.enum);
        else
            switch (p.type) {
                case 'string':
                    t = z.string();
                    break;
                case 'number':
                case 'integer':
                    t = z.number();
                    break;
                case 'boolean':
                    t = z.boolean();
                    break;
                case 'array':
                    t = z.array(z.unknown());
                    break;
                case 'object':
                    t = z.record(z.string(), z.unknown());
                    break;
                default: t = z.unknown();
            }
        if (typeof p.description === 'string')
            t = t.describe(p.description.slice(0, 500));
        shape[key.slice(0, 64)] = required.has(key) ? t : t.optional();
    }
    return shape;
}
const argsHash = (args) => createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex').slice(0, 12);
const hostOf = (url) => { try {
    return new URL(url).host;
}
catch {
    return url;
} };
export async function registerProxyTools(server, ctx, upstreams, grants) {
    let enabled = [];
    try {
        enabled = await upstreams.enabled(ctx.tenant);
    }
    catch {
        return;
    } // registry down: local tools still served
    // P2: the allowlist comes from the ACTIVE version only (same source the Cedar check enforces).
    const allowed = await grants.allowedTools(ctx.tenant, ctx.session.owner).catch(() => new Set());
    const taken = new Set();
    for (const up of enabled) {
        let tools = [];
        try {
            tools = await upstreams.listTools(ctx.tenant, up.id);
        }
        catch {
            continue;
        } // unreachable upstream: its tools simply do not appear
        for (const tool of tools) {
            if (!allowed.has(`${up.name}__${tool.name}`))
                continue; // no active grant: the tool is not even listed
            const exposed = relayedName(up.name, tool.name, taken);
            if (!exposed)
                continue;
            const inputSchema = jsonSchemaToZodShape(tool.inputSchema);
            const description = `[relay -> ${up.name}] ${tool.description ?? '(no description)'}`.slice(0, 1000);
            server.registerTool(exposed, { description, ...(inputSchema ? { inputSchema } : {}) }, (args) => guardedWithKind(ctx, exposed, 'proxy', async () => {
                const started = Date.now();
                const result = await upstreams.callTool(ctx.tenant, up.id, tool.name, args);
                const detail = `relay ${up.name}.${tool.name} -> ok in ${Date.now() - started}ms (args sha256:${argsHash(args)})`;
                return { result: result ?? null, detail, targets: [hostOf(up.url)] };
            }, `UpstreamTool::"${exposed}"`));
        }
    }
}
