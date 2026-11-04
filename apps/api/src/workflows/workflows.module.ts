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
import { WorkflowDemoSeed } from './demo-seed.js';

@Module({ imports: [EventsModule, VersioningModule, PluginsV1Module], controllers: [WorkflowsController], providers: [WorkflowStore, WorkflowEngine, WorkflowsService, WorkflowsEnabledGuard, WorkflowTriggersService, WorkflowDemoSeed], exports: [WorkflowsService] })
export class WorkflowsModule {}
