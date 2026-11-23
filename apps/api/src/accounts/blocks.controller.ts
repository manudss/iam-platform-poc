import { Body, Controller, Delete, Get, Optional, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthGuard, assertNotBranchTest } from '../auth/auth.guard.js';
import { AuthnService } from '../authn/flow.service.js';
import { ApplicationBus } from '../events/application-bus.service.js';
import { BlocksService, MANUAL_KINDS, MESSAGE_MAX } from './blocks.service.js';
import { BLOCK_LABEL, blockReference } from './blocks.js';
import { AppConnectorService } from '../connectors/app-connector.js';
import { DEFAULT_SECURITY } from './security-config.js';

/**
 * Account blocks (suspended, disabled, locked, waiting for approval) set and lifted by people.
 * The guard is the admin guard: with screen access on, the policy engine asks for the screen `account-blocks`, a right of its own that roles
 * carry or not (demo policy: administrators and managers). Blocks are operational state, never written from a branch-test session.
 */
@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant')
export class AccountBlocksController {
  private readonly svc: BlocksService;
  constructor(private readonly authn: AuthnService, @Optional() events?: ApplicationBus, @Optional() private readonly apps?: AppConnectorService) {
    this.svc = new BlocksService(authn.blocks, (e) => events?.emit({ ...e, branch: 'main' } as never));
  }
  private admins = () => (process.env.IAM_API_ADMIN_SUBJECTS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  private sub = (req: { user?: { sub?: string } }) => String(req.user?.sub ?? '');

  @Get('account-blocks') async list(@Param('tenant') t: string) {
    return { asOf: Date.now(), kinds: MANUAL_KINDS, labels: BLOCK_LABEL, messageMax: MESSAGE_MAX, accounts: (await this.svc.list(t)).map((a) => ({ ...a, blocks: a.blocks.map((b) => ({ ...b, reference: blockReference(b) })) })) };
  }
  @Post('accounts/:subject/blocks') async block(@Param('tenant') t: string, @Param('subject') subject: string, @Req() req: any, @Body() b: { kind?: string; message?: string; until?: number; hold?: boolean }) {
    assertNotBranchTest(req);
    return { block: await this.svc.block({ tenant: t, actor: this.sub(req), subject, kind: String(b?.kind ?? ''), message: String(b?.message ?? ''), until: b?.until, hold: b?.hold === true, admins: this.admins() }) };
  }
  @Delete('accounts/:subject/blocks/:id') async unblock(@Param('tenant') t: string, @Param('subject') subject: string, @Param('id') id: string, @Req() req: any) {
    assertNotBranchTest(req);
    await this.svc.unblock({ tenant: t, actor: this.sub(req), subject, blockId: id });
    return { lifted: true };
  }
  /** Lockout and administration-level settings, versioned (edited on a working branch, live after Apply). */
  @Get('security') async settings(@Param('tenant') t: string) { return { tenant: t, working: await this.authn.workingSecurity(t), live: await this.authn.liveSecurity(t), defaults: DEFAULT_SECURITY }; }
  @Put('security') async put(@Param('tenant') t: string, @Body() b: { config?: unknown }, @Req() req: any) { assertNotBranchTest(req); return { saved: true, config: await this.authn.saveSecurity(t, b?.config, { sub: this.sub(req), level: Number(req.user?.auth_level ?? 0) }) }; }
  /** One application's minimum level, written from the application edit form (same guard and branch rules as PUT security). */
  @Put('security/app-level/:appId') async putAppLevel(@Param('tenant') t: string, @Param('appId') appId: string, @Body() b: { level?: unknown }, @Req() req: any) { assertNotBranchTest(req); if (typeof b?.level === 'number' && b.level > 0 && this.apps) await this.apps.get(t, appId); return { saved: true, config: await this.authn.saveAppLevel(t, appId, b?.level) }; }
  /** Drops everything stored for a deleted application. */
  @Delete('security/app-level/:appId') async deleteAppLevel(@Param('tenant') t: string, @Param('appId') appId: string, @Req() req: any) { assertNotBranchTest(req); return { saved: true, config: await this.authn.clearAppLevel(t, appId) }; }
}


