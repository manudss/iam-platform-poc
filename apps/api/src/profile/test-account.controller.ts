import { BadRequestException, Body, Controller, ForbiddenException, Optional, Param, Post } from '@nestjs/common';
import { BranchTestService, branchTestEnabled } from '../workspace/branch-test.js';
import { branchContext } from '../workspace/context.js';
import { UsersService } from '../users/users.service.js';

/** Test accounts are always named test-<something>: they can never be mistaken for, or collide with, a real person's id. */
export const TEST_ACCOUNT_ID = /^test-[a-z0-9][a-z0-9-]{1,38}$/;
const TEST_ACCOUNT_CAP = 20;

/**
 * Test account (docs/branch-test.md): the ONE sign-up that works from a branch test. The test ticket of the branch bar is the only authorization:
 * the account is created on that branch only (never on main), named test-*, with no role, no e-mail confirmation and no admin approval,
 * and it vanishes with the branch. The regular sign-up routes keep refusing branch-test tokens; this route never accepts a token, only a ticket.
 */
@Controller('tenants/:tenant/signup/test')
export class TestAccountController {
  private readonly count = new Map<string, number>();
  constructor(@Optional() private readonly branchTest?: BranchTestService, @Optional() private readonly users?: UsersService) {}
  @Post() async create(@Param('tenant') t: string, @Body() b: { branch?: unknown; ticket?: unknown; id?: unknown; display_name?: unknown; password?: unknown }) {
    if (!branchTestEnabled() || !this.users) throw new ForbiddenException('test accounts need a branch test');
    if (typeof b?.branch !== 'string' || !(await this.branchTest?.check(b.ticket, b.branch))) throw new ForbiddenException('a test account needs the ticket of a test link from the branch bar');
    if (b.branch === 'main') throw new ForbiddenException('never on main');
    const id = typeof b.id === 'string' ? b.id.trim() : '', name = typeof b.display_name === 'string' ? b.display_name.trim() : '', password = typeof b.password === 'string' ? b.password : '';
    if (!TEST_ACCOUNT_ID.test(id)) throw new BadRequestException('the id of a test account starts with "test-" (letters, digits and dashes, 7 to 40 characters)');
    if (!name || name.length > 80) throw new BadRequestException('a display name is required (80 characters at most)');
    const key = String(b.ticket), n = this.count.get(key) ?? 0;
    if (n >= TEST_ACCOUNT_CAP) throw new BadRequestException('this test link already created its maximum of test accounts');
    const branch = b.branch;
    const user = await branchContext.run({ branch }, () => this.users!.save(id, { id, display_name: name, login_enabled: true, password }, true, undefined, t));
    this.count.set(key, n + 1);
    return { created: true, branch, user, note: `Test account created on the branch "${branch}" only, with no role. Sign in with it here; it is not on main.` };
  }
}
