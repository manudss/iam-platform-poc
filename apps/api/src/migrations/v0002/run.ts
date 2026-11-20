import type { INestApplication } from '@nestjs/common';
import { VersioningService } from '../../versioning/versioning.service.js';
import { ACCOUNT_BLOCKS_RULE } from './rule.js';

export const RULE_ID = 'screen-account-blocks';
export type Outcome = 'added' | 'already-present' | 'customised' | 'no-policy-set';

/**
 * Decides what to do from the rows of `policy_rules` alone (pure, tested without a database).
 * Never replaces a rule: a tenant that already has this id, or that wrote its own rule for the screen, keeps its choice.
 */
export function planAccountBlocksRule(rows: { set_name: string; id: string; cedar: string }[]): Outcome {
  if (rows.some((r) => r.id === RULE_ID)) return 'already-present';
  if (rows.some((r) => r.cedar.includes('Screen::"account-blocks"'))) return 'customised';
  if (!rows.some((r) => r.set_name === 'default')) return 'no-policy-set';
  return 'added';
}

/**
 * Version 0002: gives existing tenants the Cedar rule that opens the account-blocks screen (managers and administrators).
 * It writes ONE new row on main and commits only that table. It does not activate anything: the live permission engine
 * keeps its current rules until the next Review & Apply, which then shows the rule as a normal pending policy change.
 */
export function accountBlocksRuleMigration(app: INestApplication) { return {
  id: '0002',
  /** Everything that can be refused is checked before the journal marks the migration as started, so a refusal leaves the data and the journal untouched. */
  preflight: async () => {
    const v = app.get(VersioningService, { strict: false });
    await v.at('main', async (c) => {
      const [dirty] = await c.query("select count(*) n from dolt_status where table_name='policy_rules'");
      if (Number((dirty as { n: number }[])[0].n)) throw new Error('policy_rules has uncommitted changes on main; nothing was changed. Commit or discard them, then start again');
      await c.query('select set_name, id, cedar from policy_rules limit 1');
    });
  },
  run: async () => {
    const v = app.get(VersioningService, { strict: false });
    await v.lock(() => v.at('main', async (c) => {
      const [dirty] = await c.query("select count(*) n from dolt_status where table_name='policy_rules'");
      if (Number((dirty as { n: number }[])[0].n)) throw new Error('policy_rules has uncommitted changes on main; refusing to mix them into a migration commit');
      const [rows] = await c.query('select set_name, id, cedar from policy_rules');
      if (planAccountBlocksRule(rows as never) !== 'added') return;
      await c.query('insert into policy_rules (set_name, id, cedar) values (?,?,?)', ['default', RULE_ID, ACCOUNT_BLOCKS_RULE]);
      await c.query("call dolt_add('policy_rules')");
      await c.query("call dolt_commit('-m', ?)", ['migration 0002: policy rule default/screen-account-blocks (pending Review & Apply)']);
    }));
  },
  verify: async () => {
    const v = app.get(VersioningService, { strict: false });
    await v.at('main', async (c) => {
      const [rows] = await c.query('select set_name, id, cedar from policy_rules');
      const outcome = planAccountBlocksRule(rows as never);
      if (outcome === 'added') throw new Error('account-blocks rule still missing after migration 0002');
    });
  },
}; }
