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
import { WorkflowJiraDonePollerService } from './jira-done-poller.js';
import { WorkflowCronService } from './cron.js';
import { WorkflowTasksService } from './tasks.js';
import { WorkflowTasksController } from './tasks.controller.js';
import { WorkflowReads } from './reads.js';
import { WorkflowsIgaService } from './iga.service.js';
import { WorkspacePublisherModule } from '../workspace/workspace-publisher.module.js';
import { UsersModule } from '../users/users.module.js';
import { WorkflowDemoSeed } from './demo-seed.js';

@Module({ imports: [IntegrationsModule, EventsModule, VersioningModule, PluginsV1Module, WorkspacePublisherModule, UsersModule], controllers: [WorkflowConnectionsController, WorkflowsController, WorkflowHooksController, WorkflowTasksController], providers: [WorkflowConnections, WorkflowStore, WorkflowEngine, WorkflowsService, WorkflowTasksService, WorkflowReads, WorkflowsIgaService, WorkflowsEnabledGuard, WorkflowTriggersService, WorkflowDemoSeed, WorkflowSheetPollerService, WorkflowJiraDonePollerService, WorkflowCronService], exports: [WorkflowsService] })
export class WorkflowsModule {}
