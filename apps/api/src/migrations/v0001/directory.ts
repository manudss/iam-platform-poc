import type { VersioningService } from '../../versioning/versioning.service.js';
export async function initializeDirectoryV1(v: VersioningService, credentials: () => Promise<Record<string, { salt: string; hash: string; subject?: string }>>, password: (tenant: string, id: string, password: string) => Promise<string>) {
    await v.at('main', async (c) => {
      const [cols] = await c.query('show columns from identities');
      if (!(cols as { Field: string }[]).some(x => x.Field === 'login_enabled')) {
        await c.query('alter table identities add column login_enabled boolean not null default true');
        await c.query("call dolt_add('identities')"); await c.query("call dolt_commit('-m','users: login eligibility')");
      }
      if (!(cols as { Field: string }[]).some(x => x.Field === 'email')) {
        await c.query('alter table identities add column email varchar(254) null');
        await c.query("call dolt_add('identities')"); await c.query("call dolt_commit('-m','users: e-mail address on the profile')");
      }
      if (!(cols as { Field: string }[]).some(x => x.Field === 'credential_revision')) {
        await c.query('alter table identities add column credential_revision varchar(40)');
        const all = await credentials();
        for (const id of ['demo-alice','demo-bob']) {
          const revision = all[id] ? id : await password('acme-demo', id, 'demo-only-not-a-secret');
          await c.query('update identities set credential_revision=? where id=?',[revision,id]);
        }
        await c.query("call dolt_add('identities')"); await c.query("call dolt_commit('-m','users: credential revision references (no secrets)')");
      }
    });
}
