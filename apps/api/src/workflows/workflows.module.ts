import { Module } from '@nestjs/common';
import { VersioningModule } from '../versioning/versioning.module.js';
import { WorkflowStore } from './store.js';
import { WorkflowEngine } from './engine.js';
import { WorkflowsService } from './workflows.service.js';
import { WorkflowsController } from './workflows.controller.js';

@Module({ imports: [VersioningModule], controllers: [WorkflowsController], providers: [WorkflowStore, WorkflowEngine, WorkflowsService] })
export class WorkflowsModule {}
