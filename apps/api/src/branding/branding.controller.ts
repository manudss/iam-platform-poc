import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BrandingService, type BrandingBundle } from './branding.service.js';
import { BranchTestService } from '../workspace/branch-test.js';
import { branchName } from '../versioning/guards.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { currentBranch } from '../workspace/context.js';

@Controller('tenants/:tenant/branding')
export class BrandingController {
  constructor(private readonly branding: BrandingService, private readonly tickets: BranchTestService) {}
  private async read(t: string, branch?: string, ticket?: string) {
    if (!/^[a-z0-9-]{1,32}$/.test(t)) throw new BadRequestException('invalid tenant');
    if (branch) {
      branchName(branch);
      if (branch === 'main' || !await this.tickets.check(ticket,branch)) throw new ForbiddenException('A matching branch-test ticket is required');
    }
    return this.branding.get(t, branch || 'main');
  }
  private headers(res: Response, b: BrandingBundle, branch?: string) {
    res.setHeader('Cache-Control', branch ? 'no-store' : 'public, max-age=0, must-revalidate');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('ETag', `"${b.version}"`);
  }
  @Get() async profile(@Param('tenant') t: string, @Query('branch') branch: string, @Query('ticket') ticket: string, @Res({passthrough:true}) res: Response) {
    const b = await this.read(t,branch,ticket); this.headers(res,b,branch);
    // Only deliberately public branding. No plugin registry, credentials or other settings.
    const { productName, baseline, footer } = b.config;
    return { productName, baseline, footer, version:b.version };
  }
  @Get('theme.css') async css(@Param('tenant') t: string, @Query('branch') branch: string, @Query('ticket') ticket: string, @Req() req: Request, @Res() res: Response) {
    const b = await this.read(t,branch,ticket); this.headers(res,b,branch);
    if (!branch && req.headers['if-none-match'] === `"${b.version}"`) return res.status(304).end();
    return res.type('text/css').send(b.css);
  }
  /** Authenticated console snapshot of the selected working branch. Never public/cacheable. */
  @UseGuards(AuthGuard,AdminGuard) @Get('draft') async draft(@Param('tenant') t: string, @Res({passthrough:true}) res: Response) {
    res.setHeader('Cache-Control','no-store');
    if (!/^[a-z0-9-]{1,32}$/.test(t)) throw new BadRequestException('invalid tenant');
    return this.branding.get(t,currentBranch());
  }
  @Get(':asset') async asset(@Param('tenant') t: string, @Param('asset') asset: string, @Query('branch') branch: string, @Query('ticket') ticket: string, @Res() res: Response) {
    if (!['logo-horizontal-light.svg','logo-horizontal-dark.svg','symbol.svg','favicon.svg'].includes(asset)) throw new BadRequestException('Unknown branding asset');
    const b = await this.read(t,branch,ticket); this.headers(res,b,branch);
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'none'; sandbox");
    return res.type('image/svg+xml').send(b.logos[asset]);
  }
  @UseGuards(AuthGuard,AdminGuard) @Post('preview') async preview(@Param('tenant') t: string, @Body() input: Record<string,unknown>, @Res({passthrough:true}) res: Response) {
    res.setHeader('Cache-Control','no-store');
    return this.branding.preview(t,input,currentBranch());
  }
}
