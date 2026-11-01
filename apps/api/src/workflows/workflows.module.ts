import { Module } from '@nestjs/common';
import { VersioningModule } from '../versioning/versioning.module.js';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { WorkflowsEnabledGuard } from './workflows-enabled.guard.js';
import { WorkflowStore } from './store.js';
import { WorkflowEngine } from './engine.js';
import { WorkflowsService } from './workflows.service.js';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowTriggersService } from './triggers.js';

@Module({ imports: [VersioningModule, PluginsV1Module], controllers: [WorkflowsController], providers: [WorkflowStore, WorkflowEngine, WorkflowsService, WorkflowsEnabledGuard, WorkflowTriggersService] })
export class WorkflowsModule {}
