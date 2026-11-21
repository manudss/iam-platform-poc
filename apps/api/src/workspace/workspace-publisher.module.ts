import { Module } from '@nestjs/common';
import { ActivationModule } from '../activation/activation.module.js';
import { VersioningModule } from '../versioning/versioning.module.js';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { WorkspacePublisher } from './workspace-publisher.js';

/**
 * Only the checked publication path, with ONE shared instance (one serialization queue) for the Apply endpoint and the workflow block.
 * Kept apart from WorkspaceModule on purpose: importing WorkspaceModule installs the human PR publisher hook (MainPublication) and the
 * workspace controllers, which a workflow engine must not pull in.
 */
@Module({ imports: [ActivationModule, VersioningModule, PluginsV1Module], providers: [WorkspacePublisher], exports: [WorkspacePublisher] })
export class WorkspacePublisherModule {}
