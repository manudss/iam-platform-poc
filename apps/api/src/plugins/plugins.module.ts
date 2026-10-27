import { Module } from '@nestjs/common';
import { PluginHost } from './plugin-host.service.js';

@Module({ providers: [PluginHost], exports: [PluginHost] })
export class PluginsModule {}
