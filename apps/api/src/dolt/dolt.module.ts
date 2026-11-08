import { VersioningModule } from '../versioning/versioning.module.js';
import { Module } from '@nestjs/common';
import { ChangesController } from './changes.controller.js';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { DoltService } from './dolt.service.js';

@Module({ imports: [VersioningModule, PluginsV1Module], controllers: [ChangesController], providers: [DoltService], exports: [DoltService] })
export class DoltModule {}
