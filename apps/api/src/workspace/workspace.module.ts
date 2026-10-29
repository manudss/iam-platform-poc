import {ActivationModule}from'../activation/activation.module.js';
import {Module}from'@nestjs/common';import{VersioningModule}from'../versioning/versioning.module.js';import{PluginsV1Module}from'../plugins/v1/plugins-v1.module.js';import{WorkspaceController}from'./workspace.controller.js';
@Module({imports:[ActivationModule,VersioningModule,PluginsV1Module],controllers:[WorkspaceController]})export class WorkspaceModule{}
