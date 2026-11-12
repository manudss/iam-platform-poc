import { IntegrationsModule } from '../integrations/integrations.module.js';
import { WorkflowConnections } from './connections.js';
import { WorkflowConnectionsController } from './connections.controller.js';
import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { VersioningModule } from '../versioning/versioning.module.js';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { WorkflowsEnabledGuard } from './workflows-enabled.guard.js';
import { WorkflowStore } from './store.js';
import { WorkflowEngine } from './engine.js';
import { WorkflowsService } from './workflows.service.js';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowTriggersService } from './triggers.js';
import { WorkflowHooksController } from './hooks.controller.js';
import { WorkflowSheetPollerService } from './sheet-poller.js';
import { WorkflowCronService } from './cron.js';
import { WorkflowDemoSeed } from './demo-seed.js';

@Module({ imports: [IntegrationsModule, EventsModule, VersioningModule, PluginsV1Module], controllers: [WorkflowConnectionsController, WorkflowsController, WorkflowHooksController], providers: [WorkflowConnections, WorkflowStore, WorkflowEngine, WorkflowsService, WorkflowsEnabledGuard, WorkflowTriggersService, WorkflowDemoSeed, WorkflowSheetPollerService, WorkflowCronService], exports: [WorkflowsService] })
export class WorkflowsModule {}
