import { WorkspaceModule } from './workspace/workspace.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';
import { UsersModule } from './users/users.module.js';
import { BusModule } from './bus/bus.module.js';
import { Module } from '@nestjs/common';
import { AppEvent, ApplicationBus, APP_EVENT_KINDS } from './events/application-bus.service.js';
import { HealthController } from './health.controller.js';
import { ActivationModule } from './activation/activation.module.js';
import { AccessController } from './access/access.controller.js';
import { DoltModule } from './dolt/dolt.module.js';
import { TemporalModule } from './temporal/temporal.module.js';
import { AuditController } from './access/audit.controller.js';
import { AuditService } from './access/audit.service.js';
import { AgentController } from './access/agent.controller.js';
import { VersioningModule } from './versioning/versioning.module.js';
import { PluginsV1Module } from './plugins/v1/plugins-v1.module.js';
import { EventsModule } from './events/events.module.js';
import { McpController, McpSessionsController, McpUpstreamsController, McpGrantsController } from './mcp/mcp.controller.js';
import { McpUpstreamService } from './mcp/upstream.service.js';
import { McpGrantsService } from './mcp/grants.service.js';
import { McpSessionService } from './mcp/session.service.js';
import { CorePolicySource, POLICY_SOURCE, PolicyStudioController, PolicyStudioService } from './policies/policy-studio.js';

@Module({ imports: [BusModule, EventsModule, WorkspaceModule, WorkflowsModule, UsersModule, DoltModule, VersioningModule, ActivationModule, PluginsV1Module, TemporalModule], controllers: [HealthController, AccessController, AuditController, AgentController, McpController, McpSessionsController, McpUpstreamsController, McpGrantsController, PolicyStudioController], providers: [AuditService, McpSessionService, McpUpstreamService, McpGrantsService, PolicyStudioService, { provide: POLICY_SOURCE, useClass: CorePolicySource }] })
export class AppModule {
  /** SSO events (sign-in allowed, refused, tokens issued) go to the decision audit: who, which application, when. No claim values, no tokens. */
  constructor(events: ApplicationBus, audit: AuditService) {
    const record = (e: AppEvent) => {
      if (!e.type.startsWith('sso.')) return;
      return audit.record({ tenant: e.tenant, subject: e.payload.subject ?? '', principal: e.payload.subject ?? '', action: e.type, resource: `app:${e.payload.app ?? ''}`, allow: e.type === 'sso.login.succeeded' || e.type === 'sso.token.issued', reasons: e.payload.reason ? [e.payload.reason] : [], activation_seq: null, commit: null, source: 'http' });
    };
    // Step 3: over the bus, the SSO audit trail consumes its own durable address (at-least-once).
    events.consumeOnBus('audit-trail', APP_EVENT_KINDS.filter((k) => k.startsWith('sso.')), record);
  }
}
