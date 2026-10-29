import { BadRequestException, Body, Controller, Get, Param, Patch, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { ProfileService } from './profile.service.js';
import { Context } from './fields.js';

/** Profile fields: definitions come from the base and from plugins; the admin configures them; people edit their values. Writes of configuration need the admin capability and a working branch. */
@UseGuards(AuthGuard)
@Controller('tenants/:tenant')
export class ProfileController {
  constructor(private readonly p: ProfileService) {}

  @Get('profile-fields') async fields(@Param('tenant') t: string) {
    const [wc, lc, wcat, lcat] = [await this.p.config(t, 'work'), await this.p.config(t, 'live'), await this.p.catalogue(t, 'work'), await this.p.catalogue(t, 'live')];
    return { tenant: t, catalogue: wcat, working: { config: wc }, live: { config: lc, catalogue: lcat } };
  }
  @UseGuards(AdminGuard) @Put('profile-fields') async put(@Param('tenant') t: string, @Body() b: { config?: unknown }) { return { saved: true, config: await this.p.saveConfig(t, b?.config) }; }
  @Get('profile-schema') async schema(@Param('tenant') t: string, @Query('context') c: string, @Query('ref') ref?: string) {
    if (!['signup', 'self', 'admin'].includes(c)) throw new BadRequestException('context: signup, self or admin');
    return { context: c, fields: await this.p.schema(t, c as Context, ref === 'work' ? 'work' : 'live') };
  }
  /** The subject is the token's, never a value from the request. */
  @Get('me/profile') me(@Param('tenant') t: string, @Req() req: { user: { sub: string } }) { return this.p.self(t, req.user.sub); }
  @Patch('me/profile') patchMe(@Param('tenant') t: string, @Req() req: { user: { sub: string } }, @Body() b: unknown) { return this.p.patchSelf(t, req.user.sub, b); }
  @UseGuards(AdminGuard) @Get('users/:id/profile') user(@Param('tenant') t: string, @Param('id') id: string) { return this.p.admin(t, id); }
  @UseGuards(AdminGuard) @Patch('users/:id/profile') patchUser(@Param('tenant') t: string, @Param('id') id: string, @Req() req: { user: { sub: string } }, @Body() b: unknown) { return this.p.patchAdmin(t, id, b, req.user.sub); }
}
