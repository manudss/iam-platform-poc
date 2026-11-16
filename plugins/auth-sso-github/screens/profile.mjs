/**
 * Profile component of auth-sso-github (docs/sso-federation.md): a signed-in person links their GitHub sign-in to
 * their account through a REAL provider round-trip (or the marked simulated chooser when no client id is
 * configured), and unlinks it. Admin surface: status and revoke only - an administrator never links for someone
 * else (the link must come from the person's own authenticated session and their own provider login).
 * Context: { tenant, api, token, adminToken, branch, surface, subject?, mode: 'manage' | 'readonly' }.
 * mode 'readonly': status only, no mutating control (the server checks every call again).
 */
const TYPE = 'sso-github';
const css = `
:host{color:var(--ink)}
.spf{font:inherit}.spf .row{display:flex;gap:.5em;align-items:center;flex-wrap:wrap;margin:.4em 0}
.spf button{cursor:pointer;border:1px solid var(--field-line);background:transparent;color:inherit;border-radius:6px;padding:.5em 1em;font:inherit;min-height:44px;min-width:44px}
.spf button.danger{border-color:var(--bad);color:var(--bad)}
.spf .msg{font-size:.9em;padding:.3em .6em;border-radius:4px}.spf .bad{background:var(--bad-soft);color:var(--bad-ink)}.spf .ok{background:var(--ok-soft);color:var(--ok)}
.spf .hint{overflow-wrap:anywhere;color:var(--label);font-size:.85em;max-width:36em}
.spf .status{display:inline-block;border-radius:999px;padding:.15em .7em;font-size:.85em}
.spf .on{background:var(--ok-soft);color:var(--ok)}.spf .off{background:var(--code-bg);color:var(--muted)}
.spf .demo{color:var(--warn-ink);background:var(--warn-soft);border:1px solid var(--warn-line);border-radius:6px;padding:.4em .7em;font-size:.85em;margin:.5em 0}
.spf .immediate{color:var(--warn-ink);background:var(--warn-soft);border:1px solid var(--warn-line);border-radius:6px;padding:.4em .7em;font-size:.85em;margin:.5em 0}
.spf .chooser .idbtn{display:block;margin:.3em 0;min-width:16em;text-align:left}
`;
/** Text/attribute escaping: instance names, provider subjects and server messages land in innerHTML. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => { if (!iso) return 'never'; const d = new Date(iso); return Number.isNaN(+d) ? 'never' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };

class SsoProfile extends HTMLElement {
  connectedCallback() {
    this._ctx = this.context ?? { api: '', token: '', surface: 'self' };
    this._insts = []; this._status = {}; this._chooser = null; this._confirm = null;
    this.render(); void this.load();
  }
  h(admin) {
    const c = this._ctx, r = { 'content-type': 'application/json', authorization: `Bearer ${c.token}` };
    if (admin && c.adminToken) r['x-api-admin-token'] = c.adminToken;
    if (c.branch) r['x-iam-branch'] = c.branch;
    return r;
  }
  async call(method, path, body, admin) {
    const r = await fetch(`${this._ctx.api}${path}`, { method, headers: this.h(admin), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }
  fail(r) {
    if (r.status < 400) return false;
    this._loaded = true;
    this.say('', Array.isArray(r.data.message) ? r.data.message.join(' ') : (r.data.message ?? 'Refused'));
    return true;
  }
  say(note, problem) { this._note = note; this._problem = problem; this.render(); }
  async load() {
    const admin = this._ctx.surface === 'admin';
    const r = admin ? await this.call('GET', `/auth/enrollments/${encodeURIComponent(this._ctx.subject)}`, undefined, true)
                    : await this.call('GET', '/auth/me/enrollments');
    if (this.fail(r)) return;
    this._status = r.data.enrollments ?? {};
    this._insts = (r.data.methods ?? []).filter((m) => m.type === TYPE);
    if (admin && !this._insts.length) {
      const cfg = await this.call('GET', '/auth', undefined, true);
      if (!this.fail(cfg)) this._insts = (cfg.data.working?.config?.methods ?? cfg.data.live?.config?.methods ?? []).filter((m) => m.type === TYPE && m.enabled).map((m) => ({ id: m.id, name: m.name }));
    }
    this._loaded = true; this.render();
  }
  /** Link leg 1: the server binds the round-trip to THIS member; a real provider takes the browser with it. */
  async link(inst) {
    const returnTo = typeof location !== 'undefined' ? location.origin + location.pathname : undefined;
    const r = await this.call('POST', `/auth/me/external-links/${encodeURIComponent(inst)}`, returnTo ? { returnTo } : {});
    if (this.fail(r)) return;
    if (r.data.mode === 'redirect' && typeof r.data.url === 'string') { window.location.assign(r.data.url); return; }
    if (r.data.mode === 'simulated') { this._chooser = { inst, state: r.data.state, title: r.data.title, identities: r.data.identities ?? [] }; this.say('', ''); return; }
    this.say('', 'Unexpected answer from the server.');
  }
  /** Simulated leg 2: the person picked one of the fictional identities. */
  async pick(sub) {
    const c = this._chooser; if (!c) return;
    const r = await this.call('POST', `/auth/me/external-links/${encodeURIComponent(c.inst)}/complete`, { state: c.state, sim: sub });
    if (this.fail(r)) return;
    this._chooser = null;
    this.say(r.data.simulated ? 'Linked (SIMULATED provider: the identity proof is fictional, the link itself is real).' : 'Provider linked.', '');
    await this.load();
  }
  async unlink(inst, admin) {
    const r = admin ? await this.call('DELETE', `/auth/enrollments/${encodeURIComponent(this._ctx.subject)}/${encodeURIComponent(inst)}`, undefined, true)
                    : await this.call('DELETE', `/auth/me/enrollments/${encodeURIComponent(inst)}`);
    if (this.fail(r)) return;
    this._confirm = null; this.say(admin ? 'Link revoked.' : 'Provider unlinked.', ''); await this.load();
  }
  render() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const admin = this._ctx.surface === 'admin';
    const ro = this._ctx.mode === 'readonly';
    const root = this.shadowRoot;
    const rows = this._insts.map((m) => {
      const st = this._status[m.id];
      const link = st?.external;
      const on = !!link?.sub;
      const confirming = !ro && this._confirm === m.id;
      return `<div class="row" data-inst="${esc(m.id)}">
        <b>${esc(m.name ?? m.id)}</b> <span class="status ${on ? 'on' : 'off'}">${on ? 'Linked' : 'Not linked'}</span>
        ${on ? `<span class="hint">linked on ${esc(fmtDate(link.linkedAt))}${link.email ? ` · ${esc(link.email)}` : ''}</span>` : ''}
        ${!ro && !admin && !on && !confirming ? `<button class="link">Link ${esc(m.name ?? 'provider')}…</button>` : ''}
        ${!ro && on && !confirming ? `<button class="remove danger">${admin ? 'Revoke' : 'Unlink'}</button>` : ''}
        ${confirming ? `<span class="hint">Really ${admin ? 'revoke this link' : 'unlink this provider'}? Sign-in with it stops working at once.</span>
          <button class="confirm-remove danger">Confirm</button><button class="cancel-remove">Cancel</button>` : ''}
      </div>`;
    }).join('');
    const chooser = !admin && !ro && this._chooser ? `<div class="chooser">
      <p class="demo">DEMO: simulated provider. No real account is contacted; these identities are fictional.</p>
      <p><b>${esc(this._chooser.title)}</b></p>
      ${this._chooser.identities.map((i) => `<button class="idbtn" data-sub="${esc(i.sub)}">${esc(i.label)}</button>`).join('')}
      <button class="cancel-chooser">Cancel</button>
    </div>` : '';
    root.innerHTML = `<style>${css}</style><div class="spf">
      ${!this._loaded ? '<p class="hint">Loading...</p>' : rows || '<p class="hint">No GitHub sign-in method is enabled in the sign-in configuration.</p>'}
      ${admin ? '<p class="hint">An administrator can see and revoke a link, never create one: linking needs the person\'s own sign-in and their own provider login.</p>' : ''}
      ${admin && !ro ? '<p class="immediate">Changes here take effect immediately. Save user and Cancel do not undo them.</p>' : ''}
      ${chooser}
      ${this._note ? `<p class="msg ok">${esc(this._note)}</p>` : ''}
      ${this._problem ? `<p class="msg bad">${esc(this._problem)}</p>` : ''}
    </div>`;
    root.querySelectorAll('.row[data-inst]').forEach((row) => {
      const inst = row.getAttribute('data-inst');
      row.querySelector('.link')?.addEventListener('click', () => void this.link(inst));
      row.querySelector('.remove')?.addEventListener('click', () => { this._confirm = inst; this.render(); });
      row.querySelector('.cancel-remove')?.addEventListener('click', () => { this._confirm = null; this.render(); });
      row.querySelector('.confirm-remove')?.addEventListener('click', () => void this.unlink(inst, admin));
    });
    root.querySelectorAll('.chooser .idbtn').forEach((b) => b.addEventListener('click', () => void this.pick(b.getAttribute('data-sub'))));
    root.querySelector('.cancel-chooser')?.addEventListener('click', () => { this._chooser = null; this.render(); });
  }
}
const tag = 'iam-sso-github-profile';
if (!customElements.get(tag)) customElements.define(tag, SsoProfile);
export default tag;
