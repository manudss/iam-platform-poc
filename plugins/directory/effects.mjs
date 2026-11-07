import { assertLoopback } from './loopback.mjs';
/** Role diff between two activated data versions -> (a) local fictional notification, (b) outbound provisioning to a local demo target. */
export function diff(prev, cur) {
    const k = (a) => `${a.identity_id}\u0000${a.role_id}`;
    const p = new Set((prev?.assignments ?? []).map(k)), c = new Set(cur.assignments.map(k));
    const out = [];
    for (const a of cur.assignments)
        if (!p.has(k(a)))
            out.push({ subject: a.identity_id, role: a.role_id, change: 'granted' });
    for (const a of prev?.assignments ?? [])
        if (!c.has(k(a)))
            out.push({ subject: a.identity_id, role: a.role_id, change: 'revoked' });
    return out.sort((x, y) => `${x.subject}${x.role}${x.change}`.localeCompare(`${y.subject}${y.role}${y.change}`));
}
export class ActivationEffects {
    d;
    constructor(d) {
        this.d = d;
    }
    async once(kind, e, c, run) {
        const key = `${e.tenant}:${e.seq}:${kind}:${c.subject}:${c.role}:${c.change}`;
        if ((await this.d.store.get(key))?.state === 'done')
            return undefined;
        try {
            await run(key);
            await this.d.store.mark({ effectKey: key, kind, tenant: e.tenant, seq: e.seq, state: 'done' });
            return undefined;
        }
        catch (err) {
            const m = err.message.slice(0, 200);
            await this.d.store.mark({ effectKey: key, kind, tenant: e.tenant, seq: e.seq, state: 'failed', lastError: m });
            return `${key}: ${m}`;
        }
    }
    /** Runs every effect of one activation. Throws if any failed (the NATS consumer then rolls back and the event is redelivered = retry). */
    async handle(e) {
        const prevCommit = await this.d.previousCommit(e.tenant, e.seq);
        const changes = diff(prevCommit ? await this.d.snapshotAt(prevCommit) : undefined, await this.d.snapshotAt(e.commit));
        const failed = [];
        const t = this.d.timeoutMs ?? 3000;
        for (const c of changes) {
            if (this.d.pluginNotify) {
                const key = `${e.tenant}:${e.seq}:plugin-notify:${c.subject}:${c.role}:${c.change}`;
                await this.d.pluginNotify(e.tenant, { effectKey: key, to: `manager-of:${c.subject}`, template: 'role.changed', data: { subject: c.subject, role: c.role, change: c.change, activation: e.seq } }).catch((err) => console.warn(`[effects] plugin notify failed: ${err.message}`));
            }
            if (this.d.notifySinkUrl) {
                const f = await this.once('notify', e, c, async (key) => {
                    const base = assertLoopback(this.d.notifySinkUrl);
                    const r = await fetch(new URL('/notify', base), { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, signal: AbortSignal.timeout(t),
                        body: JSON.stringify({ type: 'role.changed', tenant: e.tenant, activation: e.seq, commit: e.commit, subject: c.subject, role: c.role, change: c.change, to: `manager-of:${c.subject}` }) });
                    if (!r.ok)
                        throw new Error(`sink answered ${r.status}`);
                });
                if (f)
                    failed.push(f);
            }
            if (this.d.provisionTargetUrl) {
                const f = await this.once('provision', e, c, async (key) => {
                    const base = assertLoopback(this.d.provisionTargetUrl);
                    const r = await fetch(new URL(`/Users/${encodeURIComponent(c.subject)}/Roles/${encodeURIComponent(c.role)}`, base), { method: c.change === 'granted' ? 'PUT' : 'DELETE', headers: { 'idempotency-key': key, 'x-tenant': e.tenant }, signal: AbortSignal.timeout(t) });
                    if (!r.ok)
                        throw new Error(`target answered ${r.status}`);
                });
                if (f)
                    failed.push(f);
            }
        }
        if (failed.length)
            throw new Error(`effects failed: ${failed.join('; ')}`);
        return { changes: changes.length, failed };
    }
}
