// Authenticator (TOTP) profile component, packaged with the plugin. Surfaces:
//   self: the person enrolls (secret shown once), confirms with a code, or removes their authenticator.
//   admin: status per user + revoke. An administrator NEVER enrolls a TOTP for someone else (the secret must
//          only ever be seen by the person): there is no enroll button on this surface.
// Context: { tenant, api, token, adminToken, branch, surface, subject?, mode: 'manage' | 'readonly' }
// mode 'readonly': status only, no mutating control (the server checks every call again).

const css = `
:host{color:var(--ink)}
.tpf{font:inherit}.tpf .row{display:flex;gap:.5em;align-items:center;flex-wrap:wrap;margin:.4em 0}
.tpf button{cursor:pointer;border:1px solid var(--field-line);background:transparent;color:inherit;border-radius:6px;padding:.5em 1em;font:inherit;min-height:44px;min-width:44px}
.tpf button.danger{border-color:var(--bad);color:var(--bad)}
.tpf input{font:inherit;padding:.5em;max-width:10em;min-height:44px;box-sizing:border-box;background:var(--field-bg);color:inherit;border:1px solid var(--field-line);border-radius:6px}
.tpf .msg{font-size:.9em;padding:.3em .6em;border-radius:4px}.tpf .bad{background:var(--bad-soft);color:var(--bad-ink)}.tpf .ok{background:var(--ok-soft);color:var(--ok)}
.tpf .hint{color:var(--label);font-size:.85em;max-width:36em}
.tpf code.secret{display:inline-block;font-size:1.05em;letter-spacing:.08em;background:var(--code-bg);border:1px solid var(--line);border-radius:6px;padding:.4em .7em;margin:.3em 0;user-select:all}
.tpf .status{display:inline-block;border-radius:999px;padding:.15em .7em;font-size:.85em}
.tpf .on{background:var(--ok-soft);color:var(--ok)}.tpf .off{background:var(--code-bg);color:var(--muted)}
.tpf .immediate{color:var(--warn-ink);background:var(--warn-soft);border:1px solid var(--warn-line);border-radius:6px;padding:.4em .7em;font-size:.85em;margin:.5em 0}
`;

/** Text/attribute escaping: instance names, the fresh enrollment and server messages land in innerHTML. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class TotpProfile extends HTMLElement {
  connectedCallback() {
    this._ctx = this.context ?? { api: '', token: '', surface: 'self' };
    this._insts = []; this._status = {}; this._fresh = null; this._confirm = null;
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
    this._loaded = true; // an answer came back: stop showing Loading
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
    this._insts = (r.data.methods ?? []).filter((m) => m.type === 'totp');
    if (admin && !this._insts.length) {
      // The admin status endpoint does not list methods: fetch them from the shared auth configuration.
      const cfg = await this.call('GET', '/auth', undefined, true);
      if (!this.fail(cfg)) this._insts = (cfg.data.working?.config?.methods ?? cfg.data.live?.config?.methods ?? []).filter((m) => m.type === 'totp' && m.enabled).map((m) => ({ id: m.id, name: m.name }));
    }
    this._loaded = true; this.render();
  }
  async enroll(inst) {
    const r = await this.call('POST', `/auth/me/enrollments/${encodeURIComponent(inst)}/totp`);
    if (this.fail(r)) return;
    this._fresh = { inst, secret: r.data.shownOnce.secret, uri: r.data.shownOnce.otpauthUri };
    this.say('', ''); await this.load();
  }
  async confirm(inst, code) {
    const r = await this.call('POST', `/auth/me/enrollments/${encodeURIComponent(inst)}/totp/confirm`, { code });
    if (this.fail(r)) return;
    this._fresh = null; this.say('Authenticator confirmed.', '');
  }
  async remove(inst, admin) {
    const r = admin ? await this.call('DELETE', `/auth/enrollments/${encodeURIComponent(this._ctx.subject)}/${encodeURIComponent(inst)}`, undefined, true)
                    : await this.call('DELETE', `/auth/me/enrollments/${encodeURIComponent(inst)}`);
    if (this.fail(r)) return;
    this._fresh = null; this._confirm = null; this.say(admin ? 'Enrollment revoked.' : 'Authenticator removed.', ''); await this.load();
  }
  render() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const admin = this._ctx.surface === 'admin';
    const ro = this._ctx.mode === 'readonly';
    const root = this.shadowRoot;
    const rows = this._insts.map((m) => {
      const on = !!this._status[m.id]?.totp;
      const confirming = !ro && this._confirm === m.id;
      return `<div class="row" data-inst="${esc(m.id)}">
        <b>${esc(m.name ?? m.id)}</b> <span class="status ${on ? 'on' : 'off'}">${on ? 'Enrolled' : 'Not enrolled'}</span>
        ${!ro && !admin && !on && !confirming ? `<button class="enroll">Set up an authenticator…</button>` : ''}
        ${!ro && on && !confirming ? `<button class="remove danger">${admin ? 'Revoke' : 'Remove'}</button>` : ''}
        ${confirming ? `<span class="hint">Really ${admin ? 'revoke this enrollment' : 'remove this authenticator'}? This takes effect immediately.</span>
          <button class="confirm-remove danger">Confirm</button><button class="cancel-remove">Cancel</button>` : ''}
      </div>`;
    }).join('');
    root.innerHTML = `<style>${css}</style><div class="tpf">
      ${!this._loaded ? '<p class="hint">Loading...</p>' : rows || '<p class="hint">No authenticator method is enabled in the sign-in configuration.</p>'}
      ${admin ? '<p class="hint">An administrator can see and revoke an enrollment, never create one: the secret must only ever be seen by the person.</p>' : ''}
      ${admin && !ro ? '<p class="immediate">Changes here take effect immediately. Save user and Cancel do not undo them.</p>' : ''}
      ${!ro && this._fresh ? `<div class="row" style="flex-direction:column;align-items:flex-start">
          <span class="hint">Add this key to the authenticator app of <b>${esc(this._fresh.inst)}</b> (shown once):</span>
          <code class="secret">${esc(this._fresh.secret)}</code>
          <span class="hint">or URI: <code>${esc(this._fresh.uri)}</code></span>
          <span class="row"><input id="code" inputmode="numeric" placeholder="Code from the app" aria-label="Code from the app"><button class="confirm">Confirm</button></span>
        </div>` : ''}
      ${this._note ? `<p class="msg ok">${esc(this._note)}</p>` : ''}
      ${this._problem ? `<p class="msg bad">${esc(this._problem)}</p>` : ''}
    </div>`;
    root.querySelectorAll('.row[data-inst]').forEach((row) => {
      const inst = row.getAttribute('data-inst');
      row.querySelector('.enroll')?.addEventListener('click', () => void this.enroll(inst));
      row.querySelector('.remove')?.addEventListener('click', () => { this._confirm = inst; this.render(); });
      row.querySelector('.cancel-remove')?.addEventListener('click', () => { this._confirm = null; this.render(); });
      row.querySelector('.confirm-remove')?.addEventListener('click', () => void this.remove(inst, admin));
    });
    const cf = root.querySelector('.confirm');
    if (cf) cf.onclick = () => void this.confirm(this._fresh.inst, root.querySelector('#code')?.value ?? '');
  }
}
if (!customElements.get('iam-totp-profile')) customElements.define('iam-totp-profile', TotpProfile);
export default 'iam-totp-profile';
