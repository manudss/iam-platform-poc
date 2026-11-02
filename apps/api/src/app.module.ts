import { WorkspaceModule } from './workspace/workspace.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';
import { UsersModule } from './users/users.module.js';
import { BusModule } from './bus/bus.module.js';
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { ActivationModule } from './activation/activation.module.js';
import { AccessController } from './access/access.controller.js';
import { DoltModule } from './dolt/dolt.module.js';
import { TemporalModule } from './temporal/temporal.module.js';
import { AuditController } from './access/audit.controller.js';
import { AuditService } from './access/audit.service.js';
import { AgentController } from './access/agent.controller.js';
import { PluginsModule } from './plugins/plugins.module.js';
import { VersioningModule } from './versioning/versioning.module.js';
import { PluginsV1Module } from './plugins/v1/plugins-v1.module.js';
import { EventsModule } from './events/events.module.js';

@Module({ imports: [BusModule, EventsModule, WorkspaceModule, WorkflowsModule, UsersModule, DoltModule, VersioningModule, ActivationModule, PluginsModule, PluginsV1Module, TemporalModule], controllers: [HealthController, AccessController, AuditController, AgentController], providers: [AuditService] })
export class AppModule {}
