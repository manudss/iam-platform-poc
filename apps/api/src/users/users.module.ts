import { Module } from '@nestjs/common';
import { VersioningModule } from '../versioning/versioning.module.js';
import { UsersService } from './users.service.js';
import { UsersController } from './users.controller.js';
@Module({ imports: [VersioningModule], providers: [UsersService], controllers: [UsersController], exports: [UsersService] })
export class UsersModule {}
